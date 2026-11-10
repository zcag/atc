// Package ends says why a session stopped: who stopped it in atc, or what Claude's daemon log,
// the kernel and systemd recorded at the time, with each piece of evidence it rests on.
package ends

import (
	"bufio"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/resources"
)

type Owner = resources.Owner

// Causes.
const (
	You      = "you"
	Session  = "session"
	Atc      = "atc"
	CLI      = "cli"
	Outside  = "outside"
	Memory   = "memory"
	OOM      = "oom"
	Updated  = "updated"
	Daemon   = "daemon"
	Crashed  = "crashed"
	Exited   = "exited"
	Rebooted = "rebooted"
	Unknown  = "unknown"
)

// Sources of evidence.
const (
	SrcClaude    = "Claude's daemon log"
	SrcKernel    = "kernel log"
	SrcSystemd   = "systemd"
	SrcAtc       = "atc"
	SrcResources = "atc resources"
)

const (
	keep        = 8 * 24 * time.Hour
	poll        = 15 * time.Second
	stopWindow  = time.Minute
	downWindow  = 5 * time.Minute
	clusterGap  = 3 * time.Minute
	before      = 15 * time.Minute
	after       = 3 * time.Minute
	maxGroups   = 6
	recordsFile = "ends.jsonl"
)

type Line struct {
	At     time.Time `json:"at"`
	Source string    `json:"source"`
	Text   string    `json:"text"`
	Raw    string    `json:"raw,omitempty"`
}

type Ending struct {
	At       time.Time `json:"at"`
	Cause    string    `json:"cause"`
	Short    string    `json:"short"`
	Text     string    `json:"text"`
	Sure     bool      `json:"sure"`
	Incident string    `json:"incident,omitempty"`
	Evidence []Line    `json:"evidence,omitempty"`
}

type Lost struct {
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId,omitempty"`
	Title     string    `json:"title"`
	At        time.Time `json:"at"`
	Cause     string    `json:"cause"`
}

type Culprit struct {
	Owner
	Peak   int64     `json:"peak"`
	PeakAt time.Time `json:"peakAt,omitzero"`
	From   int64     `json:"from"`
	FromAt time.Time `json:"fromAt,omitzero"`
}

type Incident struct {
	ID         string          `json:"id"`
	At         time.Time       `json:"at"`
	Kind       string          `json:"kind"`
	Title      string          `json:"title"`
	Text       string          `json:"text"`
	Total      int64           `json:"total,omitempty"`
	Culprit    *Culprit        `json:"culprit,omitempty"`
	Kills      []Kill          `json:"kills,omitempty"`
	DaemonDown bool            `json:"daemonDown,omitempty"`
	Scoped     bool            `json:"scoped,omitempty"`
	Lost       []Lost          `json:"lost,omitempty"`
	Closed     []Lost          `json:"closed,omitempty"`
	Rows       []resources.Row `json:"rows,omitempty"`
	Evidence   []Line          `json:"evidence,omitempty"`
}

// Stop is atc stopping a session: By is who asked, Who the device or session, Why atc's own reason.
type Stop struct {
	At        time.Time `json:"at"`
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId,omitempty"`
	By        string    `json:"by"`
	Who       string    `json:"who,omitempty"`
	Why       string    `json:"why,omitempty"`
}

type record struct {
	Kind  string    `json:"kind"`
	At    time.Time `json:"at,omitzero"`
	Stop  *Stop     `json:"stop,omitempty"`
	Kill  *Kill     `json:"kill,omitempty"`
	Owner *Owner    `json:"owner,omitempty"`
}

type Watcher struct {
	Dir       string
	DaemonLog string
	Host      string
	Res       *resources.Sampler
	Title     func(id string) (title, sid string)

	mu        sync.Mutex
	offset    int64
	settles   map[string][]settle
	retires   map[string][]retire
	daemon    []daemonEvent
	kills     []Kill
	units     []unitLine
	stops     map[string][]Stop
	owners    map[string]Owner
	guessed   map[string]*Owner
	boot      time.Time
	journalAt time.Time
	since     time.Time
}

