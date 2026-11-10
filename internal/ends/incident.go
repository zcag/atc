package ends

import (
	"cmp"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/zcag/atc/internal/resources"
)

// ownerOf is who a killed process belonged to: what the sampler saw when it died, or, for a kill
// from before atc kept that, the group whose biggest process had its name in the last minutes.
func (w *Watcher) ownerOf(k Kill) *Owner {
	if k.Owner != nil {
		return k.Owner
	}
	key := killKey(k)
	if o, ok := w.owners[key]; ok {
		return &o
	}
	if o, ok := w.guessed[key]; ok {
		return o
	}
	var best *Owner
	rows := w.Res.Between(k.At.Add(-3*time.Minute), k.At)
	for i := len(rows) - 1; i >= 0 && best == nil; i-- {
		for _, g := range rows[i].Groups {
			for _, t := range g.Top {
				if sameName(t.Name, k.Name) && (best == nil || t.Mem > best.Mem) {
					best = &Owner{Kind: g.Kind, Key: g.Key, Title: g.Title, Name: k.Name, Mem: t.Mem, Seen: time.Unix(rows[i].T, 0)}
				}
			}
		}
	}
	w.guessed[key] = best
	return best
}

// sameName allows for the kernel cutting a process's name at 15 characters.
func sameName(a, b string) bool {
	return a == b || len(b) == 15 && strings.HasPrefix(a, b) || len(a) == 15 && strings.HasPrefix(b, a)
}

