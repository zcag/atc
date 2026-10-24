package opencode

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/outputs"
)

const Harness = "opencode"

var tools = map[string]string{
	"bash": "Bash", "read": "Read", "write": "Write", "edit": "Edit", "multiedit": "MultiEdit", "patch": "Edit", "apply_patch": "Edit",
	"glob": "Glob", "grep": "Grep", "list": "LS", "webfetch": "WebFetch", "websearch": "WebSearch", "codesearch": "WebSearch",
	"todowrite": "TodoWrite", "todoread": "TodoRead", "task": "Task", "question": "AskUserQuestion", "skill": "Skill",
}

func toolName(t string) string {
	if n, ok := tools[t]; ok {
		return n
	}
	return t
}

func detail(raw json.RawMessage) string { return history.Detail(raw) }

func at(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

func (m Message) model() string {
	p, id := m.Info.ProviderID, m.Info.ModelID
	if id == "" {
		p, id = m.Info.Model.ProviderID, m.Info.Model.ModelID
	}
	if id == "" {
		return ""
	}
	return p + "/" + id
}

func (m Message) prompt() string {
	var texts []string
	for _, p := range m.Parts {
		if p.Type == "text" && !p.Synthetic && !p.Ignored && strings.TrimSpace(p.Text) != "" && !history.IsNoise(p.Text) {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, "\n\n")
}

func (m Message) reply() string {
	var texts []string
	for _, p := range m.Parts {
		if p.Type == "text" && strings.TrimSpace(p.Text) != "" {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, "\n\n")
}

func Transcript(s Session, msgs []Message) history.Transcript {
	t := history.Transcript{SessionID: s.ID, Harness: Harness, Cwd: s.Directory, StartCwd: s.Directory, Title: s.Title, Updated: at(s.Time.Updated)}
	if s.Model.ID != "" {
		t.Model = s.Model.ProviderID + "/" + s.Model.ID
	}
	for _, m := range msgs {
		switch m.Info.Role {
		case "user":
			if text := m.prompt(); text != "" {
				t.LastPrompt, t.PromptAt, t.Activity = strings.TrimSpace(text), at(m.Info.Time.Created), ""
			}
		case "assistant":
			if mod := m.model(); mod != "" {
				t.Model = mod
			}
			if tok := m.Info.Tokens; tok.Input+tok.Cache.Read+tok.Cache.Write > 0 {
				t.Context = tok.Input + tok.Cache.Read + tok.Cache.Write
			}
			for _, p := range m.Parts {
				switch {
				case p.Type == "tool":
					t.Activity = strings.TrimSpace(toolName(p.Tool) + "  " + detail(p.State.Input))
				case p.Type == "text" && strings.TrimSpace(p.Text) != "":
					t.Activity, t.LastReply, t.ReplyID = "", oneLine(p.Text, 300), m.Info.ID
				}
			}
		}
	}
	return t
}

func Messages(msgs []Message) []history.Message {
	var out []history.Message
	for _, m := range msgs {
		when := at(m.Info.Time.Created)
		if m.Info.Role == "user" {
			if text := m.prompt(); text != "" {
				out = append(out, history.Message{Role: "user", Text: text, Time: when})
			}
			continue
		}
		for _, p := range m.Parts {
			switch {
			case p.Type == "text" && strings.TrimSpace(p.Text) != "":
				out = append(out, history.Message{Role: "assistant", Text: p.Text, Time: when})
			case p.Type == "tool":
				out = append(out, history.Message{Role: "tool", Tool: toolName(p.Tool), Detail: detail(p.State.Input), Time: cmpTime(at(p.State.Time.Start), when)})
			}
		}
	}
	return out
}

func Reply(msgs []Message, id string) (string, bool) {
	for _, m := range msgs {
		if m.Info.ID == id {
			return m.reply(), true
		}
	}
	return "", false
}

func Steps(msgs []Message) []outputs.Step {
	var out []outputs.Step
	for _, m := range msgs {
		if m.Info.Role != "assistant" {
			continue
		}
		when := at(m.Info.Time.Created)
		for _, p := range m.Parts {
			switch p.Type {
			case "text":
				out = append(out, outputs.Step{At: when, Text: p.Text})
			case "tool":
				var in struct {
					FilePath string `json:"filePath"`
					Command  string `json:"command"`
				}
				json.Unmarshal(p.State.Input, &in)
				out = append(out, outputs.Step{At: cmpTime(at(p.State.Time.Start), when), Tool: toolName(p.Tool), Path: in.FilePath, Command: in.Command, Result: p.State.Output})
			}
		}
	}
	return out
}

func cmpTime(a, b time.Time) time.Time {
	if a.IsZero() {
		return b
	}
	return a
}

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}
