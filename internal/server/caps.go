package server

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/caps"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/settings"
)

// CapsMachine is the list as one machine sees it.
type CapsMachine struct {
	Host          string     `json:"host"`
	Version       string     `json:"version,omitempty"`
	Rows          []caps.Row `json:"rows,omitempty"`
	Identity      Identity   `json:"identity"`
	Restart       []string   `json:"restart,omitempty"`
	RestartCmd    string     `json:"restartCommand,omitempty"`
	SettingsFile  string     `json:"settingsFile,omitempty"`
	SettingsError string     `json:"settingsError,omitempty"`
	Error         string     `json:"error,omitempty"`
}

type Identity struct {
	User      string `json:"user"`
	Assistant string `json:"assistant"`
	Language  string `json:"language"`
}

type CapsReport struct {
	Groups   []string      `json:"groups"`
	Machines []CapsMachine `json:"machines"`
}

func (s *Server) settings() *settings.Settings {
	return cmp.Or(s.Settings, &settings.Settings{Dir: s.StateDir})
}

func (s *Server) capsEnv(f settings.File) caps.Env {
	set := s.settings()
	env := caps.Env{
		Get:    func(k string) string { return set.Value(f, k) },
		Source: func(k string) string { return set.Source(f, k) },
		Bin:    s.M.CLI.Bin, Self: s.aloneAt,
	}
	for _, p := range s.Peers {
		env.Peers = append(env.Peers, caps.Peer{Name: p.Name, URL: p.URL, Token: p.Token})
	}
	for _, e := range s.Engines {
		env.Engines = append(env.Engines, caps.Engine{Name: e.Name, URL: e.URL})
	}
	for _, a := range s.localAgents() {
		env.Agents = append(env.Agents, caps.AgentFolder{Name: a.Name, Dir: a.dir(), Scheduled: a.Every != "" || a.Check != ""})
	}
	if s.Push != nil {
		for _, d := range s.Push.Devices() {
			env.Devices = append(env.Devices, d.Endpoint)
		}
		for _, d := range s.Push.Deaf(pushDeafAfter) {
			env.Deaf = append(env.Deaf, fmt.Sprintf("%s since %s", d.Name, d.Since.Format("15:04")))
		}
	}
	return env
}

func restartCommand(hub bool) string {
	if runtime.GOOS == "darwin" {
		return "launchctl kickstart -k gui/$(id -u)/io.github.zcag.atc"
	}
	if hub {
		return "systemctl --user restart atc atc-hub"
	}
	return "systemctl --user restart atc"
}

// restartNeeded says which services must restart for settings.json to take effect.
func (s *Server) restartNeeded(f settings.File) ([]string, string) {
	set := s.settings()
	pending := set.Pending(f)
	hub := set.IdentityChanged(f) || slices.ContainsFunc(pending, func(k string) bool {
		field, ok := caps.FieldOf(k)
		return ok && field.Hub
	})
	switch {
	case hub:
		return []string{"atc", "atc-hub"}, restartCommand(true)
	case len(pending) > 0:
		return []string{"atc"}, restartCommand(false)
	}
	return nil, ""
}

func (s *Server) capsHere(ctx context.Context, group string) CapsMachine {
	set := s.settings()
	f, err := set.Load()
	var pick func(caps.Cap) bool
	if group != "" {
		pick = func(c caps.Cap) bool { return strings.EqualFold(c.Group, group) }
	}
	m := CapsMachine{Host: s.Host, Version: s.Version, Rows: s.capsRunner.Rows(ctx, s.capsEnv(f), pick), SettingsFile: set.Path(),
		Identity: Identity{f.User, f.Assistant, f.Language}}
	m.Restart, m.RestartCmd = s.restartNeeded(f)
	if err != nil {
		m.SettingsError = set.Path() + " can't be read: " + err.Error()
	}
	return m
}

