package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/sessions"
)

type profileInfo struct {
	Name    string   `json:"name"`
	Default bool     `json:"default,omitempty"`
	Home    string   `json:"home"`
	Paths   []string `json:"paths,omitempty"`
	Private bool     `json:"private,omitempty"`
}

// profiles lists this machine's Claude accounts and, given a dir, the one a new session there runs on.
func (s *Server) profiles(w http.ResponseWriter, r *http.Request) {
	out := struct {
		Profiles []profileInfo `json:"profiles"`
		For      string        `json:"for,omitempty"`
	}{Profiles: []profileInfo{}}
	for _, p := range claude.Profiles() {
		out.Profiles = append(out.Profiles, profileInfo{p.Name, p.Default(), p.Home(), p.Paths, p.Ephemeral})
	}
	if dir := r.URL.Query().Get("dir"); dir != "" {
		out.For = claude.ProfileFor(dir).Name
	}
	reply(w, out)
}

func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Profile string `json:"profile"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	id, err := s.moveSession(r.Context(), r.PathValue("sid"), req.Profile)
	if errors.As(err, new(badRequest)) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.done(w, id, err)
}

// moveSession puts a conversation on another Claude account: it leaves the old account's daemon, its files move to
// the new account, and one that was open resumes there.
func (s *Server) moveSession(ctx context.Context, sid, name string) (string, error) {
	to, ok := claude.ProfileNamed(name)
	if !ok || name == "" {
		return "", badf("no Claude profile called %q on %s", name, s.Host)
	}
	live, err := s.M.Live(ctx)
	if err != nil {
		return "", err
	}
	var cur *sessions.Session
	if i := slices.IndexFunc(live, func(x sessions.Session) bool { return x.SessionID == sid || x.ID == sid }); i >= 0 {
		cur = &live[i]
		sid = cur.SessionID
	}
	if cur != nil && (cur.Harness != "" || s.hubSession(sid)) {
		return "", badf("only a Claude Code session of its own can move")
	}
	if cur != nil && (cur.State == sessions.Working || cur.State == sessions.NeedsYou) {
		return "", badf("%s is in the middle of a turn; move it when it waits for you", cur.Title)
	}
	path := claude.Transcript(sid)
	if path == "" {
		return "", fmt.Errorf("%w %s", errUnknown, sid)
	}
	from := claude.ProfileOfFile(path)
	if from.Ephemeral || to.Ephemeral {
		return "", badf("a private session stays private, and no other one becomes private")
	}
	if from.Name == to.Name {
		return "", badf("it runs on %s already", to.Name)
	}
	open := cur != nil && cur.State != sessions.Stopped && cur.State != sessions.Past
	if cur != nil && cur.ID != "" && cur.PID > 0 {
		if err := s.M.CLI.Stop(ctx, cur.ID); err != nil {
			return "", err
		}
	}
	if err := claude.Move(sid, to); err != nil {
		return "", err
	}
	if cur != nil && cur.ID != "" {
		if err := s.M.CLI.RemoveFrom(ctx, from, cur.ID); err != nil {
			log.Printf("move %s: leaving %s's daemon: %v", cur.ID, from.Name, err)
		}
	}
	log.Printf("move %s: from %s to %s", sid, from.Name, to.Name)
	if !open {
		return "", nil
	}
	return s.resumeSession(ctx, sid)
}
