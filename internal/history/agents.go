package history

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AgentRun is one agent a session started, as its own transcript tells it: what it was asked to be, how far it got,
// what it is doing now and the last it said.
type AgentRun struct {
	Tool    string    `json:"tool"`
	Name    string    `json:"name"`
	Type    string    `json:"type,omitempty"`
	Model   string    `json:"model,omitempty"`
	Done    bool      `json:"done,omitempty"`
	Started time.Time `json:"started,omitzero"`
	Updated time.Time `json:"updated,omitzero"`
	Steps   int       `json:"steps"`
	Last    *Message  `json:"last,omitempty"`
	Said    string    `json:"said,omitempty"`
}

type subagent struct {
	path string
	meta struct {
		ToolUseID   string `json:"toolUseId"`
		Finished    bool   `json:"finished"`
		Description string `json:"description"`
		AgentType   string `json:"agentType"`
		Model       string `json:"pickedEffortModel"`
	}
}

func subagents(transcript string) []subagent {
	metas, _ := filepath.Glob(filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents", "*.meta.json"))
	var out []subagent
	for _, mp := range metas {
		var a subagent
		if b, err := os.ReadFile(mp); err != nil || json.Unmarshal(b, &a.meta) != nil || a.meta.ToolUseID == "" {
			continue
		}
		a.path = strings.TrimSuffix(mp, ".meta.json") + ".jsonl"
		out = append(out, a)
	}
	return out
}

func (a subagent) messages(noImages bool) ([]Message, error) {
	f, err := os.Open(a.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	rd := newReader(noImages)
	rd.sidechain = true
	rd.read(bufio.NewReaderSize(f, 1<<20), 0)
	return rd.msgs, nil
}

var agentRuns = struct {
	sync.Mutex
	by map[string]agentRunAt
}{by: map[string]agentRunAt{}}

type agentRunAt struct {
	size int64
	done bool
	run  AgentRun
}

// Agents is every agent the session in transcript started, each read again only when its transcript grew.
func Agents(transcript string) []AgentRun {
	var out []AgentRun
	for _, a := range subagents(transcript) {
		st, err := os.Stat(a.path)
		if err != nil {
			continue
		}
		agentRuns.Lock()
		got, ok := agentRuns.by[a.path]
		agentRuns.Unlock()
		if !ok || got.size != st.Size() || got.done != a.meta.Finished {
			msgs, err := a.messages(true)
			if err != nil {
				continue
			}
			got = agentRunAt{st.Size(), a.meta.Finished, summarize(a, msgs)}
			agentRuns.Lock()
			agentRuns.by[a.path] = got
			agentRuns.Unlock()
		}
		run := got.run
		run.Updated = st.ModTime()
		out = append(out, run)
	}
	return out
}

func summarize(a subagent, msgs []Message) AgentRun {
	run := AgentRun{Tool: a.meta.ToolUseID, Name: a.meta.Description, Type: a.meta.AgentType, Model: a.meta.Model, Done: a.meta.Finished}
	for i, m := range msgs {
		if run.Started.IsZero() && !m.Time.IsZero() {
			run.Started = m.Time
		}
		switch m.Role {
		case "tool":
			run.Steps++
			last := msgs[i]
			last.Input, last.Out = nil, nil
			run.Last = &last
		case "assistant":
			if t := strings.TrimSpace(m.Text); t != "" {
				run.Said = clip(t, 600)
			}
		}
	}
	return run
}
