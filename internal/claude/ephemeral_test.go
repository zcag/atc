package claude

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func withPrivate(t *testing.T) (Profile, string) {
	home := t.TempDir()
	mem := filepath.Join(home, "run")
	os.MkdirAll(mem, 0o700)
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("XDG_RUNTIME_DIR", mem)
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"hasCompletedOnboarding": true, "mcpServers": {"mine": {}}}`), 0o600)
	if err := SetProfiles([]Profile{{Name: "work", Dir: "~/.claude-work"}, {Name: "private", Dir: "~/.claude-private", Ephemeral: true}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { SetProfiles(nil) })
	p, _ := ProfileNamed("private")
	if err := p.Init(); err != nil {
		t.Fatal(err)
	}
	return p, home
}

func TestEphemeralLivesInMemory(t *testing.T) {
	p, home := withPrivate(t)
	if want := filepath.Join(home, "run", "atc-private"); p.Home() != want {
		t.Fatalf("home %s, want %s", p.Home(), want)
	}
	if !slices.Contains(p.Paths, p.Scratch()) {
		t.Errorf("paths %v miss the scratch folder", p.Paths)
	}
	if got := ProfileFor(filepath.Join(p.Scratch(), "private-1")).Name; got != "private" {
		t.Errorf("a session in its scratch folder runs on %s", got)
	}
	os.WriteFile(p.TokenFile(), []byte("sk-ant-oat01-x\n"), 0o600)
	env := strings.Join(p.Env(), " ")
	for _, want := range []string{"CLAUDE_CONFIG_DIR=" + p.Home(), "TMPDIR=" + filepath.Join(p.Home(), "tmp"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x"} {
		if !strings.Contains(env, want) {
			t.Errorf("env %q misses %s", env, want)
		}
	}

	if err := p.Prepare(); err != nil {
		t.Fatal(err)
	}
	for _, name := range Kept {
		if dst, _ := os.Readlink(filepath.Join(p.Home(), name)); dst != filepath.Join(p.Dir, name) {
			t.Errorf("%s links to %q", name, dst)
		}
	}
	b, _ := os.ReadFile(p.State())
	if !strings.Contains(string(b), "hasCompletedOnboarding") || strings.Contains(string(b), "mcpServers") {
		t.Errorf("state %s: wants onboarding and no MCP servers", b)
	}

	t.Setenv("XDG_RUNTIME_DIR", "")
	SetProfiles([]Profile{{Name: "private", Dir: "~/.claude-private", Ephemeral: true}})
	if _, ok := ProfileNamed("private"); ok {
		t.Error("an ephemeral profile without a memory folder is kept")
	}
}

func TestErase(t *testing.T) {
	p, _ := withPrivate(t)
	proj := filepath.Join(p.Projects(), "-x")
	os.MkdirAll(filepath.Join(proj, "s1", "subagents"), 0o700)
	os.MkdirAll(filepath.Join(p.Home(), "file-history", "s1"), 0o700)
	for _, f := range []string{"s1.jsonl", "s2.jsonl"} {
		os.WriteFile(filepath.Join(proj, f), []byte("{}\n"), 0o600)
	}
	hist := filepath.Join(p.Home(), "history.jsonl")
	os.WriteFile(hist, []byte(`{"display":"a","sessionId":"s1"}`+"\n"+`{"display":"b","sessionId":"s2"}`+"\n"), 0o600)
	if !Private("s1") {
		t.Error("s1 is not private")
	}

	if err := Erase(p, "s1"); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{filepath.Join(proj, "s1.jsonl"), filepath.Join(proj, "s1"), filepath.Join(p.Home(), "file-history", "s1")} {
		if _, err := os.Stat(f); err == nil {
			t.Errorf("%s is left", f)
		}
	}
	if _, err := os.Stat(filepath.Join(proj, "s2.jsonl")); err != nil {
		t.Error("another conversation went with it")
	}
	if b, _ := os.ReadFile(hist); string(b) != `{"display":"b","sessionId":"s2"}`+"\n" {
		t.Errorf("history: %s", b)
	}

	work, _ := ProfileNamed("work")
	if Erase(work, "s2") == nil {
		t.Error("a kept profile's conversation was erased")
	}
}
