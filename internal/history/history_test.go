package history

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestUnpaste(t *testing.T) {
	in := "\n\n<pasted_content id=\"bf9e\">\nhello\nworld\n</pasted_content id=\"bf9e\">\n"
	if got := strings.TrimSpace(unpaste(in)); got != "hello\nworld" {
		t.Fatalf("got %q", got)
	}
}

func TestSummarizeQuestionAndPlan(t *testing.T) {
	q := `{"questions":[{"question":"Which version do we cut?","options":[{"label":"2.4"},{"label":"2.5"}]},{"question":"later"}]}`
	if got := Detail([]byte(q)); got != "Which version do we cut? (2.4 · 2.5)" {
		t.Fatalf("question: %q", got)
	}
	if got := Detail([]byte(`{"plan":"\n# Rewrite search\n\n1. Index"}`)); got != "Rewrite search" {
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
	if want := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC); !tr.Updated.Equal(want) {
		t.Fatalf("updated %v, want the last timestamped entry %v, not the file's mtime", tr.Updated, want)
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

func TestReadPageAttachesResultsAndTurns(t *testing.T) {
	long := strings.Repeat("x\n", 300)
	lines := []string{
		`{"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"fix it"}}`,
		`{"type":"assistant","timestamp":"2026-10-01T10:00:01Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":3,"output_tokens":7},"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/a.go","content":` + strconv.Quote(long) + `}}]}}`,
		`{"type":"assistant","timestamp":"2026-10-01T10:00:01Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":3,"output_tokens":7},"content":[{"type":"tool_use","id":"t2","name":"AskUserQuestion","input":{"questions":[{"question":"Which?"}]}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":true}]}}`,
		`{"type":"user","toolUseResult":{"answers":{"Which?":"that one"}},"message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"answered"}]}}`,
		`{"type":"user","message":{"content":"<task-notification><summary>Build finished</summary></task-notification>"}}`,
		`{"type":"system","subtype":"turn_duration","durationMs":4200}`,
	}
	path := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	p, err := ReadPage(path, 0, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, m := range p.Messages {
		roles = append(roles, m.Role)
	}
	if got := strings.Join(roles, " "); got != "user assistant tool tool event done" {
		t.Fatalf("roles %q", got)
	}
	m := p.Messages
	if m[1].Usage == nil || m[1].Usage.Output != 7 || m[3].Usage != nil {
		t.Fatalf("usage belongs on the first block of a message only: %+v %+v", m[1].Usage, m[3].Usage)
	}
	if m[2].Out == nil || !m[2].Out.Error || m[2].Out.Text != "ok" {
		t.Fatalf("write result %+v", m[2].Out)
	}
	if !strings.Contains(string(m[2].Input), `"_cut":{"content":61}`) {
		t.Fatalf("long input not clipped: %.80s", m[2].Input)
	}
	if a, _ := m[3].Out.Meta["answers"].(map[string]string); a["Which?"] != "that one" {
		t.Fatalf("answers %+v", m[3].Out.Meta)
	}
	if m[4].Text != "Build finished" || m[5].Ms != 4200 {
		t.Fatalf("event %q, done %d", m[4].Text, m[5].Ms)
	}
}

func TestReadPageShowsFilesSentToTheUser(t *testing.T) {
	dir := t.TempDir()
	img, doc := filepath.Join(dir, "shot.png"), filepath.Join(dir, "report.pdf")
	os.WriteFile(img, []byte("png"), 0o644)
	os.WriteFile(doc, []byte("pdf"), 0o644)
	lines := []string{
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"SendUserFile","input":{"files":["` + img + `","` + doc + `"],"caption":"look"}}]}}`,
		`{"type":"user","toolUseResult":{"caption":"look","attachments":[{"path":"` + img + `","isImage":true,"media_type":"image/png"},{"path":"` + doc + `","isImage":false}]},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"2 files delivered to user."}]}}`,
	}
	path := filepath.Join(dir, "s.jsonl")
	os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	p, err := ReadPage(path, 0, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	o := p.Messages[0].Out
	if len(o.Images) != 1 || o.Images[0] != "data:image/png;base64,cG5n" {
		t.Fatalf("images %v", o.Images)
	}
	if s, _ := o.Meta["sent"].(map[string]any); s["caption"] != "look" || fmt.Sprint(s["files"]) != "["+doc+"]" {
		t.Fatalf("sent %+v", o.Meta)
	}
}

func TestFindFallsBackToTheForkedConversation(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "-home-u")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "old.jsonl"), []byte(`{"type":"user","cwd":"/home/u","timestamp":"2026-10-01T10:00:00Z","message":{"content":"hi"}}`+"\n"), 0o644)
	x := New(root)
	if _, ok := x.Find("new"); ok {
		t.Fatal("found a transcript for a session that has none")
	}
	x.Forks = func() map[string]string { return map[string]string{"new": "old"} }
	if tr, ok := x.Find("new"); !ok || tr.SessionID != "old" {
		t.Fatalf("got %+v %v", tr, ok)
	}
	if r := x.Resumed(); !r["old"] || r["new"] {
		t.Fatalf("resumed %v", r)
	}
}

func TestTalkModeIsNotPartOfThePrompt(t *testing.T) {
	in := "[talk-mode: whatsapp, until the next talk-mode line]\n# talk-mode: whatsapp\n\n- rules\n[message]\nhello"
	if got := unpaste(in); got != "hello" {
		t.Fatalf("got %q", got)
	}
}
