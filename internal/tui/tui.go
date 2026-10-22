package tui

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/sahilm/fuzzy"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/sessions"
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
)

const rowH = 4

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
)

type model struct {
	c          *client.Client
	w, h       int
	history    bool
	live, past []sessions.Session
	cur, off   [2]int
	filter     string
	query      string
	seq        int
	in         input
	ti         textinput.Model
	confirm    string
	target     sessions.Session
	dirs       []client.Dir
	dirCur     int
	dir, name  string
	status     string
	err        string
	online     bool
	down       string
	want       string
	home       string
}

func Run(c *client.Client) error {
	home := c.ServerHome()
	ti := textinput.New()
	ti.Prompt = ""
	p := tea.NewProgram(model{c: c, ti: ti, home: home}, tea.WithAltScreen())
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

func (m model) Init() tea.Cmd { return tea.Batch(m.fetchLive(), tick()) }

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
		hay := strings.ToLower(s.Title + " " + s.Cwd + " " + s.Branch + " " + s.LastPrompt)
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

func (m *model) clamp() {
	t, n := m.tab(), len(m.rows())
	m.cur[t] = max(0, min(m.cur[t], n-1))
	vis := max(1, m.bodyH()/rowH)
	m.off[t] = max(0, min(m.off[t], m.cur[t], n-vis))
	if m.cur[t] >= m.off[t]+vis {
		m.off[t] = m.cur[t] - vis + 1
	}
}

func (m model) bodyH() int {
	h := m.h - 3
	if m.inputLine() {
		h--
	}
	return h
}

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
		m.status = s.Title + " runs in a terminal elsewhere, so it cannot be attached"
		return m, nil
	}
	m.status = "resuming " + s.Title + "…"
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
		m.online, m.down = false, msg.err.Error()
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
		m.dirs = msg.list
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
	if err == nil {
		return
	}
	m.err = err.Error()
	if strings.Contains(m.err, "not trusted") {
		m.err += " (run claude there once to trust it)"
	}
}

func (m model) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.String() == "ctrl+c" {
		return m, tea.Quit
	}
	if m.confirm != "" {
		act, s := m.confirm, m.target
		m.confirm = ""
		if k.String() != "y" {
			return m, nil
		}
		if act == "stop" {
			return m, m.do("stopped "+s.Title, func() error { return m.c.Stop(s.ID) })
		}
		return m, m.do("deleted "+s.Title, func() error { return m.c.Remove(s.ID) })
	}
	if m.in != noInput {
		return m.typing(k)
	}
	m.status, m.err = "", ""
	t := m.tab()
	s, ok := m.selected()
	switch k.String() {
	case "q":
		return m, tea.Quit
	case "up", "k":
		m.cur[t]--
	case "down", "j":
		m.cur[t]++
	case "pgup":
		m.cur[t] -= max(1, m.bodyH()/rowH)
	case "pgdown":
		m.cur[t] += max(1, m.bodyH()/rowH)
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
		m.dir, m.name, m.dirCur = "", "", 0
		cmd := m.edit(newDir, "", "type to filter, or a path like ~/src/app")
		return m, tea.Batch(cmd, func() tea.Msg { l, err := m.c.Dirs(); return dirsMsg{l, err} })
	case "enter":
		if ok {
			return m.open(s)
		}
	case "x", "d":
		switch {
		case !ok || m.history:
		case s.ID == "":
			m.status = s.Title + " runs in a terminal elsewhere; stop it there"
		case k.String() == "x" && !s.Attachable:
			m.status = s.Title + " is already stopped"
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
			verb := map[bool]string{true: "pinned ", false: "unpinned "}[!s.Pinned]
			return m, m.do(verb+s.Title, func() error { return m.c.Patch(s.SessionID, map[string]any{"pinned": !s.Pinned}) })
		}
	}
	m.clamp()
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
		}
		m.in = noInput
		m.clamp()
		return m, nil
	case "up", "down":
		d := map[string]int{"up": -1, "down": 1}[k.String()]
		if m.in == newDir {
			m.dirCur = max(0, min(m.dirCur+d, len(m.dirChoices())-1))
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
	case newDir:
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
		return m, m.do("renamed to "+v, func() error { return m.c.Patch(s.SessionID, map[string]any{"name": v}) })
	case newDir:
		ch := m.dirChoices()
		if m.dirCur >= len(ch) {
			return m, nil
		}
		m.dir = ch[m.dirCur]
		return m, m.edit(newName, "", "optional")
	case newName:
		m.name = v
		return m, m.edit(newPrompt, "", "optional, e.g. fix the failing test")
	case newPrompt:
		m.in = noInput
		dir, name := m.dir, m.name
		m.status = "starting a session in " + dir + "…"
		return m, func() tea.Msg {
			id, err := m.c.Start(dir, name, v)
			return doneMsg{status: "started " + id + " in " + dir, sel: id, err: err}
		}
	}
	m.in = noInput
	m.clamp()
	return m, nil
}

