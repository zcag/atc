package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/sahilm/fuzzy"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/report"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/usage"
	"github.com/zcag/atc/internal/when"
)

type input int

const (
	noInput input = iota
	filtering
	searching
	renaming
	newDir
	newName
	newPrompt
	newHost
)

const rowH = 2

type (
	liveMsg  []sessions.Session
	downMsg  struct{ err error }
	tickMsg  struct{}
	debounce int
	histMsg  struct {
		seq  int
		list []sessions.Session
		err  error
	}
	dirsMsg struct {
		list []client.Dir
		err  error
	}
	doneMsg struct {
		status, sel string
		err         error
		refresh     bool
	}
	resumedMsg struct {
		id, title string
		err       error
	}
	limitsMsg usage.Limits
	limitsDue struct{}
	panelMsg  struct {
		key   string
		lines []string
		err   error
	}
)

type panel struct {
	key, title string
	lines      []string
	err        string
	off        int
}

type model struct {
	c           *client.Client
	w, h        int
	history     bool
	live, past  []sessions.Session
	cur, off    [2]int
	filter      string
	query       string
	seq         int
	in          input
	ti          textinput.Model
	confirm     string
	target      sessions.Session
	dirs        []client.Dir
	dirsLoading bool
	dirCur      int
	dir, name   string
	status      string
	err         string
	online      bool
	down        string
	downSince   time.Time
	want        string
	home        string
	hosts       []string
	host        string
	limits      usage.Limits
	panel       *panel
	keys        bool
}

func Run(c *client.Client) error {
	me := c.Me()
	ti := textinput.New()
	ti.Prompt = ""
	p := tea.NewProgram(model{c: c, ti: ti, home: me.Home, hosts: me.Hosts}, tea.WithAltScreen())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go subscribe(ctx, c, p)
	_, err := p.Run()
	return err
}

func subscribe(ctx context.Context, c *client.Client, p *tea.Program) {
	wait := time.Second
	for {
		start := time.Now()
		err := c.Events(ctx, func(l []sessions.Session) { p.Send(liveMsg(l)) })
		if ctx.Err() != nil {
			return
		}
		p.Send(downMsg{err})
		if time.Since(start) > time.Minute {
			wait = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, 30*time.Second)
	}
}

func tick() tea.Cmd { return tea.Tick(time.Second, func(time.Time) tea.Msg { return tickMsg{} }) }

func (m model) Init() tea.Cmd { return tea.Batch(m.fetchLive(), m.fetchLimits(), tick()) }

func (m model) fetchLimits() tea.Cmd {
	return func() tea.Msg {
		l, _ := m.c.Limits()
		return limitsMsg(l)
	}
}

func (m model) openPanel(key, title string, load func() ([]string, error)) (model, tea.Cmd) {
	m.panel = &panel{key: key, title: title}
	return m, func() tea.Msg {
		lines, err := load()
		return panelMsg{key, lines, err}
	}
}

func (m model) panelLines() []string {
	p := m.panel
	if p.err != "" {
		return []string{plain.Foreground(failC).Render(p.err)}
	}
	if p.lines == nil {
		return []string{dim.Render("Loading…")}
	}
	w := max(10, m.w-4)
	var out []string
	for _, l := range p.lines {
		body := strings.TrimLeft(l, " ")
		if !strings.Contains(body, " ") {
			out = append(out, ansi.Truncate(l, w, "…"))
			continue
		}
		pad := l[:len(l)-len(body)]
		for _, part := range strings.Split(ansi.Wordwrap(body, w-len(pad), " "), "\n") {
			out = append(out, pad+part)
		}
	}
	return out
}

func (m model) fetchLive() tea.Cmd {
	return func() tea.Msg {
		l, err := m.c.Live()
		if err != nil {
			return downMsg{err}
		}
		return liveMsg(l)
	}
}

func (m model) fetchPast() tea.Cmd {
	seq, q := m.seq, m.query
	return func() tea.Msg {
		l, err := m.c.History(q, "", 100)
		return histMsg{seq, l, err}
	}
}

func (m model) do(status string, f func() error) tea.Cmd {
	return func() tea.Msg { return doneMsg{status: status, err: f()} }
}

func (m model) rows() []sessions.Session {
	if m.history {
		out := slices.Clone(m.past)
		for i, p := range out {
			for _, l := range m.live {
				if l.SessionID == p.SessionID {
					out[i] = l
				}
			}
		}
		return out
	}
	if m.filter == "" {
		return m.live
	}
	var out []sessions.Session
	for _, s := range m.live {
		hay := strings.ToLower(s.Title + " " + s.Cwd + " " + s.Branch + " " + s.LastPrompt + " " + s.Host)
		ok := true
		for _, w := range strings.Fields(strings.ToLower(m.filter)) {
			ok = ok && strings.Contains(hay, w)
		}
		if ok {
			out = append(out, s)
		}
	}
	return out
}

