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
		return "[atc now, " + clock + "] " + f.snapshot(now), f.seq
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
		return name + " needs them: " + cmp.Or(clipText(x.Activity, 160), "waiting on them")
	case evDone:
		return name + " finished: " + result(x)
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
	if x.Summary != nil && x.Summary.Status != "" {
		return x.Summary.Status
	}
	return cmp.Or(clipText(x.LastReply, 140), "its turn is done")
}

func (f *feed) snapshot(now time.Time) string {
	var needs, working, done, agents []string
	var recent []sessions.Session
	for _, x := range f.list {
		if _, ok := f.prev[x.SessionID]; !ok || !x.Current() && x.Agent == "" {
			continue
		}
		if x.Agent != "" && x.State != sessions.NeedsYou {
			switch {
			case x.State == sessions.Working:
				agents = append(agents, "@"+x.Agent+" working")
			case now.Sub(x.Last()) < 12*time.Hour:
				agents = append(agents, "@"+x.Agent+" done "+ago(now.Sub(x.Last()))+" ago: "+clipText(result(x), 80))
			}
			continue
		}
		switch x.State {
		case sessions.NeedsYou:
			needs = append(needs, label(x, false)+" ("+cmp.Or(clipText(x.Activity, 100), "waiting")+")")
		case sessions.Working:
			working = append(working, x.Title)
		default:
			if now.Sub(x.Last()) < 3*time.Hour {
				recent = append(recent, x)
			}
		}
	}
	slices.SortStableFunc(recent, func(a, b sessions.Session) int { return b.Last().Compare(a.Last()) })
	for _, x := range recent[:min(len(recent), 5)] {
		done = append(done, x.Title+": "+clipText(result(x), 80))
	}
	parts := []string{"needs them: " + cmp.Or(strings.Join(needs, "; "), "nothing")}
	if len(working) > 0 {
		parts = append(parts, "working: "+strings.Join(working, ", "))
	}
	if len(done) > 0 {
		parts = append(parts, "finished lately: "+strings.Join(done, "; "))
	}
	if len(agents) > 0 {
		parts = append(parts, "agents: "+strings.Join(agents, "; "))
	}
	var off []string
	for h, d := range f.down {
		if d {
			off = append(off, h)
		}
	}
	if len(off) > 0 {
		slices.Sort(off)
		parts = append(parts, "offline: "+strings.Join(off, ", ")+" (its sessions are missing)")
	}
	return strings.Join(parts, ". ") + "."
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
