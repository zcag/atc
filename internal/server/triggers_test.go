package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func TestPresetEvery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "presets.json")
	os.WriteFile(path, []byte(`[{"name":"inbox","dir":"/tmp","every":"5m","check":"ls new","prompt":"File these."},{"name":"plain","dir":"/tmp"}]`), 0o644)
	list, err := LoadPresets(path)
	if err != nil || len(list) != 2 || list[0].Check != "ls new" || list[0].Prompt != "File these." {
		t.Fatalf("load: %+v %v", list, err)
	}
	if d, _ := list[0].interval(); d.Minutes() != 5 {
		t.Errorf("interval: %s", d)
	}
	if d, err := list[1].interval(); d != 0 || err != nil {
		t.Errorf("no every: %s %v", d, err)
	}
	for _, bad := range []string{`"every":"soon","prompt":"x"`, `"every":"-1m","prompt":"x"`, `"every":"5m"`} {
		os.WriteFile(path, []byte(`[{"name":"x","dir":"/tmp",`+bad+`}]`), 0o644)
		if _, err := LoadPresets(path); err == nil {
			t.Errorf("%s: want an error", bad)
		}
	}
}

func TestFirstMessage(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "new.txt"), nil, 0o644)
	ctx := context.Background()
	for _, c := range []struct {
		check, prompt, want string
		run                 bool
	}{
		{"", "Tidy up.", "Tidy up.", true},
		{"ls", "", "new.txt", true},
		{"ls", "File these.", "File these.\n\nnew.txt", true},
		{"true", "File these.", "", false},
		{"echo hi; exit 1", "File these.", "", false},
	} {
		msg, why := Preset{Name: "p", Dir: dir, Check: c.check, Prompt: c.prompt}.firstMessage(ctx)
		if msg != c.want || (why == "") != c.run {
			t.Errorf("%q: got %q, %q", c.check, msg, why)
		}
	}
}

func TestTick(t *testing.T) {
	bin := fakeClaude(t)
	dir := t.TempDir()
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st}, Term: &attach.Hub{},
		kick: make(chan struct{}, 1), Presets: []Preset{{Name: "inbox", Dir: dir, Every: "1m", Check: "echo mail", Prompt: "Answer:"}}}
	p, ctx := s.Presets[0], context.Background()
	agents := func(state string) {
		os.WriteFile(filepath.Join(filepath.Dir(bin), "agents.json"), []byte(`[{"id":"abcd1234","sessionId":"s9","kind":"background","pid":1,"state":"`+state+`"}]`), 0o644)
	}
	started := filepath.Join(filepath.Dir(bin), "started")

	if last := s.tick(ctx, p, ""); last != "abcd1234" {
		t.Fatalf("first tick: %q", last)
	}
	if args, _ := os.ReadFile(started); !strings.Contains(string(args), "--name inbox Answer:\n\nmail") {
		t.Errorf("args: %s", args)
	}
	agents("working")
	os.Remove(started)
	if last := s.tick(ctx, p, "abcd1234"); last != "abcd1234" || fileExists(started) {
		t.Errorf("started another run over a busy one: %q", last)
	}
	agents("done")
	if s.tick(ctx, p, "abcd1234"); !fileExists(started) {
		t.Error("a finished run must not hold back the next")
	}
	os.Remove(started)
	p.Check = "true"
	if last := s.tick(ctx, p, ""); last != "" || fileExists(started) {
		t.Errorf("empty check output started a run: %q", last)
	}
}

func TestBusy(t *testing.T) {
	list := []sessions.Session{{ID: "a", State: sessions.Working}, {ID: "b", State: sessions.NeedsYou}, {ID: "c", State: sessions.YourTurn}, {ID: "d", State: sessions.Stopped}}
	for id, want := range map[string]bool{"a": true, "b": true, "c": false, "d": false, "gone": false} {
		if busy(list, id) != want {
			t.Errorf("%s: want %v", id, want)
		}
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
