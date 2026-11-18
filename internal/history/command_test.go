package history

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestASlashCommandIsTheTurnsPrompt(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>"}}`,
		`{"type":"user","timestamp":"2026-10-01T10:00:00Z","message":{"content":"<command-message>work</command-message>\n<command-name>/work</command-name>\n<command-args>fix the parser\n\n[started by session \"Focus\" (5cbd710f on box) · handed off to you: no need to report back]</command-args>"}}`,
		`{"type":"user","isMeta":true,"timestamp":"2026-10-01T10:00:00Z","message":{"content":[{"type":"text","text":"the skill's instructions"}]}}`,
		`{"type":"assistant","timestamp":"2026-10-01T10:00:01Z","message":{"id":"m1","content":[{"type":"text","text":"On it."}]}}`,
	}
	path := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	p, err := ReadPage(path, 0, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	m := p.Messages
	if len(m) != 2 || m[0].Role != "user" || m[0].Text != "/work fix the parser" || m[0].Via == nil {
		t.Fatalf("messages %+v", m)
	}
	turns := BuildTurns(m, make([]int64, len(m)), 1, nil)
	if len(turns) != 1 || turns[0].Partial || turns[0].Prompt != "/work fix the parser" || turns[0].Reply != "On it." {
		t.Fatalf("turns %+v", turns)
	}
}
