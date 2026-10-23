package summary

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zcag/atc/internal/history"
)

func TestParse(t *testing.T) {
	x, err := Parse("Here:\n```json\n{\"status\": \"Plan: **two** PRs\", \"gist\": [\"- parser first\", \"\", \"ui after\"], \"overview\": \"Plan: A\\nOpen: B\"}\n```")
	if err != nil {
		t.Fatal(err)
	}
	if x.Status != "Plan: two PRs" || strings.Join(x.Gist, "|") != "parser first|ui after" || strings.Join(x.Overview, "|") != "Plan: A|Open: B" {
		t.Fatalf("%+v", x)
	}
	if got := clean("## Saved\n\nAll 8 `fixtures` saved, see [the PR](https://x/1)."); got != "Saved All 8 fixtures saved, see the PR." {
		t.Fatalf("clean: %q", got)
	}
	if _, err := Parse(`{"gist": ["x"]}`); err == nil {
		t.Fatal("no status must be an error")
	}
}

func transcript(t *testing.T, reply string) history.Transcript {
	root := t.TempDir()
	dir := filepath.Join(root, "-home-u-proj")
	os.MkdirAll(dir, 0o755)
	lines := []string{
		`{"type":"user","cwd":"/home/u/proj","promptId":"p1","timestamp":"2026-10-01T10:00:00Z","message":{"content":"is the cache the problem?"}}`,
		`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"go test"}}]}}`,
		`{"type":"assistant","uuid":"a2","parentUuid":"a1","message":{"content":[{"type":"text","text":` + quote(reply) + `}]}}`,
		`{"type":"last-prompt","lastPrompt":"is the cache the problem?"}`,
	}
	os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	got := history.New(root).Scan()
	if len(got) != 1 || got[0].ReplyID != "a2" {
		t.Fatalf("final message id: %+v", got)
	}
	return got[0]
}

func quote(s string) string { return `"` + strings.ReplaceAll(s, "\n", `\n`) + `"` }

func TestSummarizesFinalMessageOnce(t *testing.T) {
	long := "Yes, the cache is stale.\n\n" + strings.Repeat("It keeps the old index after a rebuild, so lookups miss. ", 30)
	tr := transcript(t, long)
	calls := 0
	var asked string
	s, err := Open(filepath.Join(t.TempDir(), "summaries.json"), "test", func(ctx context.Context, system, user string) (string, error) {
		calls++
		asked = user
		return `{"status": "Found: stale cache", "gist": ["Rebuild keeps the old index"], "overview": ["Found: stale cache"]}`, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !s.Want(tr) {
		t.Fatal("want should queue")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	x := s.Wait(ctx, tr)
	if x == nil || x.Status != "Found: stale cache" || x.Reply != "a2" || len(x.Overview) != 1 {
		t.Fatalf("summary: %+v", x)
	}
	if !strings.Contains(asked, "is the cache the problem?") || !strings.Contains(asked, "Yes, the cache is stale.") || strings.Contains(asked, "Looking.") {
		t.Fatalf("model was asked: %q", asked)
	}
	if s.Want(tr) || calls != 1 {
		t.Fatalf("summarized again: %d calls", calls)
	}
	tr.ReplyID = "a3"
	if s.Get(tr) != nil {
		t.Fatal("a summary of an older message must not show")
	}

	again, _ := Open(s.path, "test", nil)
	tr.ReplyID = "a2"
	if again.Get(tr) == nil {
		t.Fatal("summaries survive a restart")
	}
}

func TestShortReplyNeedsNoModel(t *testing.T) {
	tr := transcript(t, "Done, all green.")
	s, _ := Open(filepath.Join(t.TempDir(), "s.json"), "test", func(context.Context, string, string) (string, error) {
		t.Fatal("model called for a short reply")
		return "", nil
	})
	s.Want(tr)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if x := s.Wait(ctx, tr); x == nil || x.Status != "Done, all green." || x.Model != verbatimModel {
		t.Fatalf("%+v", x)
	}
}

func TestNilSummarizer(t *testing.T) {
	var s *Summarizer
	if s.Get(history.Transcript{ReplyID: "x"}) != nil || s.Want(history.Transcript{ReplyID: "x", Path: "p"}) {
		t.Fatal("off means nothing")
	}
}
