package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/settings"
	"github.com/zcag/atc/internal/store"
)

// A line is an agent's conversation while the user talks to it on a call (see hub/lines.go): the hub runs it,
// so here it looks and routes like the hub's other conversations, and once the line is gone it goes back to
// being a background session.

// links is every conversation the hub runs now.
func (s *Server) links() []*hubLink {
	out := []*hubLink{s.hub, s.guests}
	s.linesMu.Lock()
	defer s.linesMu.Unlock()
	for _, l := range s.lines {
		out = append(out, l)
	}
	return out
}

func (s *Server) lineTo(agent string) *hubLink {
	s.linesMu.Lock()
	defer s.linesMu.Unlock()
	return s.lines[agent]
}

// watchLines keeps the links in step with what the hub holds. Asking is what makes this survive either side
// restarting: a line atc doesn't know yet is linked, a line that is gone (the call ended, the hub restarted)
// goes back to the background.
func (s *Server) watchLines() {
	for range time.Tick(2 * time.Second) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		open, err := s.Hub.Lines(ctx)
		cancel()
		if err != nil {
			continue
		}
		s.syncLines(open)
	}
}

func (s *Server) syncLines(open []hub.Line) {
	s.linesMu.Lock()
	if s.lines == nil {
		s.lines = map[string]*hubLink{}
	}
	var gone []*hubLink
	for name, l := range s.lines {
		if !slices.ContainsFunc(open, func(o hub.Line) bool { return o.Name == name }) {
			gone = append(gone, l)
			delete(s.lines, name)
		}
	}
	for _, o := range open {
		if s.lines[o.Name] == nil {
			l := s.newHubLink(o.Name, hub.NewClient(s.Hub.URL+"/lines/"+o.Name), "")
			l.path = ""
			l.ctx, l.cancel = context.WithCancel(context.Background())
			s.lines[o.Name] = l
			go s.watchHub(l, func(hub.Event) {})
			log.Printf("agent %s: on the line", o.Name)
		}
	}
	s.linesMu.Unlock()
	for _, l := range gone {
		l.cancel()
		go s.lineOver(l)
	}
	if len(gone) > 0 {
		s.refresh()
	}
}

// lineOver has the agent's conversation run in the background again, as it did before the call.
func (s *Server) lineOver(l *hubLink) {
	a, ok := s.agentNamed(l.name)
	if !ok {
		return
	}
	mu := s.agentLock(a.Name)
	mu.Lock()
	defer mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	sid := l.session()
	if sid == "" || !s.hasTranscript(sid) {
		return
	}
	if _, err := s.resumeAgent(ctx, a, sid); err != nil {
		log.Printf("agent %s: back to the background: %v", a.Name, err)
	}
}

// agentLine is the hub asking for an agent's conversation to put on a call. An agent in the middle of
// something stays where it is: the answer says what it is doing, and the talker tells the one on the line.
func (s *Server) agentLine(w http.ResponseWriter, r *http.Request) {
	a, ok := s.agentNamed(r.PathValue("name"))
	if !ok {
		lineRefused(w, http.StatusNotFound, map[string]string{"why": "unknown", "error": "no agent named " + r.PathValue("name") + " on " + s.Host})
		return
	}
	if !a.Talk {
		lineRefused(w, http.StatusForbidden, map[string]string{"why": "off", "title": a.label(), "error": a.label() + " has no \"talk\": true in its agent.json"})
		return
	}
	mu := s.agentLock(a.Name)
	mu.Lock()
	defer mu.Unlock()
	live, err := s.M.Live(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	cur := agentSession(live, a.Name)
	sid := ""
	if cur != nil && cur.Kind != "hub" {
		if cur.State == sessions.Working || cur.State == sessions.NeedsYou {
			lineRefused(w, http.StatusConflict, map[string]string{"why": "busy", "title": a.label(), "state": cur.State,
				"activity": cur.Activity})
			return
		}
		if cur.Attachable {
			log.Printf("agent %s: stopping %s, it goes on the line", a.Name, cur.ID)
			if err := s.stopFor(r.Context(), cur.ID, "the agent went on a call"); err != nil {
				fail(w, err)
				return
			}
		}
	}
	if cur != nil && s.hasTranscript(cur.SessionID) {
		sid = cur.SessionID
	} else if t, ok := s.lastAgentTranscript(a.Name); ok {
		sid = t.SessionID
	}
	if sid == "" {
		sid = hub.NewID()
	}
	s.M.Store.Update(sid, func(m *store.Meta) { m.Agent, m.Name, m.Parked = a.Name, a.label(), false })
	args, err := a.args()
	if err != nil {
		fail(w, err)
		return
	}
	args = append(slices.Clone(s.M.CLI.Args), args...)
	if !slices.Contains(args, "--effort") {
		args = append(args, "--effort", "medium")
	}
	args = append(args, "--disallowedTools", "AskUserQuestion,EnterPlanMode")
	if !slices.Contains(args, skipPermissions) {
		args = append(args, a.autonomyOnLine(os.Getenv(settings.AutonomyKey))...)
	}
	home, _ := os.UserHomeDir()
	s.refresh()
	reply(w, map[string]any{"session": sid, "dir": existingDir(a.dir(), home), "args": args,
		"name": a.Name, "title": a.label(), "icon": a.Icon, "color": a.Color, "person": a.Person, "background": a.Background, "voices": personVoices(a.Person)})
}

func lineRefused(w http.ResponseWriter, code int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}

// personVoices is the voices of the person an agent sounds like, by language; none means the assistant's.
func personVoices(id string) map[string]string {
	if id == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(client.ConfigDir(), "persons.json"))
	if err != nil {
		return nil
	}
	type person struct {
		ID     string            `json:"id"`
		Voices map[string]string `json:"voices"`
	}
	var list []person
	if json.Unmarshal(b, &list) != nil {
		var all struct{ Persons []person }
		json.Unmarshal(b, &all)
		list = all.Persons
	}
	if i := slices.IndexFunc(list, func(p person) bool { return p.ID == id }); i >= 0 {
		return list[i].Voices
	}
	return nil
}

// callTo moves the live call's line to an agent ("" or "assistant" for the assistant), or has the next call
// the user makes open on it.
func (s *Server) callTo(w http.ResponseWriter, r *http.Request) {
	if s.CallLine == "" {
		http.Error(w, "atc on "+s.Host+" has no call line (ATC_CALL_LINE)", http.StatusNotFound)
		return
	}
	var in struct{ Agent string }
	json.NewDecoder(r.Body).Decode(&in)
	if name := strings.TrimPrefix(in.Agent, agentRef); name != "" && name != hubName {
		a, ok := s.agentNamed(name)
		if !ok || !a.Talk {
			http.Error(w, "@"+name+" can't talk on a call: it needs \"talk\": true in its agent.json", http.StatusBadRequest)
			return
		}
		in.Agent = name
	} else {
		in.Agent = ""
	}
	b, _ := json.Marshal(map[string]string{"to": in.Agent})
	req, _ := http.NewRequestWithContext(r.Context(), "POST", s.CallLine+"/line", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	resp.Body.Close()
	reply(w, map[string]string{"to": cmp.Or(in.Agent, hubName)})
}
