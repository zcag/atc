package shells

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	if _, err := s.Start(ctx, filepath.Join(dir, "nope"), ""); err == nil {
		t.Fatal("started in a folder that does not exist")
	}
	sh, err := s.Start(ctx, dir, "")
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

	t.Setenv("SHELL", "/bin/sh")
	run, err := s.Start(ctx, dir, "echo ran-$((40+2)) | tr a-z A-Z")
	if err != nil {
		t.Fatal(err)
	}
	if l, _ := s.List(ctx); len(l) != 1 || l[0].Run != run.Run {
		t.Fatalf("run shell listed as %+v", l)
	}
	var screen string
	for i := 0; i < 50 && !strings.Contains(screen, "any key closes"); i++ {
		time.Sleep(100 * time.Millisecond)
		screen, _ = s.run(ctx, "capture-pane", "-p", "-t", prefix+run.ID)
	}
	if !strings.Contains(screen, "RAN-42") || !strings.Contains(screen, "[exit 0") {
		t.Fatalf("screen after the command:\n%s", screen)
	}
	s.run(ctx, "send-keys", "-t", prefix+run.ID, "q")
	for i := 0; i < 50 && s.Has(ctx, run.ID); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if s.Has(ctx, run.ID) {
		t.Fatal("run shell still there after a key")
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