func (m model) tab() int {
	if m.history {
		return 1
	}
	return 0
}

func (m model) selected() (sessions.Session, bool) {
	r := m.rows()
	if c := m.cur[m.tab()]; c < len(r) {
		return r[c], true
	}
	return sessions.Session{}, false
}

func groupOf(s sessions.Session) string {
	switch {
	case s.Pinned && !s.Parked:
		return "Pinned"
	case s.Away() && s.State != sessions.Past:
		return "Parked"
	case s.State == sessions.NeedsYou:
		return "Waiting on you"
	case s.State == sessions.YourTurn:
		return "Your turn"
	case s.State == sessions.Working:
		return "Working"
	case s.State == sessions.Stopped:
		return "Stopped"
	}
	return "Past"
}

func (m model) heads(rows []sessions.Session) []bool {
	out := make([]bool, len(rows))
	if m.history {
		return out
	}
	for i := range rows {
		out[i] = i == 0 || groupOf(rows[i]) != groupOf(rows[i-1])
	}
	return out
}

func (m model) layout(rows []sessions.Session) (top, start []int, total int) {
	total = 1
	for i, head := range m.heads(rows) {
		top = append(top, total)
		if head {
			if i > 0 {
				total++
			}
			total++
		}
		start = append(start, total)
		total += rowH
	}
	return top, start, total
}

func (m *model) clamp() {
	t, rows := m.tab(), m.rows()
	m.cur[t] = max(0, min(m.cur[t], len(rows)-1))
	if len(rows) == 0 {
		m.off[t] = 0
		return
	}
	top, start, total := m.layout(rows)
	h, c := max(1, m.bodyH()), m.cur[t]
	m.off[t] = min(m.off[t], top[c])
	if c == 0 {
		m.off[t] = 0
	}
	if end := start[c] + rowH; end > m.off[t]+h {
		m.off[t] = end - h
	}
	m.off[t] = max(0, min(m.off[t], total-h))
}

func (m model) bodyH() int {
	h := m.h - 3
	if m.inputLine() {
		h--
	}
	return h
}

func (m model) page() int { return max(1, m.bodyH()/(rowH+1)) }

func (m model) inputLine() bool {
	return m.in == filtering || m.in == searching || m.in == renaming ||
		(!m.history && m.filter != "") || (m.history && m.query != "")
}

func (m *model) edit(in input, val, placeholder string) tea.Cmd {
	m.in = in
	m.ti.SetValue(val)
	m.ti.Placeholder = placeholder
	m.ti.CursorEnd()
	return m.ti.Focus()
}

func (m model) attach(id, title string) tea.Cmd {
	a := &attachExec{c: m.c, id: id, title: title}
	return tea.Exec(a, func(err error) tea.Msg { return doneMsg{status: a.status, err: err, refresh: true} })
}

type attachExec struct {
	c                 *client.Client
	id, title, status string
}

func (a *attachExec) Run() error {
	if err := a.c.Attach(a.id); err != nil {
		return err
	}
	a.status = a.c.Detached(a.id, a.title)
	return nil
}

func (a *attachExec) SetStdin(io.Reader)  {}
func (a *attachExec) SetStdout(io.Writer) {}
func (a *attachExec) SetStderr(io.Writer) {}

