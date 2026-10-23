package history

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSummarizeQuestionAndPlan(t *testing.T) {
	q := `{"questions":[{"question":"Which version do we cut?","options":[{"label":"2.4"},{"label":"2.5"}]},{"question":"later"}]}`
	if got := summarize([]byte(q)); got != "Which version do we cut? (2.4 · 2.5)" {
		t.Fatalf("question: %q", got)
	}
	if got := summarize([]byte(`{"plan":"\n# Rewrite search\n\n1. Index"}`)); got != "Rewrite search" {
		t.Fatalf("plan: %q", got)
	}
}

func TestScanPrefersCustomTitleAndReadsTail(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "-home-u-proj")
	os.MkdirAll(dir, 0o755)
	lines := []string{
		`{"type":"user","cwd":"/home/u/proj","gitBranch":"main","timestamp":"2026-10-01T10:00:00Z"}`,
		`{"type":"assistant","cwd":"/home/u/proj","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":5}}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"go test ./..."}}]}}`,
		`{"type":"ai-title","aiTitle":"Fix the thing"}`,
		`{"type":"last-prompt","lastPrompt":"why does it flip?"}`,
		`{"type":"permission-mode","permissionMode":"bypassPermissions"}`,
		`{"type":"agent-name","agentName":"proj-3"}`,
	}
	os.WriteFile(filepath.Join(dir, "abc.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644)

	x := New(root)
	got := x.Scan()
	if len(got) != 1 {
		t.Fatalf("got %d transcripts", len(got))
	}
	tr := got[0]
	if tr.Title != "Fix the thing" || tr.Cwd != "/home/u/proj" || tr.Branch != "main" ||
		tr.Model != "claude-opus-5-5" || tr.Context != 1015 || tr.LastPrompt != "why does it flip?" ||
		tr.StartCwd != "/home/u/proj" || tr.Activity != "Bash  go test ./..." || tr.Pending != "Bash  go test ./..." || tr.LastReply != "Looking." || tr.PermissionMode != "bypassPermissions" || tr.AgentName != "proj-3" || tr.SessionID != "abc" {
		t.Fatalf("unexpected %+v", tr)
	}

	f, _ := os.OpenFile(filepath.Join(dir, "abc.jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"custom-title","customTitle":"renamed"}` + "\n")
	f.Close()
	if got := x.Scan(); got[0].Title != "renamed" {
		t.Fatalf("custom title not picked up after append: %q", got[0].Title)
	}

	f, _ = os.OpenFile(filepath.Join(dir, "abc.jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}` + "\n")
	f.Close()
	if got := x.Scan(); got[0].Pending != "" {
		t.Fatalf("tool result should clear pending: %q", got[0].Pending)
	}
}
