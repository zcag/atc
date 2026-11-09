package history

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentsSayHowFarEachGot(t *testing.T) {
	dir := t.TempDir()
	tr := filepath.Join(dir, "s.jsonl")
	sub := filepath.Join(dir, "s", "subagents")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(tr, nil, 0o644)
	os.WriteFile(filepath.Join(sub, "agent-a1.meta.json"), []byte(`{"agentType":"general-purpose","description":"Read the docs","toolUseId":"toolu_1","pickedEffortModel":"claude-opus-5-5"}`), 0o644)
	lines := `{"type":"user","isSidechain":true,"timestamp":"2026-11-09T10:00:00Z","message":{"role":"user","content":"read them"}}
{"type":"assistant","isSidechain":true,"timestamp":"2026-11-09T10:00:05Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Reading."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls","description":"List the docs"}}]}}
`
	path := filepath.Join(sub, "agent-a1.jsonl")
	os.WriteFile(path, []byte(lines), 0o644)

	runs := Agents(tr)
	if len(runs) != 1 {
		t.Fatalf("%+v", runs)
	}
	a := runs[0]
	if a.Tool != "toolu_1" || a.Name != "Read the docs" || a.Done || a.Steps != 1 || a.Last == nil || a.Last.Detail != "List the docs" || a.Said != "Reading." || a.Started.IsZero() {
		t.Fatalf("%+v %+v", a, a.Last)
	}

	os.WriteFile(filepath.Join(sub, "agent-a1.meta.json"), []byte(`{"description":"Read the docs","toolUseId":"toolu_1","finished":true}`), 0o644)
	os.WriteFile(path, []byte(lines+`{"type":"assistant","isSidechain":true,"timestamp":"2026-11-09T10:01:00Z","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"Three docs, all current."}]}}
`), 0o644)
	if a := Agents(tr)[0]; !a.Done || a.Said != "Three docs, all current." {
		t.Fatalf("after it finished: %+v", a)
	}
}