func (m model) open(s sessions.Session) (model, tea.Cmd) {
	switch {
	case s.Attachable:
		return m, m.attach(s.ID, s.Title)
	case s.Kind == "interactive":
		m.status = s.Title + " runs in a terminal elsewhere, so it can't be attached."
		return m, nil
	}
	m.status = "Resuming " + s.Title + "…"
	return m, func() tea.Msg {
		id, err := m.c.Resume(s.SessionID)
		return resumedMsg{id, s.Title, err}
	}
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.ti.Width = max(10, m.w-12)
	case tickMsg:
		return m, tick()
	case limitsMsg:
		m.limits = usage.Limits(msg)
		return m, tea.Tick(2*time.Minute, func(time.Time) tea.Msg { return limitsDue{} })
	case limitsDue:
		return m, m.fetchLimits()
	case panelMsg:
		if m.panel != nil && m.panel.key == msg.key {
			m.panel.lines = msg.lines
			if msg.err != nil {
				m.panel.err = m.readable(msg.err)
			}
		}
		return m, nil
	case liveMsg:
		prev, _ := m.selected()
		m.live, m.online, m.down = msg, true, ""
		for _, s := range m.live {
			if m.want != "" && s.ID == m.want {
				prev, m.want, m.filter = s, "", ""
			}
		}
		for i, s := range m.rows() {
			if !m.history && s.SessionID == prev.SessionID {
				m.cur[0] = i
			}
		}
	case downMsg:
		if m.online || m.downSince.IsZero() {
			m.downSince = time.Now()
		}
		m.online, m.down = false, "the connection closed"
		if msg.err != nil {
			m.down = m.readable(msg.err)
		}
	case debounce:
		if int(msg) == m.seq {
			return m, m.fetchPast()
		}
	case histMsg:
		if msg.seq == m.seq {
			m.past = msg.list
			m.setErr(msg.err)
		}
	case dirsMsg:
		m.dirs, m.dirsLoading = msg.list, false
		m.setErr(msg.err)
	case resumedMsg:
		m.status = ""
		if m.setErr(msg.err); msg.err != nil {
			return m, nil
		}
		return m, m.attach(msg.id, msg.title)
	case doneMsg:
		m.status = msg.status
		m.setErr(msg.err)
		if msg.sel != "" {
			m.want = msg.sel
		}
		var cmds []tea.Cmd
		if msg.refresh {
			cmds = append(cmds, m.fetchLive())
		}
		if m.history {
			cmds = append(cmds, m.fetchPast())
		}
		return m, tea.Batch(cmds...)
	case tea.KeyMsg:
		return m.key(msg)
	}
	m.clamp()
	return m, nil
}

func (m *model) setErr(err error) {
	m.err = ""
	if err != nil {
		m.err = m.readable(err)
	}
}

func (m model) server() string { return m.c.URL[strings.Index(m.c.URL, "//")+2:] }

func (m model) readable(err error) string {
	var dns *net.DNSError
	var op *net.OpError
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "atc isn't answering at " + m.server()
	case errors.As(err, &dns):
		return "can't find " + dns.Name
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded):
		return m.server() + " didn't answer in time"
	case errors.As(err, &op):
		return "can't reach " + m.server()
	case strings.HasPrefix(err.Error(), "401 ") || strings.HasPrefix(err.Error(), "events: 401"):
		return "atc refused this machine's token; atc login again"
	}
	return err.Error()
}

func (m model) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.String() == "ctrl+c" {
		return m, tea.Quit
	}
	if m.keys {
		if s := k.String(); s == "?" || s == "esc" || s == "q" {
			m.keys = false
		}
		return m, nil
	}
	if m.confirm != "" {
		act, s := m.confirm, m.target
		m.confirm = ""
		if k.String() != "y" {
			m.status = map[string]string{"stop": "Left " + s.Title + " running.", "delete": "Kept " + s.Title + "."}[act]
			return m, nil
		}
		if act == "stop" {
			return m, m.do("Stopped "+s.Title+".", func() error { return m.c.Stop(s.ID, "you", "atc in a terminal") })
		}
		return m, m.do("Deleted "+s.Title+".", func() error { return m.c.Remove(s.ID) })
	}
	if m.in != noInput {
		return m.typing(k)
	}
	if m.panel != nil {
		return m.panelKey(k)
	}
	m.status, m.err = "", ""
	t := m.tab()
	s, ok := m.selected()
	switch k.String() {
	case "?":
		m.keys = true
		return m, nil
	case "u":
		if ok {
			return m.openPanel("u"+s.SessionID, "Usage: "+s.Title, func() ([]string, error) {
				st, err := m.c.SessionUsage(s.SessionID)
				return report.Session(st, m.c.WeekRate()), err
			})
		}
	case "U":
		return m.openPanel("U", "Plan usage", func() ([]string, error) {
			l, err := m.c.Limits()
			if err != nil {
				return nil, err
			}
			days, err := m.c.Days(14)
			return report.Plan(l, days, m.c.WeekRate(), time.Now()), err
		})
	case "o":
		if ok {
			return m.openPanel("o"+s.SessionID, "Outputs: "+s.Title, func() ([]string, error) {
				o, err := m.c.Outputs(s.SessionID)
				lines := report.Outputs(o, s.Host, time.Now())
				if len(o.Files) > 0 {
					lines = append(lines, "", "atc outputs "+s.SessionID[:min(8, len(s.SessionID))]+" prints the full links, to open a file in a browser.")
				}
				return lines, err
			})
		}
	case "q":
		return m, tea.Quit
	case "up", "k":
		m.cur[t]--
	case "down", "j":
		m.cur[t]++
	case "pgup":
		m.cur[t] -= m.page()
	case "pgdown":
		m.cur[t] += m.page()
	case "home", "g":
		m.cur[t] = 0
	case "end", "G":
		m.cur[t] = len(m.rows())
	case "tab", "h":
		m.history = !m.history
		if m.history {
			m.seq++
			m.clamp()
			return m, m.fetchPast()
		}
	case "/":
		if m.history {
			return m, m.edit(searching, m.query, "search past conversations")
		}
		return m, m.edit(filtering, m.filter, "filter")
	case "esc":
		if m.history && m.query != "" {
			m.query, m.seq = "", m.seq+1
			return m, m.fetchPast()
		}
		m.filter = ""
	case "n":
		m.dir, m.name, m.host, m.dirCur, m.dirs = "", "", "", 0, nil
		if len(m.hosts) > 1 {
			return m, m.edit(newHost, "", "which machine")
		}
		return m, m.pickDir()
	case "enter":
		if ok {
			return m.open(s)
		}
	case "x", "d":
		switch {
		case !ok || m.history:
		case s.ID == "":
			m.status = s.Title + " runs in a terminal elsewhere; stop it there."
		case k.String() == "x" && !s.Attachable:
			m.status = s.Title + " is already stopped."
		default:
			m.confirm, m.target = map[string]string{"x": "stop", "d": "delete"}[k.String()], s
		}
	case "r":
		if ok {
			m.target = s
			return m, m.edit(renaming, s.Title, "name")
		}
	case "p":
		if ok {
			verb := map[bool]string{true: "Pinned ", false: "Unpinned "}[!s.Pinned]
			return m, m.do(verb+s.Title+".", func() error { return m.c.Patch(s.SessionID, map[string]any{"pinned": !s.Pinned}) })
		}
	case "z":
		if ok {
			verb := map[bool]string{true: "Parked ", false: "Unparked "}[!s.Parked]
			return m, m.do(verb+s.Title+".", func() error { return m.c.Patch(s.SessionID, map[string]any{"parked": !s.Parked}) })
		}
	}
	m.clamp()
	return m, nil
}

