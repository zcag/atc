package shells

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShells(t *testing.T) {
	if _, err := Tmux(); err != nil {
		t.Skip(err)
	}
	for _, k := range []string{"LANG", "LC_ALL", "LC_CTYPE"} {
		t.Setenv(k, "")
	}
	dir, err := os.MkdirTemp("/tmp", "atcsh")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	s := &Shells{Socket: filepath.Join(dir, "s.sock")}
	ctx := context.Background()
	if l, err := s.List(ctx); err != nil || len(l) != 0 {
		t.Fatalf("before any shell: %v %v", l, err)
	}
	if _, err := s.Start(ctx, filepath.Join(dir, "nope")); err == nil {
		t.Fatal("started in a folder that does not exist")
	}
	sh, err := s.Start(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.run(ctx, "kill-server")
	if !ValidID(sh.ID) || !s.Has(ctx, sh.ID) {
		t.Fatalf("started %+v but it is not there", sh)
	}
	if out, _ := s.run(ctx, "show-options", "-gv", "status"); strings.TrimSpace(out) != "off" {
		t.Fatalf("status is %q, want off", out)
	}
	l, err := s.List(ctx)
	if err != nil || len(l) != 1 || l[0].ID != sh.ID || l[0].Started.IsZero() {
		t.Fatalf("list: %+v %v", l, err)
	}
	if err := s.Kill(ctx, sh.ID); err != nil {
		t.Fatal(err)
	}
	if s.Has(ctx, sh.ID) {
		t.Fatal("still there after kill")
	}
}

func TestEnv(t *testing.T) {
	t.Setenv("ATC_TOKEN", "x")
	t.Setenv("TMUX", "/tmp/x,1,0")
	env := strings.Join(Env(), "\n")
	if strings.Contains(env, "ATC_TOKEN") || strings.Contains(env, "TMUX=") || !strings.Contains(env, "TERM=xterm-256color") {
		t.Fatal(env)
	}
}