// Incidents are the memory incidents of the last week, newest first, without their minutes and evidence.
func (w *Watcher) Incidents() []Incident {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	var ids []string
	for _, c := range w.clusters() {
		ids = append(ids, incidentID(c.first))
	}
	for _, r := range w.lowRuns() {
		if w.incidentNear(r[0]) == lowID(r[0]) {
			ids = append(ids, lowID(r[0]))
		}
	}
	w.mu.Unlock()
	var out []Incident
	for _, id := range ids {
		if inc := w.Incident(id); inc != nil && time.Since(inc.At) < keep {
			inc.Rows, inc.Evidence = nil, nil
			out = append(out, *inc)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out
}

// Incident is one memory incident in full: what grew, what the kernel killed, which sessions it
// cost, the minutes around it and every log line it rests on.
func (w *Watcher) Incident(id string) *Incident {
	if w == nil {
		return nil
	}
	kind, ts, _ := strings.Cut(id, "-")
	n, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	inc := &Incident{ID: id, At: time.Unix(n, 0), Kind: kind}
	start, end := inc.At, inc.At
	var big *Kill
	switch kind {
	case "oom":
		for _, c := range w.clusters() {
			if c.first.Unix() == n {
				inc.Kills, inc.Scoped, start, end = c.kills, c.scoped, c.first, c.kills[len(c.kills)-1].At
				b := c.biggest
				big = &b
			}
		}
		if big == nil {
			return nil
		}
	case "low":
		for _, r := range w.lowRuns() {
			if r[0].Unix() == n {
				end = r[1]
			}
		}
	default:
		return nil
	}
	var ev []Line
	for _, d := range w.daemon {
		switch {
		case d.kind == evLow && in(d.at, start.Add(-10*time.Minute), end.Add(time.Minute)):
			ev = append(ev, Line{d.at, SrcClaude, "Memory stayed low after the daemon closed what it could spare, so it began closing waiting sessions too.", d.raw})
		case d.kind == evDown && d.cause != "idle_exit" && in(d.at, start.Add(-90*time.Second), end.Add(90*time.Second)):
			inc.DaemonDown = true
			ev = append(ev, Line{d.at, SrcClaude, "Claude's daemon shut down.", d.raw})
		}
	}
	for i := range inc.Kills {
		k := &inc.Kills[i]
		k.Owner = w.ownerOf(*k)
		what := k.Name
		if k.Owner != nil && k.Owner.Title != "" {
			what += " in “" + k.Owner.Title + "”"
		}
		ev = append(ev, Line{k.At, SrcKernel, fmt.Sprintf("The kernel killed %s (%s) for memory.", what, gb(k.RSS)), strings.Join(k.Raw, "\n")})
	}
	for _, u := range w.units {
		if in(u.at, start.Add(-time.Minute), end.Add(3*time.Minute)) {
			ev = append(ev, Line{u.at, SrcSystemd, unitText(u.raw), u.raw})
		}
	}
	for id, ss := range w.settles {
		for _, st := range ss {
			if !in(st.at, start.Add(-10*time.Minute), end.Add(downWindow+time.Minute)) {
				continue
			}
			e := w.explainSettle(id, st)
			if e.Incident != inc.ID {
				continue
			}
			l := Lost{ID: id, At: st.at, Cause: e.Cause}
			if w.Title != nil {
				l.Title, l.SessionID = w.Title(id)
			}
			l.Title = cmp.Or(l.Title, id)
			if e.Cause == Memory {
				inc.Closed = append(inc.Closed, l)
				ev = append(ev, Line{e.At, SrcClaude, fmt.Sprintf("The daemon closed “%s” to free memory.", l.Title), w.retireRaw(id, e.At)})
			} else {
				inc.Lost = append(inc.Lost, l)
			}
		}
	}
	sort.Slice(inc.Lost, func(i, j int) bool { return inc.Lost[i].At.Before(inc.Lost[j].At) })
	sort.Slice(inc.Closed, func(i, j int) bool { return inc.Closed[i].At.Before(inc.Closed[j].At) })
	if len(inc.Lost) > 0 {
		ev = append(ev, Line{inc.Lost[0].At, SrcClaude, fmt.Sprintf("%s ended with it.", sessionsWord(len(inc.Lost))), ""})
	}
	rows := w.Res.Between(start.Add(-before), end.Add(after))
	inc.Culprit = culprit(rows, big, w, start)
	if c := inc.Culprit; c != nil {
		if c.FromAt.Before(c.PeakAt) {
			ev = append(ev, Line{c.FromAt, SrcResources, fmt.Sprintf("“%s” used %s.", c.Title, little(c.From)), ""})
		}
		if !c.PeakAt.IsZero() {
			ev = append(ev, Line{c.PeakAt, SrcResources, fmt.Sprintf("“%s” used %s, %s the most.", c.Title, gb(c.Peak), cmp.Or(c.Name, "one process")), ""})
		}
	}
	var peak resources.Row
	for _, r := range rows {
		inc.Total = max(inc.Total, r.Total)
		if r.Mem > peak.Mem && r.T <= end.Unix() {
			peak = r
		}
	}
	if peak.T > 0 {
		ev = append(ev, Line{time.Unix(peak.T, 0), SrcResources, fmt.Sprintf("Memory in use reached %s of %s.", gb(min(peak.Mem, peak.Total)), gb(peak.Total)), ""})
	}
	inc.Rows = trim(rows, inc.Culprit)
	sort.SliceStable(ev, func(i, j int) bool { return ev[i].At.Before(ev[j].At) })
	inc.Evidence = ev
	inc.Title, inc.Text = w.tell(inc, big, peak)
	return inc
}

func (w *Watcher) retireRaw(id string, at time.Time) string {
	for _, r := range w.retires[id] {
		if r.at.Equal(at) {
			return r.raw
		}
	}
	return ""
}

// little says a group's memory, where 0 means atc's history did not list it: it keeps only what uses 500 MB or more.
func little(n int64) string {
	if n == 0 {
		return "under 500 MB"
	}
	return gb(n)
}

func in(t, a, b time.Time) bool { return !t.Before(a) && !t.After(b) }

func unitText(raw string) string {
	switch {
	case strings.Contains(raw, "Failed with result 'oom-kill'"):
		return "systemd recorded the scope that holds Claude's daemon as failed because of the kill."
	case strings.Contains(raw, "Stopping timed out"):
		return "systemd killed what was still running in that scope."
	}
	return "systemd saw the kill in the scope that holds Claude's daemon and its sessions, and stopped the whole scope."
}

func sessionsWord(n int) string {
	if n == 1 {
		return "1 session"
	}
	return fmt.Sprintf("%d sessions", n)
}

// culprit is who the memory went to: the owner of the biggest process the kernel killed, or with
// no kill, whoever grew the most before the moment.
func culprit(rows []resources.Row, big *Kill, w *Watcher, at time.Time) *Culprit {
	var o *Owner
	if big != nil {
		o = w.ownerOf(*big)
	}
	key := ""
	if o != nil {
		key = o.Kind + "/" + o.Key
	} else {
		best := int64(0)
		low := map[string]int64{}
		for _, r := range rows {
			if r.T > at.Unix() {
				break
			}
			for _, g := range r.Groups {
				id := g.Kind + "/" + g.Key
				if v, ok := low[id]; !ok || g.Mem < v {
					low[id] = g.Mem
				}
				if grew := g.Mem - low[id]; grew > best {
					best, key = grew, id
				}
			}
		}
		if best < 1<<30 {
			return nil
		}
	}
	c := &Culprit{}
	if o != nil {
		c.Owner = *o
	}
	for _, r := range rows {
		if r.T > at.Unix() {
			break
		}
		for _, g := range r.Groups {
			if g.Kind+"/"+g.Key != key {
				continue
			}
			c.Kind, c.Key, c.Title = g.Kind, g.Key, cmp.Or(g.Title, c.Title)
			if g.Mem > c.Peak {
				c.Peak, c.PeakAt = g.Mem, time.Unix(r.T, 0)
				if len(g.Top) > 0 && c.Name == "" {
					c.Name = g.Top[0].Name
				}
			}
		}
	}
	if c.Key == "" {
		if o == nil {
			return nil
		}
		return c
	}
	c.From, c.FromAt = c.Peak, c.PeakAt
	for _, r := range rows {
		if r.T > c.PeakAt.Unix() {
			break
		}
		m := int64(0)
		for _, g := range r.Groups {
			if g.Kind+"/"+g.Key == key {
				m = g.Mem
			}
		}
		if m <= c.From {
			c.From, c.FromAt = m, time.Unix(r.T, 0)
		}
	}
	return c
}

// trim keeps the groups that matter in an incident's minutes: the biggest few and the culprit.
func trim(rows []resources.Row, c *Culprit) []resources.Row {
	peak := map[string]int64{}
	for _, r := range rows {
		for _, g := range r.Groups {
			peak[g.Kind+"/"+g.Key] = max(peak[g.Kind+"/"+g.Key], g.Mem)
		}
	}
	ids := make([]string, 0, len(peak))
	for id := range peak {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return peak[ids[i]] > peak[ids[j]] })
	keepID := map[string]bool{}
	for _, id := range ids[:min(maxGroups, len(ids))] {
		keepID[id] = true
	}
	if c != nil {
		keepID[c.Kind+"/"+c.Key] = true
	}
	out := make([]resources.Row, len(rows))
	for i, r := range rows {
		r.Groups = nil
		for _, g := range rows[i].Groups {
			if keepID[g.Kind+"/"+g.Key] {
				r.Groups = append(r.Groups, g)
			}
		}
		out[i] = r
	}
	return out
}

func (w *Watcher) tell(inc *Incident, big *Kill, peak resources.Row) (string, string) {
	var parts []string
	if c := inc.Culprit; c != nil && c.Title != "" && c.Peak-c.From >= 1<<30 && c.FromAt.Before(c.PeakAt) {
		parts = append(parts, fmt.Sprintf("“%s” went from %s at %s to %s at %s.", c.Title, little(c.From), clock(c.FromAt), gb(c.Peak), clock(c.PeakAt)))
	}
	if peak.T > 0 && peak.Total > 0 && peak.Mem >= peak.Total*97/100 {
		parts = append(parts, fmt.Sprintf("%s's %s of memory was full.", cmp.Or(w.Host, "The machine"), gb(peak.Total)))
	}
	if n := len(inc.Closed); n > 0 {
		parts = append(parts, fmt.Sprintf("Claude's daemon closed %s that were waiting, to free memory.", sessionsWord(n)))
	}
	if big == nil {
		return "Low memory: Claude closed waiting sessions", strings.Join(parts, " ")
	}
	what := big.Name
	if o := big.Owner; o != nil && o.Title != "" {
		what = fmt.Sprintf("%s in “%s”", big.Name, o.Title)
	}
	kill := fmt.Sprintf("At %s the kernel killed %s (%s)", clock(big.At), what, gb(big.RSS))
	if n := len(inc.Kills) - 1; n == 1 {
		kill += " and 1 more process"
	} else if n > 1 {
		kill += fmt.Sprintf(" and %d more processes", n)
	}
	if inc.DaemonDown {
		kill += ", and " + strings.TrimSuffix(downWith(inc.Scoped, ""), ", ")
	}
	parts = append(parts, kill+".")
	if n := len(inc.Lost); n > 0 {
		parts = append(parts, fmt.Sprintf("%s stopped.", sessionsWord(n)))
	}
	title := fmt.Sprintf("Out of memory: the kernel killed %s (%s)", big.Name, gb(big.RSS))
	return title, strings.Join(parts, " ")
}