func (m model) panelKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	p := *m.panel
	page := max(1, m.bodyH()-3)
	switch k.String() {
	case "esc", "q", "u", "U", "o", "left":
		m.panel = nil
		return m, nil
	case "up", "k":
		p.off--
	case "down", "j":
		p.off++
	case "pgup", "b":
		p.off -= page
	case "pgdown", " ", "f":
		p.off += page
	case "home", "g":
		p.off = 0
	case "end", "G":
		p.off = len(m.panelLines())
	}
	p.off = max(0, min(p.off, len(m.panelLines())-page))
	m.panel = &p
	return m, nil
}

func (m model) wizard() bool {
	return m.in == newHost || m.in == newDir || m.in == newName || m.in == newPrompt
}

func (m model) back() (model, tea.Cmd) {
	switch m.in {
	case newPrompt:
		return m, m.edit(newName, m.name, "optional")
	case newName:
		cmd := m.edit(newDir, m.dir, "type to filter, or a path like ~/src/app")
		m.dirCur = 0
		return m, cmd
	case newDir:
		if len(m.hosts) > 1 {
			m.dirCur = 0
			return m, m.edit(newHost, m.host, "which machine")
		}
	}
	m.in = noInput
	m.status = "No new session."
	return m, nil
}

func (m model) typing(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "esc":
		switch m.in {
		case filtering:
			m.filter = ""
		case searching:
			m.query, m.seq = "", m.seq+1
			m.in = noInput
			return m, m.fetchPast()
		case newHost, newDir, newName, newPrompt:
			return m.back()
		}
		m.in = noInput
		m.clamp()
		return m, nil
	case "up", "down":
		d := map[string]int{"up": -1, "down": 1}[k.String()]
		if m.in == newDir {
			m.dirCur = max(0, min(m.dirCur+d, len(m.dirChoices())-1))
		} else if m.in == newHost {
			m.dirCur = max(0, min(m.dirCur+d, len(m.hostChoices())-1))
		} else if m.in == filtering || m.in == searching {
			m.cur[m.tab()] += d
			m.clamp()
		}
		return m, nil
	case "enter":
		return m.submit()
	}
	var cmd tea.Cmd
	m.ti, cmd = m.ti.Update(k)
	switch m.in {
	case filtering:
		m.filter = m.ti.Value()
	case searching:
		if m.query != m.ti.Value() {
			m.query, m.seq = m.ti.Value(), m.seq+1
			seq := m.seq
			cmd = tea.Batch(cmd, tea.Tick(200*time.Millisecond, func(time.Time) tea.Msg { return debounce(seq) }))
		}
	case newDir, newHost:
		m.dirCur = 0
	}
	m.clamp()
	return m, cmd
}

