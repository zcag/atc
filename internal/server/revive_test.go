package server

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func TestReviverSpotsAMassStop(t *testing.T) {
	rv := &reviver{path: filepath.Join(t.TempDir(), "running.json")}
	live := []sessions.Session{
		{SessionID: "a", ID: "aaaa0001", Attachable: true, Title: "A", State: sessions.Working},
		{SessionID: "b", ID: "bbbb0001", Attachable: true, Title: "B", State: sessions.YourTurn},
		{SessionID: "c", ID: "cccc0001", Attachable: true, Title: "C", Host: "peer"},
	}
	if lost := rv.observe(runningOf(live, "here")); lost != nil {
		t.Fatalf("first look: %v", lost)
	}
	lost := rv.observe(runningOf(nil, "here"))
	if len(lost) != 2 {
		t.Fatalf("want both local sessions back, got %+v", lost)
	}
	for _, r := range lost {
		if r.SID == "a" && !r.Working {
			t.Error("A was working and should get the continue message")
		}
	}

	rv = &reviver{path: rv.path}
	rv.observe(runningOf(live, "here"))
	rv.stopping("aaaa0001")
	if lost := rv.observe(runningOf(nil, "here")); lost != nil {
		t.Fatalf("one session stopped on purpose leaves too few to call it a crash: %v", lost)
	}
}

func TestReviverRevivesOnceAndNotAgainSoon(t *testing.T) {
	rv := &reviver{path: filepath.Join(t.TempDir(), "running.json")}
	live := []sessions.Session{
		{SessionID: "a", ID: "aaaa0001", Attachable: true},
		{SessionID: "b", ID: "bbbb0001", Attachable: true},
	}
	rv.observe(runningOf(live, "here"))
	if lost := rv.observe(runningOf(nil, "here")); len(lost) != 2 {
		t.Fatalf("want the crash noticed: %v", lost)
	}
	for range 3 {
		if lost := rv.observe(runningOf(nil, "here")); lost != nil {
			t.Fatalf("polls while the service is still empty must not start another revive: %v", lost)
		}
	}
	rv.observe(runningOf(live, "here"))
	if lost := rv.observe(runningOf(nil, "here")); lost != nil {
		t.Fatalf("a crash while a revive runs must not start a second one: %v", lost)
	}
	rv.end()
	rv.observe(runningOf(live, "here"))
	if lost := rv.observe(runningOf(nil, "here")); lost != nil {
		t.Fatalf("a crash minutes after a revive must not bring everything back again: %v", lost)
	}
	rv.revived = time.Now().Add(-reviveEvery - time.Second)
	rv.observe(runningOf(live, "here"))
	if lost := rv.observe(runningOf(nil, "here")); len(lost) != 2 {
		t.Fatalf("a crash long after the last revive is revived: %v", lost)
	}
}

func TestReviverIgnoresOpenCodeWhenClaudeStops(t *testing.T) {
	rv := &reviver{path: filepath.Join(t.TempDir(), "running.json")}
	oc := sessions.Session{SessionID: "ses_x", ID: "ses_x", Attachable: true, Title: "X", State: sessions.Working, Harness: "opencode"}
	live := []sessions.Session{
		{SessionID: "a", ID: "aaaa0001", Attachable: true, Title: "A"},
		{SessionID: "b", ID: "bbbb0001", Attachable: true, Title: "B"},
		oc,
	}
	rv.observe(runningOf(live, "here"))
	lost := rv.observe(runningOf([]sessions.Session{oc}, "here"))
	if len(lost) != 2 {
		t.Fatalf("an opencode session still running must not hide Claude's service stopping: %+v", lost)
	}
	for _, r := range lost {
		if r.Harness != "" {
			t.Fatalf("opencode keeps its own sessions; only Claude's come back: %+v", r)
		}
	}
}

func TestReviverAfterReboot(t *testing.T) {
	dir := t.TempDir()
	rv := &reviver{path: revivePath(dir)}
	rv.observe(runningOf([]sessions.Session{{SessionID: "a", ID: "aaaa0001", Attachable: true}}, "here"))
	if got := rv.afterReboot(); got != nil {
		t.Fatalf("written after boot, so no reboot since: %v", got)
	}
	b, _ := json.Marshal(runningFile{At: time.Unix(1000, 0), Sessions: []running{{SID: "a"}}})
	os.WriteFile(rv.path, b, 0o600)
	if got := rv.afterReboot(); len(got) != 1 || got[0].SID != "a" {
		t.Fatalf("after reboot: %v (%s)", got, b)
	}
}

func TestReviveWaitsForTheServiceToResumeItsOwn(t *testing.T) {
	daemonGrace, daemonPoll = 2*time.Second, 20*time.Millisecond
	t.Cleanup(func() { daemonGrace, daemonPoll = 45*time.Second, 2*time.Second })
	bin := fakeClaude(t)
	dir := filepath.Dir(bin)
	agents := func(js string) { os.WriteFile(filepath.Join(dir, "agents.json"), []byte(js), 0o644) }
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st}, Host: "here"}
	lost := []running{{SID: "sid-a", ID: "aaaa0001", Dir: t.TempDir(), Title: "A"}, {SID: "sid-b", ID: "bbbb0001", Dir: t.TempDir(), Title: "B"}}

	agents(`[{"id":"aaaa0001","sessionId":"sid-a","state":"blocked"},{"id":"bbbb0001","sessionId":"sid-b","state":"blocked"}]`)
	go func() {
		time.Sleep(200 * time.Millisecond)
		agents(`[{"id":"aaaa0001","sessionId":"sid-a","pid":11,"state":"idle"},{"id":"bbbb0001","sessionId":"sid-b","pid":12,"state":"busy"}]`)
	}()
	start := time.Now()
	s.awaitDaemon(lost)
	if took := time.Since(start); took > time.Second {
		t.Fatalf("both were back after 200ms but it waited %s", took)
	}
	for _, r := range lost {
		if _, err := s.reviveOne(r); !errors.Is(err, errBack) {
			t.Fatalf("%s is back on its own and must not get a second copy: %v", r.Title, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
		t.Fatal("a copy was started")
	}

	agents(`[{"id":"aaaa0001","sessionId":"sid-a","pid":11,"state":"idle"},{"id":"bbbb0001","sessionId":"sid-b","state":"blocked"}]`)
	start = time.Now()
	s.awaitDaemon(lost)
	if took := time.Since(start); took < daemonGrace {
		t.Fatalf("B never came back, so it should wait the whole grace; waited %s", took)
	}
	if _, err := s.reviveOne(lost[1]); err != nil {
		t.Fatalf("B should be relaunched: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "started")); err != nil {
		t.Fatal("B was not relaunched")
	}
}
