package sessions

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"path/filepath"
	"regexp"
	"slices"
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
	Answered       *Answered        `json:"answered,omitempty"`
	Tabs           []browser.Tab    `json:"tabs,omitempty"`
	Pinned         bool             `json:"pinned,omitempty"`
	Parked         bool             `json:"parked,omitempty"`
	Agent          string           `json:"agent,omitempty"`
	Root           string           `json:"root,omitempty"`
	ReportsTo      string           `json:"reportsTo,omitempty"`
	Retired        bool             `json:"retired,omitempty"`
}

var retiredHub = regexp.MustCompile(`^(assistant|whatsapp) (\d\d-\d\d \d\d:\d\d|\(continued as [0-9a-f]+\))$`)

// RetiredHub is an earlier conversation of the assistant (or of WhatsApp before the hub took it
// over), named so when a newer one replaced it. Whatever is meant for it goes to the assistant.
func RetiredHub(name string) bool { return retiredHub.MatchString(name) }

func (s Session) Lineage() string { return cmp.Or(s.Root, s.SessionID) }

type Note struct {
	Text    string    `json:"text"`
	Urgent  bool      `json:"urgent,omitempty"`
	Replies []string  `json:"replies,omitempty"`
	Page    string    `json:"page,omitempty"`
	At      time.Time `json:"at"`
}

// Answered is the last answer atc passed to one of the session's asks: Via is where it was
// given (web, push, widget), Device the machine it was given on.
type Answered struct {
	Ask    string    `json:"ask"`
	Key    string    `json:"key,omitempty"`
	What   string    `json:"what"`
	Via    string    `json:"via,omitempty"`
	Device string    `json:"device,omitempty"`
	At     time.Time `json:"at"`
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
	ids := slices.Collect(maps.Keys(byID))
	for _, a := range agents {
		ids = append(ids, a.ID)
	}
	out := make([]Session, 0, len(agents))
	origin := map[string]string{}
	for _, a := range agents {
		if (resumed[a.SessionID] || m.carriedOn(a.SessionID, ids)) && a.PID == 0 {
			continue
		}
		t, ok := byID[a.SessionID]
		if !ok {
			t, ok = byID[m.Index.ForkedFrom(a.SessionID)]
		}
		if !ok && a.PID == 0 {
			continue
		}
		origin[a.SessionID] = t.Origin
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
		s.Pinned, s.Parked, s.Engine, s.Agent = meta.Pinned, meta.Parked, meta.Engine, meta.Agent
		s.Root, s.ReportsTo = m.lineage(a.SessionID)
		s.Retired = RetiredHub(meta.Name)
		out = append(out, s)
	}
	all := slices.Clone(out)
	out = slices.DeleteFunc(out, func(s Session) bool { return s.State == Stopped && copied(s, all, origin) })
	out = append(out, m.openCode(ctx)...)
	Sort(out)
	return out, nil
}

func copied(s Session, all []Session, origin map[string]string) bool {
	o := origin[s.SessionID]
	return o != "" && slices.ContainsFunc(all, func(x Session) bool {
		return x.SessionID != s.SessionID && origin[x.SessionID] == o &&
			(x.State != Stopped || x.Last().After(s.Last()) || x.Last().Equal(s.Last()) && x.SessionID > s.SessionID)
	})
}

func (m *Manager) carriedOn(sid string, ids []string) bool {
	next := m.Store.Get(sid).Next
	return next != "" && slices.ContainsFunc(ids, func(id string) bool { return strings.HasPrefix(id, next) })
}

func (m *Manager) History(q, dir string, limit int) []Session {
	q = strings.ToLower(q)
	var out []Session
	resumed := m.Index.Resumed()
	ts := m.transcripts()
	ids := make([]string, len(ts))
	for i, t := range ts {
		ids[i] = t.SessionID
	}
	for _, t := range ts {
		if resumed[t.SessionID] || m.carriedOn(t.SessionID, ids) {
			continue
		}
		s := m.build(t)
		if s.Agent != "" && q == "" {
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
		Updated: t.Updated, Pinned: meta.Pinned, Parked: meta.Parked, Engine: meta.Engine, Harness: t.Harness, Agent: meta.Agent,
		Retired: RetiredHub(meta.Name),
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
	if s.Away() && s.State != Past {
		return 3
	}
	return rank[s.State]
}

func less(a, b Session) bool {
	if pa, pb := a.Pinned && !a.Parked, b.Pinned && !b.Parked; pa != pb {
		return pa
	} else if pa {
		return a.StartedAt.Before(b.StartedAt)
	}
	if ga, gb := group(a), group(b); ga != gb {
		return ga < gb
	}
	return a.Last().After(b.Last())
}

// Away is parked and not asking anything: a parked session that needs you comes back.
func (s Session) Away() bool { return s.Parked && s.State != NeedsYou }

// Current is what the user's list shows by default: what needs them, and what runs or works and is not parked.
func (s Session) Current() bool {
	return s.State == NeedsYou || !s.Parked && (s.Attachable || s.State == Working)
}

// Result is what the last reply came to: its summary's status, else the reply itself.
func (s Session) Result() string {
	if s.Summary != nil && s.Summary.Status != "" {
		return s.Summary.Status
	}
	return s.LastReply
}

// Open is what the last reply's summary leaves open: its "Open:" lines.
func (s Session) Open() []string {
	if s.Summary == nil {
		return nil
	}
	var open []string
	for _, l := range s.Summary.Overview {
		if strings.HasPrefix(l, "Open:") {
			open = append(open, l)
		}
	}
	return open
}

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

func ClaudeAsk(id string, b claude.Block) opencode.Ask { return claudeAsk(id, b, nil) }

func claudeAsk(id string, b claude.Block, multi map[string]bool) (a opencode.Ask) {
	a = opencode.Ask{ID: "claude", SessionID: id}
	defer func() { a.Key = a.Fingerprint() }()
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