func (m model) submit() (tea.Model, tea.Cmd) {
	v := strings.TrimSpace(m.ti.Value())
	switch m.in {
	case renaming:
		m.in = noInput
		s := m.target
		return m, m.do(renamed(s.Title, v), func() error { return m.c.Patch(s.SessionID, map[string]any{"name": v}) })
	case newHost:
		ch := m.hostChoices()
		if m.dirCur >= len(ch) {
			return m, nil
		}
		m.host = ch[m.dirCur]
		return m, m.pickDir()
	case newDir:
		ch := m.dirChoices()
		if m.dirCur >= len(ch) {
			return m, nil
		}
		m.dir = ch[m.dirCur]
		return m, m.edit(newName, m.name, "optional")
	case newName:
		m.name = v
		return m, m.edit(newPrompt, "", "optional, e.g. fix the failing test")
	case newPrompt:
		m.in = noInput
		dir, name, host := m.dir, m.name, m.host
		where := dir
		if host != "" {
			where = host + ":" + dir
		}
		m.status = "Starting a session in " + where + "…"
		return m, func() tea.Msg {
			id, err := m.c.StartOn(host, dir, name, v, false)
			return doneMsg{status: "Started " + id + " in " + where + ".", sel: id, err: err}
		}
	}
	m.in = noInput
	m.clamp()
	return m, nil
}

func renamed(from, to string) string {
	if to == "" {
		return from + " has Claude's own title again."
	}
	return "Renamed " + from + " to " + to + "."
}

func (m model) tilde(p string) string { return sessions.Tilde(p, m.home) }

func (m *model) pickDir() tea.Cmd {
	m.dirCur, m.dirsLoading = 0, true
	host := m.host
	return tea.Batch(m.edit(newDir, m.dir, "type to filter, or a path like ~/src/app"),
		func() tea.Msg { l, err := m.c.Dirs(host); return dirsMsg{l, err} })
}

func (m model) hostChoices() []string {
	q := strings.ToLower(strings.TrimSpace(m.ti.Value()))
	var out []string
	for _, h := range m.hosts {
		if strings.Contains(strings.ToLower(h), q) {
			out = append(out, h)
		}
	}
	return out
}

func (m model) dirChoices() []string {
	q := strings.TrimSpace(m.ti.Value())
	paths := make([]string, len(m.dirs))
	for i, d := range m.dirs {
		paths[i] = m.tilde(d.Path)
	}
	var out []string
	if strings.HasPrefix(q, "/") || strings.HasPrefix(q, "~") {
		out = append(out, q)
	}
	if q == "" {
		out = []string{"~"}
		for _, p := range paths {
			if p != "~" {
				out = append(out, p)
			}
		}
		return out
	}
	for _, f := range fuzzy.Find(q, paths) {
		if paths[f.Index] != q {
			out = append(out, paths[f.Index])
		}
	}
	return out
}

type badge struct {
	letter string
	style  lipgloss.Style
	text   lipgloss.TerminalColor
}

var (
	selBg  = lipgloss.AdaptiveColor{Light: "254", Dark: "236"}
	accent = lipgloss.AdaptiveColor{Light: "24", Dark: "110"}
	failC  = lipgloss.AdaptiveColor{Light: "124", Dark: "203"}
	needsC = lipgloss.AdaptiveColor{Light: "130", Dark: "214"}
	workC  = lipgloss.AdaptiveColor{Light: "24", Dark: "153"}
	plain  = lipgloss.NewStyle()
	dim    = plain.Faint(true)
	bold   = plain.Bold(true)
	badges = map[string]badge{
		sessions.NeedsYou: {"N", bold.Background(lipgloss.Color("214")).Foreground(lipgloss.Color("235")), needsC},
		sessions.Working:  {"W", bold.Background(lipgloss.AdaptiveColor{Light: "153", Dark: "24"}).Foreground(workC), workC},
		sessions.YourTurn: {"T", bold.Background(lipgloss.AdaptiveColor{Light: "252", Dark: "238"}).Foreground(lipgloss.AdaptiveColor{Light: "235", Dark: "255"}), lipgloss.NoColor{}},
		sessions.Stopped:  {"E", dim, lipgloss.NoColor{}},
		sessions.Past:     {"E", dim, lipgloss.NoColor{}},
	}
)

