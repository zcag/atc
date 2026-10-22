package sessions

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
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
	Host           string    `json:"host,omitempty"`
	ID             string    `json:"id,omitempty"`
	Kind           string    `json:"kind"`
	State          string    `json:"state"`
	Attachable     bool      `json:"attachable"`
	PID            int       `json:"pid,omitempty"`
	Title          string    `json:"title"`
	Name           string    `json:"name,omitempty"`
	Cwd            string    `json:"cwd"`
	StartCwd       string    `json:"startCwd,omitempty"`
	Branch         string    `json:"branch,omitempty"`
	Model          string    `json:"model,omitempty"`
	PermissionMode string    `json:"permissionMode,omitempty"`
	LastPrompt     string    `json:"lastPrompt,omitempty"`
	Context        int       `json:"context,omitempty"`
	PromptAt       time.Time `json:"promptAt,omitzero"`
	Activity       string    `json:"activity,omitempty"`
	LastReply      string    `json:"lastReply,omitempty"`
	StartedAt      time.Time `json:"startedAt,omitzero"`
	Updated        time.Time `json:"updated,omitzero"`
	Servers        []int     `json:"servers,omitempty"`
	Pinned         bool      `json:"pinned,omitempty"`
	Parked         bool      `json:"parked,omitempty"`
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
		s.State, s.Attachable, s.PID = state(a), a.Kind == "background" && a.PID > 0, a.PID
		if s.State == NeedsYou && a.Kind == "background" && byID[a.SessionID].Pending == "" {
			s.State = YourTurn
		}
		s.Cwd = first(a.Cwd, s.Cwd)
		if a.StartedAt > 0 {
			s.StartedAt = time.UnixMilli(a.StartedAt)
		}
		meta := m.Store.Get(a.SessionID)
		s.Title = first(meta.Name, s.Title, a.Name, base(s.Cwd))
		s.Pinned, s.Parked = meta.Pinned, meta.Parked
		out = append(out, s)
	}
	Sort(out)
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
		PermissionMode: t.PermissionMode, LastPrompt: t.LastPrompt, Context: t.Context, PromptAt: t.PromptAt,
		Activity: t.Activity, LastReply: t.LastReply,
		Updated: t.Updated, Pinned: meta.Pinned, Parked: meta.Parked,
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

func Sort(list []Session) {
	sort.SliceStable(list, func(i, j int) bool { return less(list[i], list[j]) })
}

var rank = map[string]int{NeedsYou: 0, YourTurn: 1, Working: 2, Stopped: 4, Past: 5}

func group(s Session) int {
	if s.Parked && s.State != Past {
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
