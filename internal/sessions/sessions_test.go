package sessions

import (
	"strings"
	"testing"

	"github.com/zcag/atc/internal/claude"
)

func TestTilde(t *testing.T) {
	for in, want := range map[string]string{
		"/home/u":           "~",
		"/home/u/proj/x":    "~/proj/x",
		"/Users/other/code": "~/code",
		"/Users/other":      "~",
		"/srv/app":          "/srv/app",
	} {
		if got := Tilde(in, "/home/u"); got != want {
			t.Errorf("Tilde(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestState(t *testing.T) {
	for _, c := range []struct {
		state, status, want string
	}{
		{"working", "busy", Working},
		{"working", "idle", YourTurn},
		{"done", "idle", YourTurn},
		{"blocked", "busy", NeedsYou},
	} {
		if got := state(claude.Agent{Kind: "background", PID: 1, State: c.state, Status: c.status}); got != c.want {
			t.Errorf("state(%s/%s) = %q, want %q", c.state, c.status, got, c.want)
		}
	}
}

func TestSortParked(t *testing.T) {
	list := []Session{
		{SessionID: "run", Agent: "email", State: YourTurn},
		{SessionID: "asks", Parked: true, State: NeedsYou},
		{SessionID: "parked", Parked: true, State: YourTurn},
		{SessionID: "chat", State: Working},
		{SessionID: "old", State: Stopped},
	}
	Sort(list)
	var got []string
	for _, s := range list {
		got = append(got, s.SessionID)
	}
	if want := "asks run chat parked old"; strings.Join(got, " ") != want {
		t.Errorf("order %v, want %s", got, want)
	}
}

func TestRetiredHub(t *testing.T) {
	for name, want := range map[string]bool{
		"assistant 11-01 16:41":            true,
		"whatsapp 10-30 21:02":             true,
		"whatsapp (continued as 92e37934)": true,
		"assistant":                        false,
		"whatsapp":                         false,
		"Tracker 10-31 15:01":              false,
		"guests 11-01 12:00":               false,
		"assistant notes":                  false,
	} {
		if RetiredHub(name) != want {
			t.Errorf("RetiredHub(%q) = %v", name, !want)
		}
	}
}