func badgeOf(s sessions.Session) badge {
	if b, ok := badges[s.State]; ok {
		return b
	}
	return badges[sessions.Past]
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func (m model) several() bool { return len(m.hosts) > 1 }

func (m model) said(s sessions.Session) (string, bool) {
	switch {
	case s.State == sessions.NeedsYou && len(s.Asks) > 0:
		if says := s.Asks[0].Says(); says != "" {
			return says, true
		}
	case s.State == sessions.Working && s.Activity != "":
		return s.Activity, false
	case s.State != sessions.Working && s.Result() != "":
		return strings.Join(strings.Fields(s.Result()), " "), false
	}
	if s.State == sessions.NeedsYou && s.Activity != "" {
		return s.Activity, true
	}
	if s.LastPrompt != "" {
		return "“" + strings.Join(strings.Fields(s.LastPrompt), " ") + "”", false
	}
	return "", false
}

func (m model) row(s sessions.Session, sel bool) []string {
	st := func(base lipgloss.Style) lipgloss.Style {
		if sel {
			return base.Background(selBg)
		}
		return base
	}
	b := badgeOf(s)
	away := s.Away()
	letter := b.style.Render(" " + b.letter + " ")
	if away {
		letter = st(dim).Render(" " + b.letter + " ")
	}
	place := s.Bay()
	if s.Branch != "" && s.Branch != "HEAD" {
		place = strings.TrimPrefix(place+" · "+s.Branch, " · ")
	}
	age := fmt.Sprintf("%3s", s.Age())
	if m.history {
		age = when.Stamp(s.Last(), time.Now())
	}
	right := func(place string) string {
		var parts []string
		if s.Host != "" && m.several() {
			parts = append(parts, s.Host)
		}
		if place != "" {
			parts = append(parts, place)
		}
		return strings.Join(append(parts, age), "  ") + " "
	}
	r1 := right(place)
	if m.w-5-lipgloss.Width(r1) < 24 {
		r1 = right("")
	}
	titleSt := st(bold)
	if away {
		titleSt = st(dim)
	}
	gap := st(plain).Render(" ")
	line1 := st(plain).Render(" ") + letter + gap + titleSt.Render(ansi.Truncate(s.Title, max(4, m.w-6-lipgloss.Width(r1)), "…"))

	text, loud := m.said(s)
	var tags []string
	if s.State == sessions.Working && !s.PromptAt.IsZero() {
		tags = append(tags, when.Duration(time.Since(s.PromptAt)))
	}
	if s.Kind == "interactive" {
		tags = append(tags, "in a terminal")
	}
	if s.Agent != "" {
		tags = append(tags, "@"+s.Agent)
	}
	if s.Profile != "" {
		tags = append(tags, s.Profile)
	}
	if s.Pinned {
		tags = append(tags, "pinned")
	}
	if s.Parked {
		tags = append(tags, "parked")
	}
	r2 := ""
	if len(tags) > 0 {
		r2 = strings.Join(tags, " · ") + " "
	}
	textSt := st(dim)
	if loud && !away {
		textSt = st(plain)
	}
	line2 := st(plain).Render("     ") + textSt.Render(ansi.Truncate(text, max(4, m.w-6-lipgloss.Width(r2)), "…"))

	fill := func(l, right string) string {
		l = ansi.Truncate(l, m.w, "")
		r := st(dim).Render(right)
		return l + st(plain).Render(strings.Repeat(" ", max(0, m.w-lipgloss.Width(l)-lipgloss.Width(r)))) + r
	}
	return []string{fill(line1, r1), fill(line2, r2)}
}

func (m model) groupHead(name string, rows []sessions.Session) string {
	n := 0
	for _, s := range rows {
		if groupOf(s) == name {
			n++
		}
	}
	st := bold
	switch name {
	case "Waiting on you":
		st = bold.Foreground(needsC)
	case "Working":
		st = bold.Foreground(workC)
	}
	return " " + st.Render(name) + " " + dim.Render(fmt.Sprint(n))
}

func (m model) header() string {
	tab := func(name string, on bool) string {
		if on {
			return plain.Bold(true).Underline(true).Render(name)
		}
		return dim.Render(name)
	}
	where := m.server()
	if m.several() {
		where = strings.Join(m.hosts, " + ")
	}
	left := " " + bold.Render("atc") + " " + dim.Render(where) + "   " +
		tab(fmt.Sprintf("Live %d", len(m.live)), !m.history) + "  " + tab("History", m.history)
	counts := map[string]int{}
	for _, s := range m.live {
		if !s.Away() {
			counts[s.State]++
		}
	}
	var right []string
	if n := counts[sessions.NeedsYou]; n > 0 {
		right = append(right, bold.Foreground(needsC).Render(map[bool]string{true: "1 needs you", false: fmt.Sprintf("%d need you", n)}[n == 1]))
	}
	if n := counts[sessions.YourTurn]; n > 0 {
		right = append(right, fmt.Sprintf("%d your turn", n))
	}
	if n := counts[sessions.Working]; n > 0 {
		right = append(right, plain.Foreground(workC).Render(fmt.Sprintf("%d working", n)))
	}
	switch {
	case !m.online && m.down != "":
		right = append(right, plain.Foreground(failC).Render("offline"))
	case !m.online:
		right = append(right, dim.Render("connecting…"))
	}
	r := strings.Join(right, dim.Render(" · ")) + " "
	for len(right) > 0 && lipgloss.Width(left)+lipgloss.Width(r) > m.w {
		right = right[:len(right)-1]
		r = strings.Join(right, dim.Render(" · ")) + " "
	}
	return left + strings.Repeat(" ", max(1, m.w-lipgloss.Width(left)-lipgloss.Width(r))) + r
}

var allKeys = [][2]string{
	{"enter", "attach"}, {"n", "new session"},
	{"/", "filter"}, {"x", "stop"},
	{"h", "history"}, {"r", "rename"},
	{"p", "pin"}, {"z", "park"},
	{"d", "delete"}, {"o", "outputs"},
	{"u", "usage"}, {"U", "plan usage"},
	{"j k", "move"}, {"g G", "top, bottom"},
	{"pgup pgdn", "page"}, {"tab", "live, history"},
	{"esc", "clear filter"}, {"q", "quit"},
}

func (m model) footer() (string, string) {
	var keys [][2]string
	switch {
	case m.keys:
		keys = [][2]string{{"?", "close"}}
	case m.panel != nil:
		keys = [][2]string{{"↑↓", "scroll"}, {"esc", "back"}}
	case m.wizard():
		keys = [][2]string{{"enter", "next"}, {"esc", "back"}}
		if (m.in == newDir && len(m.hosts) <= 1) || m.in == newHost {
			keys[1][1] = "cancel"
		}
		if m.in == newDir || m.in == newHost {
			keys = append(keys, [2]string{"↑↓", "choose"})
		}
		if m.in == newPrompt {
			keys[0][1] = "start"
		}
	case m.in != noInput:
		keys = [][2]string{{"enter", "ok"}, {"esc", "cancel"}}
		if m.in == filtering || m.in == searching {
			keys = append(keys, [2]string{"↑↓", "move"})
		}
	case m.history:
		keys = [][2]string{{"enter", "open"}, {"/", "search"}, {"h", "live"}, {"r", "rename"}, {"?", "keys"}}
	default:
		keys = [][2]string{{"enter", "attach"}, {"n", "new"}, {"/", "filter"}, {"x", "stop"}, {"?", "keys"}}
	}
	var parts []string
	for _, k := range keys {
		parts = append(parts, bold.Render(k[0])+" "+dim.Render(k[1]))
	}
	return " " + strings.Join(parts, "  "), report.LimitsShort(m.limits.Windows, time.Now())
}

func (m model) footerLine() string {
	keys, lim := m.footer()
	if lim == "" || lipgloss.Width(keys)+len(lim)+3 > m.w {
		return ansi.Truncate(keys, m.w, "")
	}
	return keys + strings.Repeat(" ", m.w-lipgloss.Width(keys)-lipgloss.Width(lim)-1) + dim.Render(lim) + " "
}

func (m model) message() string {
	switch {
	case m.confirm != "":
		return " " + bold.Render(strings.ToUpper(m.confirm[:1])+m.confirm[1:]+" "+m.target.Title+"?") + " " + bold.Render("y") + dim.Render("/n")
	case m.err != "":
		return plain.Foreground(failC).Render(" " + upper(m.err) + ".")
	case m.status != "":
		return " " + m.status
	case m.down != "":
		return plain.Foreground(failC).Render(fmt.Sprintf(" Offline since %s: %s. Trying again…", when.Today(m.downSince, time.Now()), m.down))
	}
	return ""
}

func upper(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + strings.TrimSuffix(s[1:], ".")
}

func (m model) newView() []string {
	field := func(label, val string, active bool) string {
		if active {
			return "  " + bold.Render(fmt.Sprintf("%-9s", label)) + m.ti.View()
		}
		return "  " + dim.Render(fmt.Sprintf("%-9s", label)) + val
	}
	choice := func(text string, on bool) string {
		if on {
			return plain.Foreground(accent).Render("  ▌ ") + bold.Render(text)
		}
		return "    " + text
	}
	out := []string{"", "  " + bold.Render("New session"), ""}
	if len(m.hosts) > 1 {
		out = append(out, field("machine", m.host, m.in == newHost))
	}
	if m.in == newHost {
		for i, h := range m.hostChoices() {
			out = append(out, choice(h, i == m.dirCur))
		}
		return out
	}
	out = append(out, field("folder", m.dir, m.in == newDir))
	if m.in == newDir {
		if m.dirsLoading {
			return append(out, "    "+dim.Render("Loading folders…"))
		}
		recent := map[string]bool{}
		for _, d := range m.dirs {
			recent[m.tilde(d.Path)] = d.Recent
		}
		ch := m.dirChoices()
		vis := max(1, m.bodyH()-len(out)-1)
		start := max(0, m.dirCur-vis+1)
		for i := start; i < min(len(ch), start+vis); i++ {
			tag := ""
			if recent[ch[i]] {
				tag = dim.Render("  recent")
			}
			out = append(out, choice(ch[i], i == m.dirCur)+tag)
		}
		return out
	}
	out = append(out, field("name", m.name, m.in == newName))
	if m.in == newPrompt {
		out = append(out, field("prompt", "", true))
	}
	return out
}

func (m model) keysBox() []string {
	widths := func(ks [][2]string) (kw, lw int) {
		for _, k := range ks {
			kw, lw = max(kw, len(k[0])), max(lw, len(k[1]))
		}
		return
	}
	var left, right [][2]string
	for i, k := range allKeys {
		if i%2 == 0 {
			left = append(left, k)
		} else {
			right = append(right, k)
		}
	}
	lk, ll := widths(left)
	rk, rl := widths(right)
	cell := func(k [2]string, kw, lw int) string {
		return bold.Render(fmt.Sprintf("%*s", kw, k[0])) + "  " + fmt.Sprintf("%-*s", lw, k[1])
	}
	note := "? or esc closes."
	var lines []string
	if inner := lk + ll + rk + rl + 7; inner+6 <= m.w {
		for i := range left {
			l := cell(left[i], lk, ll)
			if i < len(right) {
				l += "   " + cell(right[i], rk, rl)
			}
			lines = append(lines, l)
		}
	} else {
		kw, lw := widths(allKeys)
		for _, k := range allKeys {
			lines = append(lines, cell(k, kw, lw))
		}
	}
	inner := len(note)
	for _, l := range lines {
		inner = max(inner, lipgloss.Width(l))
	}
	line := func(s string) string {
		return "  │ " + s + strings.Repeat(" ", max(0, inner-lipgloss.Width(s))) + " │"
	}
	out := []string{"", "  ┌─ " + bold.Render("Keys") + " " + strings.Repeat("─", max(0, inner-5)) + "┐"}
	for _, l := range lines {
		out = append(out, line(l))
	}
	return append(out, line(""), line(dim.Render(note)), "  └"+strings.Repeat("─", inner+2)+"┘")
}

func (m model) View() string {
	if m.w == 0 {
		return ""
	}
	out := []string{m.header()}
	if m.inputLine() {
		label := map[bool]string{true: " search ", false: " filter "}[m.history]
		val := map[bool]string{true: m.query, false: m.filter}[m.history]
		if m.in == renaming {
			label = " rename "
		}
		if m.in == filtering || m.in == searching || m.in == renaming {
			val = m.ti.View()
		}
		out = append(out, bold.Render(label)+val)
	}
	var body []string
	switch {
	case m.keys:
		body = m.keysBox()
	case m.panel != nil:
		body = append([]string{"", "  " + bold.Render(ansi.Truncate(m.panel.title, m.w-4, "…")), ""}, m.panelLines()[m.panel.off:]...)
		for i := 3; i < len(body); i++ {
			body[i] = "  " + body[i]
		}
	case m.wizard():
		body = m.newView()
	case len(m.rows()) == 0:
		msg := "No sessions. n starts one."
		if m.history {
			msg = "No past conversations match."
		} else if m.filter != "" {
			msg = "Nothing matches the filter."
		}
		body = []string{"", "  " + dim.Render(msg)}
	default:
		t, rows := m.tab(), m.rows()
		heads := m.heads(rows)
		all := []string{""}
		for i, s := range rows {
			if heads[i] {
				if i > 0 {
					all = append(all, "")
				}
				all = append(all, m.groupHead(groupOf(s), rows))
			}
			all = append(all, m.row(s, i == m.cur[t])...)
		}
		body = all[min(m.off[t], len(all)):]
	}
	for len(body) < m.bodyH() {
		body = append(body, "")
	}
	out = append(out, body[:max(0, m.bodyH())]...)
	out = append(out, ansi.Truncate(m.message(), m.w, "…"), m.footerLine())
	return strings.Join(out, "\n")
}
