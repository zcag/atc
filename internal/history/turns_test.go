package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func bash(cmd, out string, failed bool) Message {
	in, _ := json.Marshal(map[string]string{"command": cmd})
	return Message{Role: "tool", Tool: "Bash", Input: in, Out: &Output{Text: out, Error: failed}}
}

func TestClassifyCommands(t *testing.T) {
	cases := []struct {
		m    Message
		kind string
		ok   bool
		text string
		look bool
	}{
		{bash(`git commit -qm "x"`, "[master 1ca5dce] Transcript as a reading view", false), "commit", true, "Transcript as a reading view", false},
		{bash("git push -q origin HEAD:master", "To github.com:zcag/atc.git\n   fc204dd..1ca5dce  HEAD -> master", false), "push", true, "Pushed to master", false},
		{bash("go test ./...", "ok  \tgithub.com/zcag/atc/internal/history\t0.004s", false), "test", true, "Tests passed", false},
		{bash("go test ./internal/history", "--- FAIL: TestReadPage (0.00s)\nFAIL", true), "test", false, "Tests failed", false},
		{bash("make install 2>&1 | tail -4", "", false), "deploy", true, "Deployed", false},
		{bash("publish-cmd out/x.html", "http://pages.example/x.html", false), "publish", true, "Published", false},
		{bash("grep -n foo internal/*.go | head; sed -n 1,20p main.go", "", false), "", false, "", true},
		{bash("cd /tmp && ls -la && git log --oneline -3", "", false), "", false, "", true},
		{bash("sed -i 's/a/b/' x.go", "", false), "", false, "", false},
		{bash("echo hi > out.txt", "", false), "", false, "", false},
	}
	for _, c := range cases {
		b, look := classify(c.m)
		var in struct{ Command string }
		json.Unmarshal(c.m.Input, &in)
		if look != c.look {
			t.Errorf("%q: look %v, want %v", in.Command, look, c.look)
		}
		if c.kind == "" {
			if b != nil {
				t.Errorf("%q: unexpected badge %+v", in.Command, b)
			}
			continue
		}
		if b == nil || b.Kind != c.kind || b.OK != c.ok || b.Text != c.text {
			t.Errorf("%q: badge %+v, want %s %v %q", in.Command, b, c.kind, c.ok, c.text)
		}
	}
}

func TestTurnsIndexAndGrow(t *testing.T) {
	lines := []string{
		`{"type":"assistant","timestamp":"2026-10-01T09:59:00Z","message":{"id":"m0","content":[{"type":"text","text":"tail of an earlier turn"}]}}`,
		`{"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"fix it"}}`,
		`{"type":"assistant","timestamp":"2026-10-01T10:00:01Z","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/a.go","old_string":"a\nb","new_string":"c"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
		`{"type":"assistant","timestamp":"2026-10-01T10:00:02Z","message":{"id":"m2","content":[{"type":"text","text":"Fixed."}]}}`,
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	x := New(dir)
	turns, _, err := x.Turns(path)
	if err != nil || len(turns) != 2 {
		t.Fatalf("turns %d err %v", len(turns), err)
	}
	if !turns[0].Partial || turns[1].Prompt != "fix it" || turns[1].Reply != "Fixed." || turns[1].Steps != 1 {
		t.Fatalf("unexpected %+v", turns)
	}
	if f := turns[1].Files; len(f) != 1 || f[0].Add != 1 || f[0].Del != 2 {
		t.Fatalf("files %+v", f)
	}
	p, _ := ReadRange(path, turns[1].From, turns[1].To)
	if len(p.Messages) != 3 || p.Messages[0].Role != "user" {
		t.Fatalf("range %+v", p.Messages)
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"user","timestamp":"2026-10-01T10:05:00Z","message":{"content":"and test it"}}` + "\n" + `{"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"Done."}]}}`)
	f.Close()
	turns, _, _ = x.Turns(path)
	if len(turns) != 3 || turns[2].Prompt != "and test it" || turns[2].Reply != "" {
		t.Fatalf("after growing, a half-written last line must wait: %+v", turns)
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("\n")
	f.Close()
	if turns, _, _ = x.Turns(path); turns[2].Reply != "Done." || turns[1].Reply != "Fixed." {
		t.Fatalf("after the line completes: %+v", turns)
	}
}

func TestMidTurnMessagesBelongToTheTurn(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"fix it"}}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"attachment","timestamp":"2026-10-01T10:00:05Z","attachment":{"type":"queued_command","prompt":"also check the tests"}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a.go"}]}}`,
		`{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Done, tests too."}]}}`,
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	turns, _, _ := New(dir).Turns(path)
	if len(turns) != 1 || len(turns[0].Notes) != 1 || turns[0].Notes[0] != "also check the tests" || turns[0].Reply != "Done, tests too." {
		t.Fatalf("a message sent mid-turn should stay in its turn: %+v", turns)
	}
}
