package sessions

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/store"
)

const (
	NeedsYou = "needs-you"
	YourTurn = "your-turn"
	Working  = "working"
	Stopped  = "stopped"
	Past     = "past"
)

type Session struct {
	SessionID      string    `json:"sessionId"`
	ID             string    `json:"id,omitempty"`
	Kind           string    `json:"kind"`
	State          string    `json:"state"`
	Attachable     bool      `json:"attachable"`
	Title          string    `json:"title"`
	Name           string    `json:"name,omitempty"`
	Cwd            string    `json:"cwd"`
	StartCwd       string    `json:"startCwd,omitempty"`
	Branch         string    `json:"branch,omitempty"`
	Model          string    `json:"model,omitempty"`
	PermissionMode string    `json:"permissionMode,omitempty"`
	LastPrompt     string    `json:"lastPrompt,omitempty"`
	Context        int       `json:"context,omitempty"`
	StartedAt      time.Time `json:"startedAt,omitzero"`
	Updated        time.Time `json:"updated,omitzero"`
	Pinned         bool      `json:"pinned,omitempty"`
}

type Manager struct {
	CLI   claude.CLI
	Index *history.Index
	Store *store.Store
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
	out := make([]Session, 0, len(agents))
	for _, a := range agents {
		s := m.build(byID[a.SessionID])
		s.SessionID, s.ID, s.Kind, s.Name = a.SessionID, a.ID, a.Kind, a.Name
		s.State, s.Attachable = state(a), a.Kind == "background" && a.PID > 0
		s.Cwd = first(a.Cwd, s.Cwd)
		if a.StartedAt > 0 {
			s.StartedAt = time.UnixMilli(a.StartedAt)
		}
		s.Title = first(m.Store.Get(a.SessionID).Name, s.Title, a.Name, base(s.Cwd))
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return less(out[i], out[j]) })
	return out, nil
}

func (m *Manager) History(q, dir string, limit int) []Session {
	q = strings.ToLower(q)
	var out []Session
	for _, t := range m.Index.Scan() {
		s := m.build(t)
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
		Title: first(meta.Name, t.Title, t.AgentName, base(t.Cwd)), Name: t.AgentName,
		Cwd: t.Cwd, StartCwd: t.StartCwd, Branch: t.Branch, Model: t.Model,
		PermissionMode: t.PermissionMode, LastPrompt: t.LastPrompt, Context: t.Context,
		Updated: t.Updated, Pinned: meta.Pinned,
	}
}

func state(a claude.Agent) string {
	if a.Kind == "background" && a.PID == 0 {
		return Stopped
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

var rank = map[string]int{NeedsYou: 0, YourTurn: 1, Working: 2, Stopped: 3, Past: 4}

func less(a, b Session) bool {
	if a.Pinned != b.Pinned {
		return a.Pinned
	}
	if ra, rb := rank[a.State], rank[b.State]; ra != rb {
		return ra < rb
	}
	return a.Last().After(b.Last())
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
