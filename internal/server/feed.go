package server

import (
	"cmp"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

// feed is what changed in atc, kept for the assistant: the hub asks for it each turn and puts it in
// front of the message, so the assistant knows the current state without polling or guessing.
type feed struct {
	mu    sync.Mutex
	seq   int64
	evs   []feedEvent
	prev  map[string]sessions.Session
	down  map[string]bool
	list  []sessions.Session
	since time.Time
	// onDemand names the agents without a schedule: their last result is from whenever someone last
	// woke them, so the snapshot says so instead of passing it off as how things stand.
	onDemand func() map[string]bool
}

type feedEvent struct {
	seq  int64
	sid  string
	kind string
	host string
	was  sessions.Session
}

const (
	evNeeds   = "needs"
	evDone    = "done"
	evStarted = "started"
	evStopped = "stopped"
	evOffline = "offline"
	evBack    = "back"
	feedKeep  = 200
)

func newFeed() *feed { return &feed{seq: time.Now().UnixNano()} }

// observe records the changes between the last list and this one; it reports whether one of them
// is a session that now needs the user.
func (f *feed) observe(list []sessions.Session, peers []peerStatus, skip func(sessions.Session) bool) (needs bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur := map[string]sessions.Session{}
	for _, x := range list {
		if !skip(x) {
			cur[x.SessionID] = x
		}
	}
	down := map[string]bool{}
	for _, p := range peers {
		down[p.Name] = strings.HasPrefix(p.Error, "offline")
	}
	first := f.prev == nil
	prev := f.prev
	f.prev, f.list = cur, list
	defer func() { f.down = down }()
	if first {
		f.since = time.Now()
		return false
	}
	add := func(kind string, x sessions.Session, host string) {
		f.seq++
		f.evs = append(f.evs, feedEvent{f.seq, x.SessionID, kind, host, x})
	}
	for _, p := range peers {
		if down[p.Name] != f.down[p.Name] {
			add(map[bool]string{true: evOffline, false: evBack}[down[p.Name]], sessions.Session{}, p.Name)
		}
	}
	for _, x := range list {
		x, ok := cur[x.SessionID]
		if !ok {
			continue
		}
		was, seen := prev[x.SessionID]
		switch {
		case x.State == sessions.NeedsYou && (!seen || was.State != sessions.NeedsYou):
			add(evNeeds, x, x.Host)
			needs = true
		case seen && x.State == sessions.YourTurn && was.State == sessions.Working:
			add(evDone, x, x.Host)
		case x.Agent != "":
			if x.State == sessions.Working && (!seen || was.State != sessions.Working) {
				add(evStarted, x, x.Host)
			}
		case x.Away():
		case !seen && x.Current():
			add(evStarted, x, x.Host)
		case seen && was.Current() && !x.Current():
			add(evStopped, x, x.Host)
		}
	}
	for sid, was := range prev {
		if _, ok := cur[sid]; !ok && was.Current() && was.Agent == "" && !down[was.Host] {
			add(evStopped, was, was.Host)
		}
	}
	if len(f.evs) > feedKeep {
		f.evs = slices.Clone(f.evs[len(f.evs)-feedKeep:])
	}
	return needs
}

// news is the changes after since, one line per session at its latest, or with full the state as
// it is now. seq is what to pass as since next time.
func (f *feed) news(since int64, full bool, now time.Time) (text string, seq int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	clock := now.Format("15:04")
	if full {
		if f.prev == nil {
			return "", f.seq
		}
		return "[atc now, " + clock + "]\n" + f.snapshot(now), f.seq
	}
	var latest []feedEvent
	for _, e := range f.evs {
		if e.seq <= since {
			continue
		}
		key := cmp.Or(e.sid, "host:"+e.host)
		latest = slices.DeleteFunc(latest, func(o feedEvent) bool { return cmp.Or(o.sid, "host:"+o.host) == key })
		latest = append(latest, e)
	}
	if len(latest) == 0 {
		return "", f.seq
	}
	var lines []string
	for _, e := range latest {
		if l := f.line(e); l != "" {
			lines = append(lines, "- "+l)
		}
	}
	if len(lines) == 0 {
		return "", f.seq
	}
	if n := len(lines) - 10; n > 0 {
		lines = append(lines[n:], fmt.Sprintf("- and %d earlier changes", n))
	}
	return "[atc since your last turn, " + clock + "]\n" + strings.Join(lines, "\n"), f.seq
}

func (f *feed) find(e feedEvent) sessions.Session {
	if x, ok := f.prev[e.sid]; ok {
		return x
	}
	return e.was
}

func (f *feed) line(e feedEvent) string {
	switch e.kind {
	case evOffline:
		return e.host + " went offline: its sessions are missing until it is back"
	case evBack:
		return e.host + " is back online"
	}
	x := f.find(e)
	name := label(x, len(f.down) > 0)
	switch e.kind {
	case evNeeds:
		if x.State != sessions.NeedsYou {
			return ""
		}
		return name + " needs you: " + cmp.Or(clipText(x.Activity, 160), "a question or permission is open")
	case evDone:
		if x.Parked {
			return name + " finished, Parked: " + said(x)
		}
		return name + " finished, now in Your turn: " + said(x)
	case evStarted:
		if x.Agent != "" {
			return name + " started working"
		}
		return name + " started"
	case evStopped:
		return name + " stopped"
	}
	return ""
}

func label(x sessions.Session, withHost bool) string {
	switch {
	case x.Agent != "":
		return "@" + x.Agent
	case withHost && x.Host != "":
		return x.Title + " (" + x.Host + ")"
	}
	return x.Title
}

func result(x sessions.Session) string {
	return cmp.Or(clipText(x.Result(), 140), "its turn is done")
}

// said is a session's last word for the snapshot: what it came to and everything it leaves open.
func said(x sessions.Session) string {
	return strings.Join(append([]string{clipText(result(x), 160)}, x.Open()...), " | ")
}

// snapshot is the list as their Triage screen shows it, bay by bay: Your turn, Pinned, Working,
// Parked. Stopped sessions are left out: they no longer wait on them.
func (f *feed) snapshot(now time.Time) string {
	var mine []sessions.Session
	hosts := map[string]bool{}
	agent := map[string]sessions.Session{}
	for _, x := range f.list {
		if _, ok := f.prev[x.SessionID]; !ok {
			continue
		}
		if x.Agent != "" {
			if a, ok := agent[x.Agent]; ok && (x.State == sessions.Stopped || a.State != sessions.Stopped) {
				continue
			}
			agent[x.Agent] = x
		}
		mine = append(mine, x)
		hosts[x.Host] = true
	}
	mine = slices.DeleteFunc(mine, func(x sessions.Session) bool { return x.Agent != "" && agent[x.Agent].SessionID != x.SessionID })
	slices.SortStableFunc(mine, func(a, b sessions.Session) int { return b.Last().Compare(a.Last()) })
	slices.SortStableFunc(mine, func(a, b sessions.Session) int {
		return cmp.Compare(boolInt(a.State != sessions.NeedsYou), boolInt(b.State != sessions.NeedsYou))
	})
	var onDemand map[string]bool
	if f.onDemand != nil {
		onDemand = f.onDemand()
	}
	var turn, pinned, working, parked []string
	for _, x := range mine {
		name := label(x, len(hosts) > 1)
		when := ago(now.Sub(x.Last())) + " ago"
		if onDemand[x.Agent] && x.State != sessions.Working {
			when = "last run " + when + ", not live"
		}
		line := name + " (" + when + "): " + said(x)
		switch {
		case x.State == sessions.NeedsYou:
			turn = append(turn, name+" (needs you, "+when+"): "+cmp.Or(clipText(x.Activity, 160), "a question or permission is open"))
		case x.Pinned && !x.Away():
			pinned = append(pinned, line)
		case x.State == sessions.Working:
			working = append(working, name+": "+cmp.Or(clipText(x.Activity, 100), "working"))
		case x.Away():
			if x.Result() != "" {
				parked = append(parked, line)
			}
		case x.State == sessions.YourTurn:
			turn = append(turn, line)
		}
	}
	list := func(head string, items []string) string {
		if len(items) == 0 {
			return head + ": none"
		}
		return head + ":\n- " + strings.Join(items, "\n- ")
	}
	parts := []string{list("Your turn (each waits on them)", turn)}
	if len(pinned) > 0 {
		parts = append(parts, list("Pinned", pinned))
	}
	if len(working) > 0 {
		parts = append(parts, list("Working", working))
	}
	if len(parked) > 0 {
		parts = append(parts, list("Parked (they set these aside)", parked))
	}
	var off []string
	for h, d := range f.down {
		if d {
			off = append(off, h)
		}
	}
	if len(off) > 0 {
		slices.Sort(off)
		parts = append(parts, "Offline: "+strings.Join(off, ", ")+" (its sessions are missing)")
	}
	return strings.Join(parts, "\n")
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func ago(d time.Duration) string {
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func clipText(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// feedNews serves the feed to the hub: since=<seq from the last answer>, full=1 for the state as it is.
func (s *Server) feedNews(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	text, seq := s.feed.news(since, r.URL.Query().Get("full") != "", time.Now())
	reply(w, map[string]any{"seq": seq, "text": text})
}

func (s *Server) isHub(x sessions.Session) bool {
	return x.Kind == "hub" || x.SessionID != "" && x.SessionID == s.hubSID()
}
