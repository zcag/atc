package server

import (
	"strings"
	"testing"
	"time"

	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/summary"
)

func sess(id, title, state string) sessions.Session {
	return sessions.Session{SessionID: id, Title: title, State: state, Attachable: true, Host: "desktop", Updated: time.Now()}
}

func TestFeedLinesAndSnapshot(t *testing.T) {
	f := newFeed()
	none := func(sessions.Session) bool { return false }
	up := []peerStatus{{Name: "laptop"}}
	now := time.Now()
	f.observe([]sessions.Session{sess("a", "build", sessions.Working), sess("b", "docs", sessions.YourTurn)}, up, none)
	if text, _ := f.news(0, false, now); text != "" {
		t.Fatalf("first look reported changes: %q", text)
	}
	text, seq := f.news(0, true, now)
	if !strings.Contains(text, "Your turn (each waits on them):") || !strings.Contains(text, "- build: working") || !strings.Contains(text, "- docs (0m ago): its turn is done") {
		t.Fatalf("snapshot %q", text)
	}

	done := sess("a", "build", sessions.YourTurn)
	done.Summary = &summary.Summary{Status: "Done: tests pass"}
	asks := sess("b", "docs", sessions.NeedsYou)
	asks.Activity = "Approve: git push"
	needs := f.observe([]sessions.Session{done, asks, sess("c", "new one", sessions.Working)}, []peerStatus{{Name: "laptop", Error: "offline: timeout"}}, none)
	if !needs {
		t.Fatal("a session that needs them was not flagged")
	}
	text, seq = f.news(seq, false, now)
	for _, want := range []string{"build (desktop) finished, now in Your turn: Done: tests pass", "docs (desktop) needs you: Approve: git push", "new one (desktop) started", "laptop went offline"} {
		if !strings.Contains(text, want) {
			t.Errorf("news %q lacks %q", text, want)
		}
	}
	if again, _ := f.news(seq, false, now); again != "" {
		t.Fatalf("the same changes twice: %q", again)
	}

	f.observe([]sessions.Session{done, sess("b", "docs", sessions.Working)}, []peerStatus{{Name: "laptop", Error: "offline: timeout"}}, none)
	text, _ = f.news(seq, false, now)
	if !strings.Contains(text, "new one (desktop) stopped") || strings.Contains(text, "needs you") {
		t.Fatalf("news after the ask was answered %q", text)
	}
	if snap, _ := f.news(0, true, now); !strings.Contains(snap, "Offline: laptop") {
		t.Fatalf("snapshot without the offline machine %q", snap)
	}
}

func TestFeedSkipsTheAssistantAndParked(t *testing.T) {
	f := newFeed()
	self := func(x sessions.Session) bool { return x.SessionID == "me" }
	f.observe(nil, nil, self)
	parked := sess("p", "quiet", sessions.Working)
	parked.Parked = true
	f.observe([]sessions.Session{sess("me", "assistant", sessions.Working), parked}, nil, self)
	if text, _ := f.news(0, false, time.Now()); text != "" {
		t.Fatalf("news %q, want nothing", text)
	}
}

func TestFeedFollowsParkedAgents(t *testing.T) {
	f := newFeed()
	none := func(sessions.Session) bool { return false }
	agent := func(state string) sessions.Session {
		x := sess("s", "Shopping", state)
		x.Agent, x.Parked = "shopping", state != sessions.Working
		return x
	}
	f.observe([]sessions.Session{agent(sessions.YourTurn)}, nil, none)
	f.observe([]sessions.Session{agent(sessions.Working)}, nil, none)
	text, seq := f.news(0, false, time.Now())
	if !strings.Contains(text, "@shopping started working") {
		t.Fatalf("waking agent: %q", text)
	}
	done := agent(sessions.YourTurn)
	done.Summary = &summary.Summary{Status: "Picks: towel"}
	f.observe([]sessions.Session{done}, nil, none)
	if text, _ = f.news(seq, false, time.Now()); !strings.Contains(text, "@shopping finished, Parked: Picks: towel") {
		t.Fatalf("agent done and parked: %q", text)
	}
	if snap, _ := f.news(0, true, time.Now()); !strings.Contains(snap, "Parked (they set these aside):\n- @shopping (0m ago): Picks: towel") {
		t.Fatalf("snapshot %q", snap)
	}
}

func TestSnapshotFollowsHisScreen(t *testing.T) {
	f := newFeed()
	none := func(sessions.Session) bool { return false }
	now := time.Now()
	var list []sessions.Session
	for i := range 8 {
		x := sess(string(rune('a'+i)), "old "+string(rune('a'+i)), sessions.YourTurn)
		x.Updated = now.Add(-time.Duration(i+5) * time.Hour)
		list = append(list, x)
	}
	pr := sess("p", "pr-watch", sessions.YourTurn)
	pr.Parked = true
	pr.Summary = &summary.Summary{Status: "Waiting: approval to push", Overview: []string{"Done: three commits", "Open: push needs their go-ahead"}}
	gone := sess("s", "finished long ago", sessions.Stopped)
	gone.Attachable = false
	focus := func(id string, state string, at time.Time) sessions.Session {
		x := sess(id, "Focus", state)
		x.Agent, x.Parked, x.Updated = "shop-focus", true, at
		x.Summary = &summary.Summary{Status: "Notes read: 5 sessions wait on you"}
		return x
	}
	list = append(list, pr, gone, focus("f1", sessions.Stopped, now.Add(-time.Hour)), focus("f2", sessions.YourTurn, now.Add(-20*time.Hour)))
	f.observe(list, nil, none)
	snap, _ := f.news(0, true, now)
	for _, want := range []string{"- old h (12h ago): its turn is done", "Parked (they set these aside):\n- pr-watch (0m ago): Waiting: approval to push | Open: push needs their go-ahead\n- @shop-focus (20h ago): Notes read: 5 sessions wait on you"} {
		if !strings.Contains(snap, want) {
			t.Errorf("snapshot lacks %q:\n%s", want, snap)
		}
	}
	if strings.Count(snap, "@shop-focus") != 1 || strings.Contains(snap, "finished long ago") {
		t.Errorf("snapshot:\n%s", snap)
	}
}

func TestSnapshotMarksOnDemandAgentsNotLive(t *testing.T) {
	f := newFeed()
	f.onDemand = func() map[string]bool { return map[string]bool{"email": true} }
	now := time.Now()
	agent := func(id, name string) sessions.Session {
		x := sess(id, name, sessions.YourTurn)
		x.Agent, x.Updated = name, now.Add(-7*time.Hour)
		x.Summary = &summary.Summary{Status: "1 needs you"}
		return x
	}
	f.observe([]sessions.Session{agent("e", "email"), agent("t", "tracker")}, nil, func(sessions.Session) bool { return false })
	snap, _ := f.news(0, true, now)
	for _, want := range []string{"- @email (last run 7h ago, not live): 1 needs you", "- @tracker (7h ago): 1 needs you"} {
		if !strings.Contains(snap, want) {
			t.Errorf("snapshot lacks %q:\n%s", want, snap)
		}
	}
}