// CapsAlone is the list without a running server, for `atc doctor`: the same checks over the same files.
func CapsAlone(ctx context.Context, set *settings.Settings, host, version, bin, self string) CapsReport {
	s := &Server{Host: host, Version: version, Settings: set, aloneAt: self, M: &sessions.Manager{CLI: claude.CLI{Bin: bin}}}
	s.Peers, _ = LoadPeers(filepath.Join(set.Dir, "peers.json"))
	s.Engines, _ = LoadEngines(filepath.Join(set.Dir, "engines.json"))
	s.AgentsDir = cmp.Or(os.Getenv("ATC_AGENTS"), filepath.Join(set.Dir, "agents.d"))
	if _, err := os.Stat(filepath.Join(set.Dir, "devices.json")); err == nil {
		s.Push, _ = push.Open(filepath.Join(set.Dir, "devices.json"))
	}
	return CapsReport{caps.Groups, []CapsMachine{s.capsHere(ctx, "")}}
}

func (s *Server) capsList(w http.ResponseWriter, r *http.Request) {
	group := r.URL.Query().Get("group")
	if r.URL.Query().Get("fresh") != "" {
		s.capsRunner.Forget()
	}
	rep := CapsReport{caps.Groups, []CapsMachine{s.capsHere(r.Context(), group)}}
	if r.URL.Query().Get("local") != "" {
		reply(w, rep)
		return
	}
	far := make([]CapsMachine, len(s.Peers))
	var wg sync.WaitGroup
	for i, p := range s.Peers {
		wg.Go(func() {
			ctx, cancel := context.WithTimeout(r.Context(), caps.Timeout+2*time.Second)
			defer cancel()
			far[i].Host = p.Name
			var theirs CapsReport
			err := s.fleet.get(ctx, p, "/api/caps?local=1&group="+url.QueryEscape(group), &theirs)
			if err != nil {
				far[i].Error = "Can't reach " + p.Name + ": " + err.Error()
			} else if len(theirs.Machines) > 0 {
				far[i] = theirs.Machines[0]
				far[i].Host = p.Name
			}
		})
	}
	wg.Wait()
	rep.Machines = append(rep.Machines, far...)
	reply(w, rep)
}

func (s *Server) capsTest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Values map[string]string `json:"values"`
	}
	json.NewDecoder(r.Body).Decode(&in)
	for k, v := range in.Values {
		field, ok := caps.FieldOf(k)
		if !ok {
			http.Error(w, "no setting named "+k, http.StatusBadRequest)
			return
		}
		if v == "" && field.Secret {
			delete(in.Values, k)
		}
	}
	f, _ := s.settings().Load()
	row, ok := s.capsRunner.Test(r.Context(), s.capsEnv(f), r.PathValue("id"), in.Values)
	if !ok {
		http.Error(w, "no such row", http.StatusNotFound)
		return
	}
	reply(w, row)
}

// putSettings changes what is sent and keeps the rest: names when present, and in env a string sets a key and null
// removes it. Only settings in the registry can be written.
func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		User, Assistant, Language *string
		Env                       map[string]*string `json:"env"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	for k, v := range in.Env {
		field, ok := caps.FieldOf(k)
		if !ok {
			http.Error(w, "no setting named "+k, http.StatusBadRequest)
			return
		}
		if v != nil && field.URL && *v != "" {
			if u, err := url.Parse(strings.TrimSpace(*v)); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				http.Error(w, field.Label+" must be an http or https address", http.StatusBadRequest)
				return
			}
		}
	}
	set := s.settings()
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	f, err := set.Load()
	if err != nil {
		http.Error(w, set.Path()+" can't be read, so it was left alone: "+err.Error(), http.StatusConflict)
		return
	}
	for _, c := range []struct {
		from *string
		to   *string
	}{{in.User, &f.User}, {in.Assistant, &f.Assistant}, {in.Language, &f.Language}} {
		if c.from != nil {
			*c.to = strings.TrimSpace(*c.from)
		}
	}
	if f.Env == nil {
		f.Env = map[string]string{}
	}
	var overridden []string
	for k, v := range in.Env {
		if v == nil || strings.TrimSpace(*v) == "" {
			delete(f.Env, k)
		} else {
			f.Env[k] = strings.TrimSpace(*v)
		}
		if set.Source(f, k) == "env" {
			overridden = append(overridden, k)
		}
	}
	if err := set.Save(f); err != nil {
		fail(w, err)
		return
	}
	s.capsRunner.Forget()
	restart, cmd := s.restartNeeded(f)
	slices.Sort(overridden)
	reply(w, map[string]any{"saved": true, "restart": restart, "restartCommand": cmd, "overridden": overridden})
}
