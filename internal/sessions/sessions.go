package sessions

import (
	"cmp"
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/zcag/atc/internal/browser"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/summary"
)

const (
	NeedsYou = "needs-you"
	YourTurn = "your-turn"
	Working  = "working"
	Stopped  = "stopped"
	Past     = "past"
)

type Session struct {
	SessionID      string           `json:"sessionId"`
	Host           string           `json:"host,omitempty"`
	ID             string           `json:"id,omitempty"`
	Kind           string           `json:"kind"`
	State          string           `json:"state"`
	Attachable     bool             `json:"attachable"`
	PID            int              `json:"pid,omitempty"`
	Title          string           `json:"title"`
	Name           string           `json:"name,omitempty"`
	Cwd            string           `json:"cwd"`
	StartCwd       string           `json:"startCwd,omitempty"`
	Branch         string           `json:"branch,omitempty"`
	Model          string           `json:"model,omitempty"`
	Engine         string           `json:"engine,omitempty"`
	Harness        string           `json:"harness,omitempty"`
	Asks           []opencode.Ask   `json:"asks,omitempty"`
	Background     []claude.Task    `json:"background,omitempty"`
	TurnDone       bool             `json:"turnDone,omitempty"`
	PermissionMode string           `json:"permissionMode,omitempty"`
	LastPrompt     string           `json:"lastPrompt,omitempty"`
	Context        int              `json:"context,omitempty"`
	PromptAt       time.Time        `json:"promptAt,omitzero"`
	Activity       string           `json:"activity,omitempty"`
	Steps          int              `json:"steps,omitempty"`
	Failed         int              `json:"failed,omitempty"`
	Files          int              `json:"files,omitempty"`
	LastReply      string           `json:"lastReply,omitempty"`
	Summary        *summary.Summary `json:"summary,omitempty"`
	Summarizing    bool             `json:"summarizing,omitempty"`
	StartedAt      time.Time        `json:"startedAt,omitzero"`
	Updated        time.Time        `json:"updated,omitzero"`
	Servers        []int            `json:"servers,omitempty"`
	Shown          []pages.Page     `json:"shown,omitempty"`
	Note           *Note            `json:"note,omitempty"`
	Tabs           []browser.Tab    `json:"tabs,omitempty"`
	Pinned         bool             `json:"pinned,omitempty"`
	Parked         bool             `json:"parked,omitempty"`
	App            string           `json:"app,omitempty"`
	Root           string           `json:"root,omitempty"`
	ReportsTo      string           `json:"reportsTo,omitempty"`
}

func (s Session) Lineage() string { return cmp.Or(s.Root, s.SessionID) }

type Note struct {
	Text    string    `json:"text"`
	Urgent  bool      `json:"urgent,omitempty"`
	Replies []string  `json:"replies,omitempty"`
	At      time.Time `json:"at"`
}

type Manager struct {
	CLI     claude.CLI
	Index   *history.Index
	Store   *store.Store
	Summary *summary.Summarizer
	OC      *opencode.Backend
	Ports   outputs.Ports
}

func (m *Manager) Live(ctx context.Context) ([]Session, error) {
	agents, err := m.CLI.Agents(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]history.Transcript{}
	for _, t := range m.Index.Scan() {
		byID[t.SessionID] = t
	}
	resumed := m.Index.Resumed()
	out := make([]Session, 0, len(agents))
	for _, a := range agents {
		if resumed[a.SessionID] && a.PID == 0 {
			continue
		}
		t, ok := byID[a.SessionID]
		if !ok {
			t = byID[m.Index.ForkedFrom(a.SessionID)]
		}
		s := m.build(t)
		s.SessionID, s.ID, s.Kind, s.Name = a.SessionID, a.ID, a.Kind, a.Name
		s.State, s.Attachable, s.PID = state(a), a.Kind == "background" && a.PID > 0, a.PID
		if b := claude.Asking(a.ID); a.Kind == "background" && (len(b.Questions) > 0 || b.Approve != "") {
			s.State, s.Asks = NeedsYou, []opencode.Ask{claudeAsk(a.ID, b, history.LastAsk(t.Path))}
			s.Activity = s.Asks[0].Activity()
		} else if s.State == NeedsYou && a.Kind == "background" && byID[a.SessionID].Pending == "" {
			s.State = YourTurn
		}
		if a.Kind == "background" && a.PID > 0 {
			s.Background = claude.Background(a.ID)
		}
		if s.State == Working && t.Ended && a.Kind == "background" {
			if n := running(s.Background); n > 0 && !m.serving(a.PID, s.Background) {
				s.TurnDone, s.Activity = true, fmt.Sprintf("%d in the background", n)
			} else {
				s.State = YourTurn
			}
		}
		if s.State == Working && t.Path != "" {
			if turns, _, err := m.Index.Turns(t.Path); err == nil && len(turns) > 0 {
				last := turns[len(turns)-1]
				s.Steps, s.Failed, s.Files = last.Steps, last.Failed, len(last.Files)
			}
		}
		if s.State == YourTurn && s.Summary == nil {
			s.Summarizing = m.Summary.Want(byID[a.SessionID])
		}
		s.Cwd = first(a.Cwd, s.Cwd)
		if a.StartedAt > 0 {
			s.StartedAt = time.UnixMilli(a.StartedAt)
		}
		meta := m.Store.Get(a.SessionID)
		s.Title = first(meta.Name, s.Title, a.Name, base(s.Cwd))
		s.Pinned, s.Parked, s.Engine, s.App = meta.Pinned, meta.Parked, meta.Engine, meta.App
		s.Root, s.ReportsTo = m.lineage(a.SessionID)
		out = append(out, s)
	}
	out = append(out, m.openCode(ctx)...)
	Sort(out)
	return out, nil
}