func (m model) tilde(p string) string {
	if p == m.home {
		return "~"
	}
	if rel, ok := strings.CutPrefix(p, m.home+"/"); ok && m.home != "" {
		return "~/" + rel
	}
	return p
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
		return append(out, paths...)
	}
	for _, f := range fuzzy.Find(q, paths) {
		if paths[f.Index] != q {
			out = append(out, paths[f.Index])
		}
	}
	return out
}

var (
	selBg  = lipgloss.AdaptiveColor{Light: "7", Dark: "0"}
	accent = lipgloss.Color("5")
	red    = lipgloss.Color("1")
	looks  = map[string]struct {
		glyph, word string
		color       lipgloss.TerminalColor
	}{
		sessions.NeedsYou: {"●", "needs you", red},
		sessions.YourTurn: {"○", "your turn", lipgloss.Color("3")},
		sessions.Working:  {"◐", "working", lipgloss.Color("4")},
		sessions.Stopped:  {"◌", "stopped", lipgloss.NoColor{}},
		sessions.Past:     {"·", "past", lipgloss.NoColor{}},
	}
	plain = lipgloss.NewStyle()
	dim   = plain.Faint(true)
	bold  = plain.Bold(true)
)

func elapsed(d time.Duration) string {
	if d < time.Hour {
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

func short(model string) string {
	l := strings.ToLower(model)
	for _, f := range []string{"opus", "sonnet", "haiku", "fable"} {
		if strings.Contains(l, f) {
			return f
		}
	}
	return strings.TrimPrefix(l, "claude-")
}

func (m model) row(s sessions.Session, sel bool) []string {
	st := func(base lipgloss.Style) lipgloss.Style {
		if sel {
			return base.Background(selBg)
		}
		return base
	}
	look, ok := looks[s.State]
	if !ok {
		look = looks[sessions.Past]
		look.word = s.State
	}
	state := look.glyph + " " + look.word
	if s.State == sessions.Working && !s.PromptAt.IsZero() {
		state += " " + elapsed(time.Since(s.PromptAt))
	}
	stateSt := st(plain.Foreground(look.color))
	if s.State == sessions.Stopped || s.State == sessions.Past {
		stateSt = st(dim)
	}
	bar := st(plain).Render("  ")
	if sel {
		bar = st(plain.Foreground(accent)).Render("▌ ")
	}
	const stateW = 18
	indent := bar + st(plain).Render(strings.Repeat(" ", stateW))
	age := s.Age()
	titleW := max(8, m.w-2-stateW-len(age)-2)

	var meta []string
	meta = append(meta, st(dim).Render(m.tilde(s.Cwd)))
	if s.Branch != "" && s.Branch != "HEAD" {
		meta = append(meta, st(dim).Render(s.Branch))
	}
	if s.Model != "" {
		meta = append(meta, st(dim).Render(short(s.Model)))
	}
	if s.PermissionMode == "bypassPermissions" {
		meta = append(meta, st(plain.Foreground(red)).Render("bypass"))
	}
	if s.Kind == "interactive" {
		meta = append(meta, st(dim).Render("in a terminal"))
	}
	if s.Pinned {
		meta = append(meta, st(plain.Foreground(accent)).Render("pinned"))
	}
	prompt := ""
	if s.LastPrompt != "" {
		prompt = "“" + strings.Join(strings.Fields(s.LastPrompt), " ") + "”"
	}
	lines := []string{
		bar + stateSt.Render(ansi.Truncate(fmt.Sprintf("%-*s", stateW, state), stateW, "")) +
			st(bold).Render(ansi.Truncate(s.Title, titleW, "…")),
		indent + strings.Join(meta, st(dim).Render(" · ")),
		indent + st(dim).Render(ansi.Truncate(prompt, max(8, m.w-2-stateW-1), "…")),
	}
	for i, l := range lines {
		l = ansi.Truncate(l, m.w, "")
		right := ""
		if i == 0 {
			right = st(dim).Render(age + " ")
		}
		lines[i] = l + st(plain).Render(strings.Repeat(" ", max(0, m.w-lipgloss.Width(l)-lipgloss.Width(right)))) + right
	}
	return append(lines, "")
}

func (m model) header() string {
	tab := func(name string, on bool) string {
		if on {
			return plain.Bold(true).Underline(true).Foreground(accent).Render(name)
		}
		return dim.Render(name)
	}
	host := m.c.URL[strings.Index(m.c.URL, "//")+2:]
	left := " " + bold.Render("atc") + " " + dim.Render(host) + "   " +
		tab(fmt.Sprintf("Live %d", len(m.live)), !m.history) + "  " + tab("History", m.history)
	counts := map[string]int{}
	for _, s := range m.live {
		counts[s.State]++
	}
	var right []string
	if n := counts[sessions.NeedsYou]; n > 0 {
		right = append(right, plain.Foreground(red).Bold(true).Render(fmt.Sprintf("%d need you", n)))
	}
	if n := counts[sessions.YourTurn]; n > 0 {
		right = append(right, plain.Foreground(looks[sessions.YourTurn].color).Render(fmt.Sprintf("%d your turn", n)))
	}
	if n := counts[sessions.Working]; n > 0 {
		right = append(right, plain.Foreground(looks[sessions.Working].color).Render(fmt.Sprintf("%d working", n)))
	}
	if !m.online {
		right = append(right, plain.Foreground(red).Render("offline"))
	}
	r := strings.Join(right, dim.Render(" · ")) + " "
	return left + strings.Repeat(" ", max(1, m.w-lipgloss.Width(left)-lipgloss.Width(r))) + r
}

func (m model) footer() string {
	var keys [][2]string
	switch {
	case m.in != noInput:
		keys = [][2]string{{"↵", "ok"}, {"esc", "cancel"}}
		if m.in == newDir || m.in == filtering || m.in == searching {
			keys = append(keys, [2]string{"↑↓", "choose"})
		}
	case m.history:
		keys = [][2]string{{"↵", "open"}, {"/", "search"}, {"h", "live"}, {"r", "rename"}, {"p", "pin"}, {"q", "quit"}}
	default:
		keys = [][2]string{{"↵", "attach"}, {"n", "new"}, {"/", "filter"}, {"h", "history"}, {"x", "stop"},
			{"d", "delete"}, {"r", "rename"}, {"p", "pin"}, {"q", "quit"}}
	}
	var parts []string
	for _, k := range keys {
		parts = append(parts, bold.Render(k[0])+" "+dim.Render(k[1]))
	}
	return " " + strings.Join(parts, "  ")
}

func (m model) message() string {
	switch {
	case m.confirm != "":
		return plain.Foreground(red).Render(" "+m.confirm+" "+m.target.Title+"? ") + bold.Render("y") + dim.Render("/n")
	case m.err != "":
		return plain.Foreground(red).Render(" " + m.err)
	case m.status != "":
		return " " + m.status
	case m.down != "":
		return plain.Foreground(red).Render(" " + m.down + ", reconnecting…")
	}
	return ""
}

func (m model) newView() []string {
	field := func(label, val string, active bool) string {
		if active {
			return "  " + bold.Render(fmt.Sprintf("%-8s", label)) + m.ti.View()
		}
		return "  " + dim.Render(fmt.Sprintf("%-8s", label)) + val
	}
	out := []string{"", "  " + bold.Render("New session"), "",
		field("dir", m.dir, m.in == newDir)}
	if m.in == newDir {
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
			if i == m.dirCur {
				out = append(out, plain.Foreground(accent).Render("  ▌ ")+bold.Render(ch[i])+tag)
			} else {
				out = append(out, "    "+ch[i]+tag)
			}
		}
		return out
	}
	out = append(out, field("name", m.name, m.in == newName))
	if m.in == newPrompt {
		out = append(out, field("prompt", "", true))
	}
	return out
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
		out = append(out, plain.Foreground(accent).Render(label)+val)
	}
	var body []string
	switch {
	case m.in == newDir || m.in == newName || m.in == newPrompt:
		body = m.newView()
	case len(m.rows()) == 0:
		msg := "no sessions. n starts one"
		if m.history {
			msg = "no past conversations match"
		} else if m.filter != "" {
			msg = "nothing matches the filter"
		}
		body = []string{"", "  " + dim.Render(msg)}
	default:
		t, rows := m.tab(), m.rows()
		for i := m.off[t]; i < len(rows) && len(body)+rowH <= m.bodyH(); i++ {
			body = append(body, m.row(rows[i], i == m.cur[t])...)
		}
	}
	for len(body) < m.bodyH() {
		body = append(body, "")
	}
	out = append(out, body[:max(0, m.bodyH())]...)
	out = append(out, ansi.Truncate(m.message(), m.w, "…"), ansi.Truncate(m.footer(), m.w, ""))
	return strings.Join(out, "\n")
}
