package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
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
		{bash("go test ./... | tail -3", "\x1b[32mok\x1b[0m  \ta\t0.4s\n\x1b[31mFAIL\x1b[0m\tb\t0.1s", false), "test", false, "Tests failed", false},
		{bash("git push", "To github.com:o/r.git\n   ca90a02..018be18  main -> main", false), "push", true, "Pushed to main", false},
		{bash("go test ./... | tail -2", "--- FAIL: TestRoute (0.00s)\n    route_test.go:41: got 500", false), "test", false, "Tests failed", false},
		{bash("make install 2>&1 | tail -4", "", false), "deploy", true, "Deployed", false},
		{bash("atc show out/handover.html --note 'look at the screens'", "Showing \"PR handover\" (handover) in atc, live from ~/out/handover.html.\n", false), "show", true, "PR handover", false},
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

func TestWaitingFollowsTheQueue(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	f, _ := os.Create(path)
	defer f.Close()
	x := New(dir)
	step := func(want []string, lines ...string) {
		t.Helper()
		for _, l := range lines {
			f.WriteString(l + "\n")
		}
		got, err := x.Waiting(path)
		if err != nil {
			t.Fatal(err)
		}
		texts := []string{}
		for _, w := range got {
			texts = append(texts, w.Text)
		}
		if !slices.Equal(texts, want) {
			t.Fatalf("waiting = %q, want %q", texts, want)
		}
	}
	op := func(kind, content string) string {
		b, _ := json.Marshal(map[string]string{"type": "queue-operation", "operation": kind, "content": content, "timestamp": "2026-10-01T10:00:00Z"})
		return string(b)
	}
	notice := "<task-notification><summary>done</summary></task-notification>"
	step([]string{"one"}, op("enqueue", "<pasted_content id=\"1\">\none\n</pasted_content>"))
	step([]string{"one", "two"}, op("enqueue", notice), op("enqueue", "two"))
	step([]string{"two"}, op("remove", "<pasted_content id=\"1\">\none\n</pasted_content>"))
	step([]string{"two"}, `{"type":"user","message":{"content":"mentions \"queue-operation\" in passing"}}`)
	step([]string{}, `{"type":"queue-operation","operation":"dequeue","timestamp":"2026-10-01T10:00:00Z"}`)
	step([]string{"three"}, op("enqueue", "three"))
	step([]string{}, `{"type":"system","subtype":"turn_duration","durationMs":1,"timestamp":"2026-10-01T10:00:00Z"}`)
}

func TestNoticeAfterTheTurnStartsAnother(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"call me"}}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"wait"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"started"}]}}`,
		`{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"## Please call now"}]}}`,
		`{"type":"system","subtype":"turn_duration","durationMs":1000,"timestamp":"2026-10-01T10:00:10Z"}`,
		`{"type":"user","timestamp":"2026-10-01T10:05:00Z","message":{"content":"<task-notification><summary>Background command wait completed</summary></task-notification>"}}`,
		`{"type":"assistant","message":{"id":"m3","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"cat out"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"heard you"}]}}`,
		`{"type":"assistant","message":{"id":"m4","content":[{"type":"text","text":"It worked."}]}}`,
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	os.WriteFile(path, []byte(strings.Join(lines[:7], "\n")+"\n"), 0o644)
	x := New(dir)
	x.Turns(path)
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(strings.Join(lines[7:], "\n") + "\n")
	f.Close()
	turns, _, _ := x.Turns(path)
	if len(turns) != 2 || turns[0].Reply != "## Please call now" || !turns[1].Notice || turns[1].Prompt != "Background command wait completed" || turns[1].Reply != "It worked." {
		t.Fatalf("a notice after the turn ended should open its own turn: %+v", turns)
	}
}

func TestCompactionSummaryIsNotTheUsersMessage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	line := `{"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"This session is being continued from a previous conversation that ran out of context. Summary follows."}}`
	os.WriteFile(path, []byte(line+"\n"), 0o644)
	turns, _, _ := New(dir).Turns(path)
	if len(turns) != 1 || !turns[0].Notice || strings.Contains(turns[0].Prompt, "Summary follows") {
		t.Fatalf("a compaction summary should read as a notice: %+v", turns)
	}
}

func TestPushRange(t *testing.T) {
	for out, want := range map[string]string{
		"To x\n   ca90a02..018be18  main -> main":                 "ca90a02..018be18",
		"To x\n + ca90a02...018be18 main -> main (forced update)": "ca90a02...018be18",
		"To x\n * [new branch]      topic -> topic":               "",
	} {
		b, _ := classify(bash("git push", out, false))
		if b == nil || b.Range != want {
			t.Errorf("%q gave %+v", out, b)
		}
	}
}

func TestClipOutputKeepsBothEnds(t *testing.T) {
	var lines []string
	for i := 1; i <= 200; i++ {
		lines = append(lines, strconv.Itoa(i))
	}
	kept, more, tail := clipOutput(strings.Join(lines, "\n"), 80)
	got := strings.Split(kept, "\n")
	if len(got) != 80 || more != 120 || tail != 40 || got[39] != "40" || got[40] != "161" || got[79] != "200" {
		t.Fatalf("%d lines, more %d, tail %d: %v", len(got), more, tail, got[38:42])
	}
	if kept, more, tail := clipOutput("a\nb", 80); kept != "a\nb" || more != 0 || tail != 0 {
		t.Errorf("short output changed: %q %d %d", kept, more, tail)
	}
}

func TestFailureLateInLongOutputIsSeen(t *testing.T) {
	var b strings.Builder
	for range 300 {
		b.WriteString("ok\n")
	}
	b.WriteString("--- FAIL: TestLate (0.00s)\nFAIL\n")
	text, _, _ := clipOutput(b.String(), maxOutLines)
	got, _ := classify(bash("go test ./...", text, false))
	if got == nil || got.OK || got.Ref != "TestLate" {
		t.Errorf("%+v", got)
	}
}

func TestReplyPreview(t *testing.T) {
	for reply, want := range map[string]string{
		"## A draft\n\nHere is the body:\n\n```markdown\n## Summary\n```\n\nSay go.": "A draft: Here is the body: Say go.",
		"| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.":                                   "Done.",
		"> **Note:** careful\n\n---\n\nnext":                                         "**Note:** careful next",
		"```\nunclosed":                                                              "",
	} {
		if got := replyPreview(reply); got != want {
			t.Errorf("%q gave %q", reply, got)
		}
	}
}