func New(dir, daemonLog, host string, res *resources.Sampler) *Watcher {
	return &Watcher{Dir: dir, DaemonLog: daemonLog, Host: host, Res: res,
		settles: map[string][]settle{}, retires: map[string][]retire{}, stops: map[string][]Stop{}, owners: map[string]Owner{}, guessed: map[string]*Owner{}}
}

func (w *Watcher) Run(ctx context.Context) {
	w.load()
	w.poll()
	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.poll()
		}
	}
}

func (w *Watcher) path() string { return filepath.Join(w.Dir, recordsFile) }

func (w *Watcher) load() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.boot = bootTime()
	f, err := os.Open(w.path())
	if err != nil {
		w.since = time.Now()
		w.write(record{Kind: "since", At: w.since})
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<16), 1<<20)
	for sc.Scan() {
		var r record
		if json.Unmarshal(sc.Bytes(), &r) != nil {
			continue
		}
		switch {
		case r.Kind == "since" && w.since.IsZero():
			w.since = r.At
		case r.Kind == "stop" && r.Stop != nil:
			w.stops[r.Stop.ID] = append(w.stops[r.Stop.ID], *r.Stop)
		case r.Kind == "kill" && r.Kill != nil && r.Owner != nil:
			w.owners[killKey(*r.Kill)] = *r.Owner
		}
	}
	if w.since.IsZero() {
		w.since = time.Now()
	}
}

