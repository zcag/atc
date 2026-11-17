package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withProfiles(t *testing.T) (work, home string) {
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	work = filepath.Join(home, ".claude-work")
	os.MkdirAll(filepath.Join(home, "proj", "co", "app"), 0o755)
	cfg := filepath.Join(home, "profiles.json")
	os.WriteFile(cfg, []byte(`[{"name": "personal"}, {"name": "work", "dir": "~/.claude-work", "paths": ["~/proj/co"]}]`), 0o644)
	if err := LoadProfiles(cfg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { SetProfiles(nil) })
	return work, home
}

func TestProfileFor(t *testing.T) {
	work, home := withProfiles(t)
	for dir, want := range map[string]string{
		filepath.Join(home, "proj", "co", "app"): "work",
		filepath.Join(home, "proj", "co"):        "work",
		filepath.Join(home, "proj", "cola"):      "personal",
		home:                                     "personal",
	} {
		if got := ProfileFor(dir).Name; got != want {
			t.Errorf("%s: %s, want %s", dir, got, want)
		}
	}
	link := filepath.Join(home, "co")
	os.Symlink(filepath.Join(home, "proj", "co"), link)
	if got := ProfileFor(filepath.Join(link, "app")).Name; got != "work" {
		t.Errorf("through a symlink: %s", got)
	}
	if p, _ := ProfileNamed("work"); p.Home() != work || p.Env()[0] != "CLAUDE_CONFIG_DIR="+work || p.State() != filepath.Join(work, ".claude.json") {
		t.Errorf("work: %+v %s %s", p, p.Home(), p.State())
	}
	if p := DefaultProfile(); p.Name != "personal" || p.Env() != nil || p.State() != filepath.Join(home, ".claude.json") {
		t.Errorf("default: %+v %s", p, p.State())
	}
	if p := ProfileOfFile(filepath.Join(work, "projects", "x", "s.jsonl")); p.Name != "work" {
		t.Errorf("transcript in the work folder: %s", p.Name)
	}
}

// fake is a claude that answers in the config folder it was given: agents lists one session per daemon,
// --bg says where it started.
func fake(t *testing.T) string {
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte(`#!/bin/sh
dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
case "$1" in
agents) case "$dir" in *work) echo '[{"id":"bbbb2222","sessionId":"s2"}]';; *) echo '[{"id":"aaaa1111","sessionId":"s1"}]';; esac;;
--bg) echo "$dir" > "$0.started"; echo 'backgrounded · cccc3333';;
stop) echo "$dir $2" > "$0.stopped";;
esac
`), 0o755)
	return bin
}

func TestEachProfileHasItsOwnDaemon(t *testing.T) {
	work, home := withProfiles(t)
	bin := fake(t)
	c := CLI{Bin: bin}
	as, err := c.Agents(context.Background())
	if err != nil || len(as) != 2 || as[0].Profile != "personal" || as[1].Profile != "work" {
		t.Fatalf("%+v %v", as, err)
	}
	if err := c.Stop(context.Background(), "bbbb2222"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(bin + ".stopped"); strings.TrimSpace(string(b)) != work+" bbbb2222" {
		t.Errorf("stop went to %s", b)
	}
	for profile, want := range map[string]string{"": work, "personal": filepath.Join(home, ".claude")} {
		if _, err := c.Start(context.Background(), profile, filepath.Join(home, "proj", "co", "app"), "", "go"); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(bin + ".started"); strings.TrimSpace(string(b)) != want {
			t.Errorf("profile %q started in %s, want %s", profile, b, want)
		}
	}
	if ProfileOf("cccc3333").Name != "personal" {
		t.Errorf("the last start was personal")
	}
	if _, err := c.Start(context.Background(), "nope", home, "", "go"); err == nil {
		t.Error("started as a profile that does not exist")
	}
}

func TestResumeFollowsTheTranscript(t *testing.T) {
	work, home := withProfiles(t)
	os.MkdirAll(filepath.Join(work, "projects", "p"), 0o755)
	os.WriteFile(filepath.Join(work, "projects", "p", "s9.jsonl"), []byte("{}\n"), 0o644)
	bin := fake(t)
	if _, err := (CLI{Bin: bin}).Resume(context.Background(), home, "s9"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(bin + ".started"); strings.TrimSpace(string(b)) != work {
		t.Errorf("resumed in %s", b)
	}
}

func TestMove(t *testing.T) {
	work, home := withProfiles(t)
	base := filepath.Join(home, ".claude")
	proj := filepath.Join(base, "projects", "p")
	os.MkdirAll(filepath.Join(proj, "s1", "subagents"), 0o755)
	os.WriteFile(filepath.Join(proj, "s1.jsonl"), []byte("{}\n"), 0o644)
	os.WriteFile(filepath.Join(proj, "s1", "subagents", "a.jsonl"), []byte("{}\n"), 0o644)
	os.MkdirAll(filepath.Join(base, "file-history", "s1"), 0o755)
	to, _ := ProfileNamed("work")
	if err := Move("s1", to); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"projects/p/s1.jsonl", "projects/p/s1/subagents/a.jsonl", "file-history/s1"} {
		if _, err := os.Stat(filepath.Join(work, p)); err != nil {
			t.Errorf("%s did not move: %v", p, err)
		}
	}
	if ProfileOfSession("s1").Name != "work" {
		t.Error("it would not resume on work")
	}
	if Move("s1", to) == nil {
		t.Error("moved onto the account it is on")
	}
}
