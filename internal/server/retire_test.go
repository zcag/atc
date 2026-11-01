package server

import (
	"testing"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/sessions"
)

func TestRetirable(t *testing.T) {
	now := time.Now()
	old := sessions.Session{ID: "a", Attachable: true, Parked: true, State: sessions.YourTurn, Updated: now.Add(-13 * time.Hour)}
	if !retirable(old, "here", now) {
		t.Fatal("parked and idle for 13h is retired")
	}
	for name, x := range map[string]sessions.Session{
		"not parked":      {ID: "a", Attachable: true, State: sessions.YourTurn, Updated: old.Updated},
		"recent":          {ID: "a", Attachable: true, Parked: true, State: sessions.YourTurn, Updated: now.Add(-time.Hour)},
		"resumed lately":  {ID: "a", Attachable: true, Parked: true, State: sessions.YourTurn, Updated: old.Updated, StartedAt: now.Add(-time.Hour)},
		"working":         {ID: "a", Attachable: true, Parked: true, State: sessions.Working, Updated: old.Updated},
		"needs you":       {ID: "a", Attachable: true, Parked: true, State: sessions.NeedsYou, Updated: old.Updated},
		"serving a port":  {ID: "a", Attachable: true, Parked: true, State: sessions.YourTurn, Updated: old.Updated, Servers: []int{3000}},
		"background task": {ID: "a", Attachable: true, Parked: true, State: sessions.YourTurn, Updated: old.Updated, Background: []claude.Task{{}}},
		"another machine": {ID: "a", Attachable: true, Parked: true, State: sessions.YourTurn, Updated: old.Updated, Host: "laptop"},
		"opencode":        {ID: "a", Attachable: true, Parked: true, State: sessions.YourTurn, Updated: old.Updated, Harness: "opencode"},
	} {
		if retirable(x, "here", now) {
			t.Errorf("%s: would be stopped", name)
		}
	}
}