func (w *Watcher) write(r record) {
	if w.Dir == "" {
		return
	}
	b, err := json.Marshal(r)
	if err != nil {
		return
	}
	os.MkdirAll(w.Dir, 0o755)
	f, err := os.OpenFile(w.path(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("ends: %v", err)
		return
	}
	defer f.Close()
	f.Write(append(b, '\n'))
}

func killKey(k Kill) string { return fmt.Sprintf("%d@%d", k.PID, k.At.Unix()) }

// Stopped records that atc stopped a session, and who asked.
func (w *Watcher) Stopped(s Stop) {
	if w == nil {
		return
	}
	s.ID = short(cmp.Or(s.ID, s.SessionID))
	if s.At.IsZero() {
		s.At = time.Now()
	}
	w.mu.Lock()
	w.stops[s.ID] = append(w.stops[s.ID], s)
	w.write(record{Kind: "stop", Stop: &s})
	w.mu.Unlock()
}

func (w *Watcher) poll() {
	from := w.journalAt
	if from.IsZero() {
		from = time.Now().Add(-keep)
	}
	now := time.Now()
	kills, units := kernelKills(from.Add(-2*time.Second)), unitLines(from.Add(-2*time.Second))
	w.mu.Lock()
	defer w.mu.Unlock()
	w.offset = w.readDaemon(w.DaemonLog, w.offset)
	for _, k := range kills {
		if slices.ContainsFunc(w.kills, func(x Kill) bool { return x.PID == k.PID && x.At.Sub(k.At).Abs() < time.Second }) {
			continue
		}
		if o, ok := w.owners[killKey(k)]; ok {
			k.Owner = &o
		} else if o, ok := w.Res.OwnerOf(k.PID); ok && now.Sub(k.At) < 2*time.Minute && o.Seen.Before(k.At.Add(time.Second)) {
			k.Owner = &o
			w.owners[killKey(k)] = o
			w.write(record{Kind: "kill", Kill: &Kill{At: k.At, PID: k.PID, Name: k.Name}, Owner: &o})
		}
		w.kills = append(w.kills, k)
	}
	for _, u := range units {
		if !slices.ContainsFunc(w.units, func(x unitLine) bool { return x.raw == u.raw && x.at.Equal(u.at) }) {
			w.units = append(w.units, u)
		}
	}
	w.journalAt = now
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// Ended is why a stopped session stopped, in short: no evidence, for a session row.
func (w *Watcher) Ended(id string, last time.Time) *Ending {
	if w == nil || id == "" {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	e := w.explain(short(id), last)
	e.Evidence = nil
	return &e
}

// Detail is why a stopped session stopped, with its evidence and the incident it was part of.
func (w *Watcher) Detail(id string, last time.Time) (*Ending, *Incident) {
	if w == nil || id == "" {
		return nil, nil
	}
	w.mu.Lock()
	e := w.explain(short(id), last)
	w.mu.Unlock()
	sort.SliceStable(e.Evidence, func(i, j int) bool { return e.Evidence[i].At.Before(e.Evidence[j].At) })
	if e.Incident == "" {
		return &e, nil
	}
	return &e, w.Incident(e.Incident)
}

func (w *Watcher) explain(id string, last time.Time) Ending {
	ss := w.settles[id]
	if len(ss) == 0 || ss[len(ss)-1].at.Before(last.Add(-time.Minute)) {
		if !w.boot.IsZero() && !last.IsZero() && last.Before(w.boot) {
			host := cmp.Or(w.Host, "This machine")
			return Ending{At: w.boot, Cause: Rebooted, Short: "machine restarted", Sure: true,
				Text: fmt.Sprintf("%s restarted at %s, after this session was last active at %s.", host, clock(w.boot), clock(last))}
		}
		return Ending{At: last, Cause: Unknown, Text: "Claude's daemon log has no line for how it ended."}
	}
	return w.explainSettle(id, ss[len(ss)-1])
}

func (w *Watcher) explainSettle(id string, st settle) Ending {
	e := Ending{At: st.at, Sure: true}
	end := Line{st.at, SrcClaude, fmt.Sprintf("The session's process ended (%s).", st.how), st.raw}
	if s, ok := w.stopNear(id, st.at); ok {
		w.byAtc(&e, s)
		e.Evidence = []Line{{s.At, SrcAtc, "atc was asked to stop it.", ""}, end}
		return e
	}
	if r, ok := w.retireNear(id, st.at); ok {
		e.Cause, e.Short, e.At = Memory, "closed for memory", r.at
		e.Text = fmt.Sprintf("Claude's daemon closed it at %s to free memory: memory stayed low after it closed everything else it could, and this session was waiting (%s).", clock(r.at), idleOf(r.why))
		e.Incident = w.incidentNear(r.at)
		e.Evidence = []Line{{r.at, SrcClaude, "The daemon closed it to free memory.", r.raw}, end}
		return e
	}
	if d, ok := w.downBefore(st.at); ok {
		e.Evidence = []Line{{d.at, SrcClaude, "Claude's daemon shut down.", d.raw}, end}
		if c := w.clusterAround(d.at); c != nil {
			k := c.biggest
			e.Cause, e.Short, e.At, e.Incident = OOM, "out of memory", k.At, incidentID(c.first)
			what := k.Name
			if o := w.ownerOf(k); o != nil && o.Kind == "session" && short(o.Key) == id {
				what = "this session's " + k.Name
			} else if o != nil && o.Title != "" {
				what = fmt.Sprintf("%s in “%s”", k.Name, o.Title)
			}
			e.Text = fmt.Sprintf("Out of memory at %s: the kernel killed %s (%s), and %s.", clock(k.At), what, gb(k.RSS), downWith(c.scoped, "this one included"))
			e.Evidence = append([]Line{{k.At, SrcKernel, fmt.Sprintf("The kernel killed %s (%s) for memory.", k.Name, gb(k.RSS)), strings.Join(k.Raw, "\n")}}, e.Evidence...)
			return e
		}
		if u, ok := w.upgradeBefore(d.at); ok {
			e.Cause, e.Short = Updated, "Claude updated"
			e.Text = fmt.Sprintf("Claude Code updated itself at %s (%s → %s), and this session did not come back after its daemon restarted.", clock(d.at), u.from, u.to)
			e.Evidence = append([]Line{{u.at, SrcClaude, "Claude Code's binary changed.", u.raw}}, e.Evidence...)
			return e
		}
		e.Cause, e.Short = Daemon, "Claude restarted"
		e.Text = fmt.Sprintf("Claude's daemon shut down at %s (%s), and this session went with it.", clock(d.at), downCause(d.cause))
		return e
	}
	if k, ok := w.ownKill(id, st.at); ok {
		e.Cause, e.Short, e.At, e.Incident = OOM, "out of memory", k.At, w.incidentNear(k.At)
		e.Text = fmt.Sprintf("Out of memory at %s: the kernel killed its %s process (%s).", clock(k.At), k.Name, gb(k.RSS))
		e.Evidence = []Line{{k.At, SrcKernel, "The kernel killed it for memory.", strings.Join(k.Raw, "\n")}, end}
		return e
	}
	e.Evidence = []Line{end}
	switch st.how {
	case "crashed":
		e.Cause, e.Short = Crashed, "crashed"
		e.Text = fmt.Sprintf("Claude crashed at %s.", clock(st.at))
	case "killed":
		if st.at.After(w.since) {
			e.Cause, e.Short = Outside, "stopped outside atc"
			e.Text = fmt.Sprintf("It was stopped outside atc at %s, with `claude stop` or by killing its process.", clock(st.at))
		} else {
			e.Cause, e.Short, e.Sure = Outside, "stopped", false
			e.Text = fmt.Sprintf("It was stopped at %s, from atc or with `claude stop`. atc only keeps who stopped a session since %s.", clock(st.at), clock(w.since))
		}
	default:
		e.Cause, e.Short = Exited, "ended on its own"
		e.Text = fmt.Sprintf("It ended on its own at %s: its Claude process exited, as it does after /exit.", clock(st.at))
	}
	return e
}

func (w *Watcher) byAtc(e *Ending, s Stop) {
	e.Cause = s.By
	switch s.By {
	case You:
		e.Short = "stopped by you"
		if s.Who != "" {
			e.Text = fmt.Sprintf("You stopped it at %s, from %s.", clock(s.At), s.Who)
		} else {
			e.Text = fmt.Sprintf("You stopped it in atc at %s.", clock(s.At))
		}
	case Session:
		e.Short = "stopped by “" + clip(s.Who, 28) + "”"
		e.Text = fmt.Sprintf("The session “%s” stopped it at %s.", s.Who, clock(s.At))
	case CLI:
		e.Short = "stopped with atc stop"
		e.Text = fmt.Sprintf("It was stopped with `atc stop` at %s.", clock(s.At))
	default:
		e.Cause, e.Short = Atc, "stopped by atc"
		e.Text = fmt.Sprintf("atc stopped it at %s: %s.", clock(s.At), cmp.Or(s.Why, "for its own reasons"))
	}
}

func (w *Watcher) stopNear(id string, t time.Time) (Stop, bool) {
	ss := w.stops[id]
	for i := len(ss) - 1; i >= 0; i-- {
		if d := t.Sub(ss[i].At); d >= -5*time.Second && d <= stopWindow {
			return ss[i], true
		}
	}
	return Stop{}, false
}

func (w *Watcher) retireNear(id string, t time.Time) (retire, bool) {
	rs := w.retires[id]
	for i := len(rs) - 1; i >= 0; i-- {
		if d := t.Sub(rs[i].at); d >= 0 && d <= 2*time.Minute {
			return rs[i], true
		}
	}
	return retire{}, false
}

func (w *Watcher) downBefore(t time.Time) (daemonEvent, bool) {
	for i := len(w.daemon) - 1; i >= 0; i-- {
		d := w.daemon[i]
		if d.kind == evDown && d.cause != "idle_exit" && t.Sub(d.at) >= -5*time.Second && t.Sub(d.at) <= downWindow {
			return d, true
		}
	}
	return daemonEvent{}, false
}

func (w *Watcher) upgradeBefore(t time.Time) (daemonEvent, bool) {
	for i := len(w.daemon) - 1; i >= 0; i-- {
		d := w.daemon[i]
		if d.kind == evUpgrade && t.Sub(d.at) >= 0 && t.Sub(d.at) <= 30*time.Second {
			return d, true
		}
	}
	return daemonEvent{}, false
}

func (w *Watcher) ownKill(id string, t time.Time) (Kill, bool) {
	for _, k := range w.kills {
		if d := t.Sub(k.At); d >= -5*time.Second && d <= time.Minute && k.Owner != nil && k.Owner.Kind == "session" && short(k.Owner.Key) == id {
			return k, true
		}
	}
	return Kill{}, false
}

type cluster struct {
	first   time.Time
	kills   []Kill
	biggest Kill
	scoped  bool
}

// clusters are the kernel's kills grouped by time: one memory crunch often kills several.
func (w *Watcher) clusters() []*cluster {
	ks := slices.Clone(w.kills)
	sort.Slice(ks, func(i, j int) bool { return ks[i].At.Before(ks[j].At) })
	var out []*cluster
	for _, k := range ks {
		if len(out) == 0 || k.At.Sub(out[len(out)-1].kills[len(out[len(out)-1].kills)-1].At) > clusterGap {
			out = append(out, &cluster{first: k.At})
		}
		c := out[len(out)-1]
		c.kills = append(c.kills, k)
		if k.RSS > c.biggest.RSS {
			c.biggest = k
		}
		if inClaude(k.Cgroup) {
			c.scoped = true
		}
	}
	return out
}

// inClaude is a cgroup Claude's daemon and its sessions run in: atc puts them in claude.slice.
func inClaude(cgroup string) bool {
	return strings.Contains(cgroup, "/claude.slice/") || strings.Contains(cgroup, "/claude-daemon-")
}

func (w *Watcher) clusterAround(t time.Time) *cluster {
	for _, c := range w.clusters() {
		if t.After(c.first.Add(-90*time.Second)) && t.Before(c.kills[len(c.kills)-1].At.Add(90*time.Second)) {
			return c
		}
	}
	return nil
}

// downWith says how Claude's daemon went down with a kill: systemd stops the whole unit when the
// killed process was in it (OOMPolicy=stop, which atc no longer sets), otherwise it only happened
// at the same moment.
func downWith(scoped bool, tail string) string {
	if scoped {
		return "systemd stopped Claude's daemon with every session in it, " + tail
	}
	return "Claude's daemon went down at the same moment with every session in it, " + tail
}

func incidentID(t time.Time) string { return "oom-" + strconv.FormatInt(t.Unix(), 10) }
func lowID(t time.Time) string      { return "low-" + strconv.FormatInt(t.Unix(), 10) }

// lowRuns are the daemon's low-memory warnings grouped by time, as first and last.
func (w *Watcher) lowRuns() [][2]time.Time {
	var out [][2]time.Time
	for _, d := range w.daemon {
		if d.kind != evLow {
			continue
		}
		if n := len(out); n > 0 && d.at.Sub(out[n-1][1]) < 10*time.Minute {
			out[n-1][1] = d.at
		} else {
			out = append(out, [2]time.Time{d.at, d.at})
		}
	}
	return out
}

// incidentNear is the memory incident a moment belongs to: the kernel's kills around it (memory
// usually runs low for minutes before the kernel steps in), or a run of the daemon's low-memory warnings.
func (w *Watcher) incidentNear(t time.Time) string {
	for _, c := range w.clusters() {
		if in(t, c.first.Add(-10*time.Minute), c.kills[len(c.kills)-1].At.Add(2*time.Minute)) {
			return incidentID(c.first)
		}
	}
	for _, r := range w.lowRuns() {
		if in(t, r[0], r[1].Add(3*time.Minute)) {
			return lowID(r[0])
		}
	}
	return ""
}

var idle = regexp.MustCompile(`idle \d+[smhd]`)

func idleOf(why string) string {
	if m := idle.FindString(why); m != "" {
		return m
	}
	return why
}

func downCause(c string) string {
	switch c {
	case "signal":
		return "it was sent a signal"
	case "upgrade":
		return "to update itself"
	}
	return strings.ReplaceAll(c, "_", " ")
}

func clock(t time.Time) string {
	if t.IsZero() {
		return "an unknown time"
	}
	now := time.Now()
	if y, m, d := t.Date(); y == now.Year() && m == now.Month() && d == now.Day() {
		return t.Format("15:04")
	}
	return t.Format("Jan 2 15:04")
}

func gb(n int64) string {
	if n >= 1<<30 {
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	}
	return fmt.Sprintf("%d MB", n>>20)
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
