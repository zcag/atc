package history

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

type Message struct {
	Role   string    `json:"role"`
	Text   string    `json:"text,omitempty"`
	Tool   string    `json:"tool,omitempty"`
	Detail string    `json:"detail,omitempty"`
	Time   time.Time `json:"time,omitzero"`
}

type Page struct {
	Messages []Message `json:"messages"`
	Start    int64     `json:"start"`
	Size     int64     `json:"size"`
}

type rawMsg struct {
	Type        string    `json:"type"`
	IsMeta      bool      `json:"isMeta"`
	IsSidechain bool      `json:"isSidechain"`
	Timestamp   time.Time `json:"timestamp"`
	Message     struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	ID        string          `json:"id"`
	ToolUseID string          `json:"tool_use_id"`
	Input     json.RawMessage `json:"input"`
}

func (x *Index) Find(sid string) (Transcript, bool) {
	for _, t := range x.Scan() {
		if t.SessionID == sid {
			return t, true
		}
	}
	return Transcript{}, false
}

func ReadPage(path string, before, window int64) (Page, error) {
	f, err := os.Open(path)
	if err != nil {
		return Page{}, err
	}
	defer f.Close()
	st, _ := f.Stat()
	p := Page{Size: st.Size()}
	if before <= 0 || before > p.Size {
		before = p.Size
	}
	p.Start = max(0, before-window)
	f.Seek(p.Start, io.SeekStart)
	r := bufio.NewReaderSize(io.LimitReader(f, before-p.Start), 1<<20)
	if p.Start > 0 {
		skipped, _ := r.ReadBytes('\n')
		p.Start += int64(len(skipped))
	}
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 1 {
			var m rawMsg
			if json.Unmarshal(line, &m) == nil && !m.IsMeta && !m.IsSidechain {
				p.Messages = append(p.Messages, convert(m)...)
			}
		}
		if err != nil {
			break
		}
	}
	return p, nil
}

func convert(m rawMsg) []Message {
	if m.Type != "user" && m.Type != "assistant" {
		return nil
	}
	var blocks []block
	var s string
	if json.Unmarshal(m.Message.Content, &s) == nil {
		blocks = []block{{Type: "text", Text: s}}
	} else if json.Unmarshal(m.Message.Content, &blocks) != nil {
		return nil
	}
	var out []Message
	for _, b := range blocks {
		switch {
		case b.Type == "text" && strings.TrimSpace(b.Text) != "":
			if m.Type == "user" && IsNoise(b.Text) {
				continue
			}
			out = append(out, Message{Role: m.Type, Text: b.Text, Time: m.Timestamp})
		case b.Type == "tool_use":
			out = append(out, Message{Role: "tool", Tool: b.Name, Detail: summarize(b.Input), Time: m.Timestamp})
		}
	}
	return out
}

func IsNoise(t string) bool {
	t = strings.TrimSpace(t)
	for _, p := range []string{"<system-reminder>", "<local-command", "<command-name>", "<command-message>", "<task-notification>", "Caveat:", "[Request interrupted"} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

func summarize(raw json.RawMessage) string {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil {
		return ""
	}
	if qs, ok := in["questions"].([]any); ok && len(qs) > 0 {
		if q, ok := qs[0].(map[string]any); ok {
			var labels []string
			opts, _ := q["options"].([]any)
			for _, o := range opts {
				if m, ok := o.(map[string]any); ok {
					if l, ok := m["label"].(string); ok && l != "" {
						labels = append(labels, l)
					}
				}
			}
			v, _ := q["question"].(string)
			if len(labels) > 0 {
				v += " (" + strings.Join(labels, " · ") + ")"
			}
			return oneLine(v)
		}
	}
	if plan, ok := in["plan"].(string); ok {
		for _, l := range strings.Split(plan, "\n") {
			if l = strings.TrimSpace(strings.TrimLeft(l, "# ")); l != "" {
				return oneLine(l)
			}
		}
	}
	for _, k := range []string{"description", "command", "file_path", "pattern", "url", "query", "prompt", "skill"} {
		if v, ok := in[k].(string); ok && v != "" {
			return oneLine(v)
		}
	}
	return ""
}

func oneLine(v string) string { return clip(strings.Join(strings.Fields(v), " "), 160) }
