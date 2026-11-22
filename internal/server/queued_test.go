package server

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/zcag/atc/internal/history"
)

func TestAskingUserIgnoresATurnEndApproveLine(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	os.MkdirAll(filepath.Join(dir, "jobs", "job00001"), 0o755)
	os.WriteFile(filepath.Join(dir, "jobs", "job00001", "state.json"), []byte(`{"tempo":"blocked","sessionId":"s1","needs":"approve the alarm rule change, and say which way"}`), 0o644)
	if AskingUser(history.New(t.TempDir()))("job00001") {
		t.Error("a needs line written at the end of a turn, with no tool call waiting, holds no one's Enter")
	}
}
