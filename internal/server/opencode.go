package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func (s *Server) watchOpenCode() {
	oc := s.M.OC
	if oc == nil {
		return
	}
	s.Term.Attach = func(id string) *exec.Cmd {
		if s.M.OpenCode(id) {
			return oc.Attach(id)
		}
		return nil
	}
	go oc.Watch(context.Background(), func(e opencode.Event) {
		switch e.Type {
		case "session.status":
			if e.Status == "busy" {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				s.M.Adopt(ctx, e.SessionID)
				cancel()
			}
		case "session.idle", "session.updated", "session.deleted", "session.error", "message.updated",
			"question.asked", "question.replied", "question.rejected", "permission.asked", "permission.replied":
		default:
			return
		}
		s.refresh()
	})
}

func (s *Server) startOpenCode(ctx context.Context, dir, name, prompt string, e Engine, p *Preset) (string, error) {
	op := opencode.Prompt{Text: prompt, Model: e.Model}
	if p != nil {
		brief, err := p.brief(dir)
		if err != nil {
			return "", err
		}
		op.Brief = brief
	}
	sid, err := s.M.OC.Start(ctx, dir, name, op)
	if sid != "" {
		s.M.Store.Update(sid, func(m *store.Meta) { m.Live, m.Engine = store.Running, e.Name })
	}
	return sid, err
}

func (s *Server) sendOpenCode(ctx context.Context, sid, text string) error {
	p := opencode.Prompt{Text: text}
	if e, ok := s.engine(s.M.Store.Get(sid).Engine); ok {
		p.Model = e.Model
	}
	return s.M.OC.Send(ctx, sid, p)
}

func (s *Server) answer(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	if !s.M.OpenCode(sid) {
		http.Error(w, "Claude asks in its terminal", http.StatusBadRequest)
		return
	}
	var a opencode.Answer
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.done(w, sid, s.M.OC.Respond(r.Context(), sid, r.PathValue("ask"), a))
}

func (s *Server) stop(ctx context.Context, id string) error {
	if !s.M.OpenCode(id) {
		return s.M.CLI.Stop(ctx, id)
	}
	if err := s.M.OC.Stop(ctx, id); err != nil {
		log.Printf("stop %s: %v", id, err)
	}
	return s.M.Keep(id, store.Stopped)
}

func (s *Server) remove(ctx context.Context, id string) error {
	if !s.M.OpenCode(id) {
		return s.M.CLI.Remove(ctx, id)
	}
	if err := s.M.OC.Stop(ctx, id); err != nil {
		log.Printf("remove %s: %v", id, err)
	}
	return s.M.Keep(id, "")
}

func (s *Server) openCodeFound(ctx context.Context, sid string) ([]outputs.File, []outputs.Link, map[string]time.Time, error) {
	home, _ := os.UserHomeDir()
	return s.M.OC.Outputs(ctx, sid, home, s.Featured)
}

func (s *Server) openCodePages(ctx context.Context, x *sessions.Session) {
	if _, links, _, err := s.openCodeFound(ctx, x.SessionID); err == nil {
		x.Pages = outputs.Featured(links, s.Featured)
		s.unfurl.fill(x.Pages, false)
	}
}
