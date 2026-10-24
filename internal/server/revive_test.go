package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zcag/atc/internal/sessions"
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