func (m *Manager) History(q, dir string, limit int) []Session {
	q = strings.ToLower(q)
	var out []Session
	resumed := m.Index.Resumed()
	for _, t := range m.transcripts() {
		if resumed[t.SessionID] {
			continue
		}
		s := m.build(t)
		if s.App != "" && q == "" {
			continue
		}
		if dir != "" && s.StartCwd != dir && s.Cwd != dir {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(s.Title+" "+s.LastPrompt+" "+s.Cwd), q) {
			continue
		}
		out = append(out, s)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func (m *Manager) build(t history.Transcript) Session {
	meta := m.Store.Get(t.SessionID)
	return Session{
		SessionID: t.SessionID, Kind: "transcript", State: Past,
		Title: title(meta.Name, t), Name: t.AgentName,
		Cwd: t.Cwd, StartCwd: t.StartCwd, Branch: t.Branch, Model: t.Model,
		PermissionMode: t.PermissionMode, LastPrompt: t.LastPrompt, Context: t.Context, PromptAt: t.PromptAt,
		Activity: t.Activity, LastReply: t.LastReply, Summary: m.Summary.Get(t),
		Updated: t.Updated, Pinned: meta.Pinned, Parked: meta.Parked, Engine: meta.Engine, Harness: t.Harness, App: meta.App,
	}
}

func (m *Manager) lineage(sid string) (root, reportsTo string) {
	if root = m.Index.Original(sid); root == sid {
		root = ""
	}
	return root, m.Store.Get(cmp.Or(root, sid)).ReportsTo
}

func title(name string, t history.Transcript) string {
	return first(name, t.Title, t.AgentName, base(t.Cwd))
}

type Brief struct{ Title, Cwd string }

func (m *Manager) Briefs(want map[string]bool) map[string]Brief {
	out := map[string]Brief{}
	for _, t := range m.Index.Scan() {
		if want[t.SessionID] {
			out[t.SessionID] = Brief{title(m.Store.Get(t.SessionID).Name, t), t.Cwd}
		}
	}
	return out
}

func running(ts []claude.Task) (n int) {
	for _, t := range ts {
		if t.DoneAt == 0 {
			n++
		}
	}
	return n
}

func (m *Manager) serving(pid int, ts []claude.Task) bool {
	for _, t := range ts {
		if t.DoneAt == 0 && t.Kind != "shell" {
			return false
		}
	}
	return len(m.Ports.Serving(pid)) > 0
}

func state(a claude.Agent) string {
	if a.Kind == "background" && a.PID == 0 {
		return Stopped
	}
	if a.State == "working" && a.Status == "idle" {
		return YourTurn
	}
	switch first(a.State, a.Status) {
	case "working", "busy":
		return Working
	case "blocked", "waiting":
		return NeedsYou
	case "done", "idle":
		return YourTurn
	case "stopped":
		return Stopped
	}
	return first(a.State, a.Status)
}

func Sort(list []Session) {
	sort.SliceStable(list, func(i, j int) bool { return less(list[i], list[j]) })
}

var rank = map[string]int{NeedsYou: 0, YourTurn: 1, Working: 2, Stopped: 4, Past: 5}

func group(s Session) int {
	if (s.Parked || s.Hidden()) && s.State != Past {
		return 3
	}
	return rank[s.State]
}

func less(a, b Session) bool {
	if pa, pb := a.Pinned && !a.Parked, b.Pinned && !b.Parked; pa != pb {
		return pa
	}
	if ga, gb := group(a), group(b); ga != gb {
		return ga < gb
	}
	return a.Last().After(b.Last())
}

func (s Session) Hidden() bool { return s.App != "" && s.State != NeedsYou }

func (s Session) Last() time.Time {
	if s.Updated.After(s.StartedAt) {
		return s.Updated
	}
	return s.StartedAt
}

func (s Session) Age() string {
	t := s.Last()
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

var homeDir = regexp.MustCompile(`^/(home|Users)/[^/]+(/|$)`)

func Tilde(p, home string) string {
	switch {
	case p == "":
		return ""
	case home != "" && p == home:
		return "~"
	case home != "" && strings.HasPrefix(p, home+"/"):
		return "~/" + p[len(home)+1:]
	}
	if m := homeDir.FindString(p); m != "" {
		if rest := strings.TrimPrefix(p[len(m):], "/"); rest != "" {
			return "~/" + rest
		}
		return "~"
	}
	return p
}

func base(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Base(p)
}

func first(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

func claudeAsk(id string, b claude.Block, multi map[string]bool) opencode.Ask {
	a := opencode.Ask{ID: "claude", SessionID: id}
	if b.Approve != "" {
		tool, cmd, _ := strings.Cut(b.Approve, ": ")
		a.Permission, a.Patterns = tool, []string{cmd}
		return a
	}
	for _, q := range b.Questions {
		x := opencode.Question{Question: q.Question, Header: q.Header, Multiple: q.MultiSelect || multi[q.Question], Custom: true}
		for _, o := range q.Options {
			x.Options = append(x.Options, struct {
				Label       string `json:"label"`
				Description string `json:"description,omitempty"`
			}{o.Label, o.Description})
		}
		a.Questions = append(a.Questions, x)
	}
	return a
}

// Session is a conversation as its transcript shows it, for one atc runs outside Claude's own list.
func (m *Manager) Session(sid string) (Session, bool) {
	t, ok := m.Index.Find(sid)
	if !ok {
		return Session{}, false
	}
	return m.build(t), true
}
