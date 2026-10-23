package sessions

import (
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
