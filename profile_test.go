package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/zcag/atc/internal/claude"
)

func TestAddProfile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	base := filepath.Join(home, ".claude")
	os.MkdirAll(filepath.Join(base, "skills"), 0o755)
	os.WriteFile(filepath.Join(base, "CLAUDE.md"), []byte("me"), 0o644)
	os.WriteFile(filepath.Join(base, ".credentials.json"), []byte("secret"), 0o600)
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"mcpServers": {"a": {"command": "x"}}, "oauthAccount": {"emailAddress": "me"}, "projects": {}}`), 0o600)
	work := filepath.Join(home, ".claude-work")
	cfg := filepath.Join(home, "atc", "profiles.json")
	p := claude.Profile{Name: "work", Dir: work, Paths: []string{filepath.Join(home, "co")}}
	if err := addProfile(cfg, claude.DefaultProfile(), p); err != nil {
		t.Fatal(err)
	}
	if l, err := os.Readlink(filepath.Join(work, "CLAUDE.md")); err != nil || l != filepath.Join(base, "CLAUDE.md") {
		t.Errorf("CLAUDE.md: %q %v", l, err)
	}
	if _, err := os.Lstat(filepath.Join(work, ".credentials.json")); err == nil {
		t.Error("shared the sign-in")
	}
	var st map[string]json.RawMessage
	b, _ := os.ReadFile(filepath.Join(work, ".claude.json"))
	json.Unmarshal(b, &st)
	if st["mcpServers"] == nil || st["oauthAccount"] != nil || st["projects"] != nil {
		t.Errorf("state: %s", b)
	}

	os.WriteFile(filepath.Join(work, ".claude.json"), []byte(`{"mcpServers": {"own": {}}, "oauthAccount": {"emailAddress": "co"}}`), 0o600)
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"mcpServers": {"a": {}, "b": {}}}`), 0o600)
	if err := addProfile(cfg, claude.DefaultProfile(), p); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(work, ".claude.json"))
	st = nil
	json.Unmarshal(b, &st)
	var mcp map[string]any
	json.Unmarshal(st["mcpServers"], &mcp)
	if len(mcp) != 3 || st["oauthAccount"] == nil {
		t.Errorf("a second add should bring new servers and keep its own sign-in: %s", b)
	}
	ps, _ := readProfiles(cfg)
	if len(ps) != 1 || ps[0].Name != "work" {
		t.Errorf("profiles: %+v", ps)
	}
	if addProfile(cfg, claude.DefaultProfile(), claude.Profile{Name: "x", Dir: base}) == nil {
		t.Error("made a profile of the default folder")
	}
}
