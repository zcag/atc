package claude

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartRecordsTrustAtTheRepoTop(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	exec.Command("git", "init", "-q", repo).Run()
	sub := filepath.Join(repo, "a", "b")
	os.MkdirAll(sub, 0o755)
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte("#!/bin/sh\nif grep -qF '\""+repo+"\"' \"$HOME/.claude.json\" 2>/dev/null; then echo 'backgrounded · abcd1234'; else echo 'Workspace not trusted. Run claude once'; exit 1; fi\n"), 0o755)
	id, err := CLI{Bin: bin}.Start(context.Background(), sub, "", "go")
	if err != nil || id != "abcd1234" {
		t.Fatalf("start: %q %v", id, err)
	}
	b, _ := os.ReadFile(filepath.Join(home, ".claude.json"))
	if strings.Contains(string(b), sub) {
		t.Errorf("the yes went to the folder, not the repo: %s", b)
	}
}

func TestStillRefused(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	for out, home := range map[string]bool{
		"Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.":                                    false,
		"Workspace not trusted. The home directory is trusted one session at a time, start this from an interactive terminal there.": true,
	} {
		bin := filepath.Join(t.TempDir(), "claude")
		os.WriteFile(bin, []byte("#!/bin/sh\necho tried >> \"$0.tries\"\ncat <<'E'\n"+out+"\nE\nexit 1\n"), 0o755)
		dir := t.TempDir()
		_, err := CLI{Bin: bin}.Start(context.Background(), dir, "", "go")
		var u *Untrusted
		if !errors.As(err, &u) || !errors.Is(err, ErrUntrusted) || u.Dir != dir || u.Home != home {
			t.Errorf("%q: %#v", out, err)
		}
		tries, _ := os.ReadFile(bin + ".tries")
		if n := strings.Count(string(tries), "tried"); n != map[bool]int{true: 1, false: 2}[home] {
			t.Errorf("%q: tried %d times", out, n)
		}
	}
}

func TestAcceptKeepsTheRest(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	path := filepath.Join(dir, ".claude.json")
	os.WriteFile(path, []byte(`{"a": {"b": [1, 2]}, "projects": {"/p": {"x": 1, "hasTrustDialogAccepted": false}}}`), 0o644)
	if err := Accept("/p"); err != nil {
		t.Fatal(err)
	}
	if err := Accept("/q"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	for _, want := range []string{`"b": [`, `"x": 1`, `"/q": {`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("missing %s in %s", want, b)
		}
	}
	if strings.Contains(string(b), "false") {
		t.Errorf("still false: %s", b)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o644 {
		t.Errorf("mode %v", st.Mode())
	}
	os.WriteFile(path, []byte(`{"proj`), 0o600)
	if Accept("/p") == nil {
		t.Error("rewrote half a file")
	}
}
