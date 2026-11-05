package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestTrusted(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	root, _ := filepath.EvalSymlinks(t.TempDir())
	yes, no, under := filepath.Join(root, "yes"), filepath.Join(root, "no"), filepath.Join(root, "yes", "a", "b")
	link := filepath.Join(root, "link")
	os.MkdirAll(under, 0o755)
	os.MkdirAll(no, 0o755)
	os.Symlink(yes, link)
	if Trusted(yes) {
		t.Error("trusted with no config at all")
	}
	cfg := `{"projects":{"` + yes + `":{"hasTrustDialogAccepted":true},"` + yes + `/a":{"hasTrustDialogAccepted":false},"` + no + `":{"hasTrustDialogAccepted":false}}}`
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(cfg), 0o600)
	for dir, want := range map[string]bool{yes: true, under: true, link: true, no: false, root: false} {
		if got := Trusted(dir); got != want {
			t.Errorf("Trusted(%s) = %v, want %v", dir, got, want)
		}
	}
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"proj`), 0o600)
	if Trusted(yes) {
		t.Error("trusted from half a file")
	}
	other := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", other)
	os.WriteFile(filepath.Join(other, ".claude.json"), []byte(cfg), 0o600)
	if !Trusted(yes) {
		t.Error("CLAUDE_CONFIG_DIR is where the config is then")
	}
}

func TestStartNamesTheUntrustedFolder(t *testing.T) {
	for out, home := range map[string]bool{
		"Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.":                                    false,
		"Workspace not trusted. The home directory is trusted one session at a time, start this from an interactive terminal there.": true,
	} {
		bin := filepath.Join(t.TempDir(), "claude")
		os.WriteFile(bin, []byte("#!/bin/sh\ncat <<'E'\n"+out+"\nE\nexit 1\n"), 0o755)
		dir := t.TempDir()
		_, err := CLI{Bin: bin}.Start(context.Background(), dir, "", "go")
		var u *Untrusted
		if !errors.As(err, &u) || !errors.Is(err, ErrUntrusted) || u.Dir != dir || u.Home != home {
			t.Errorf("%q: %#v", out, err)
		}
	}
}
