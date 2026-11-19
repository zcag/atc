package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/zcag/atc/internal/shells"
)

func (s *Server) routeShells(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/shells", s.shellList)
	mux.HandleFunc("POST /api/shells", s.shellStart)
	mux.HandleFunc("DELETE /api/shells/{id}", s.shellKill)
	mux.HandleFunc("GET /api/shells/{id}/attach", s.shellAttach)
}

func isShellPath(p string) bool { return p == "/api/shells" || strings.HasPrefix(p, "/api/shells/") }

func (s *Server) shellsUsable(w http.ResponseWriter, r *http.Request) bool {
	if s.guestCaller(r) {
		http.Error(w, "guests get no shell", http.StatusForbidden)
		return false
	}
	if s.Shells == nil {
		http.Error(w, "shells are off on "+s.Host, http.StatusServiceUnavailable)
		return false
	}
	return true
}

func (s *Server) shellErr(w http.ResponseWriter, err error) {
	if errors.Is(err, shells.ErrNoTmux) {
		http.Error(w, "tmux is not installed on "+s.Host+": Settings, Shell, says how to add it", http.StatusServiceUnavailable)
		return
	}
	http.Error(w, err.Error(), http.StatusBadRequest)
}

func (s *Server) shellList(w http.ResponseWriter, r *http.Request) {
	if !s.shellsUsable(w, r) {
		return
	}
	list, err := s.Shells.List(r.Context())
	if err != nil {
		log.Printf("shells: %v", err)
	}
	gather(s, w, r, "/api/shells", list, func(x *shells.Shell, h string) { x.Host = h })
}

func (s *Server) shellStart(w http.ResponseWriter, r *http.Request) {
	if !s.shellsUsable(w, r) {
		return
	}
	var req struct{ Dir, Run string }
	json.NewDecoder(r.Body).Decode(&req)
	sh, err := s.Shells.Start(r.Context(), strings.TrimSpace(req.Dir), strings.TrimSpace(req.Run))
	if err != nil {
		s.shellErr(w, err)
		return
	}
	sh.Host = s.Host
	log.Printf("shell %s started in %s %q", sh.ID, sh.Dir, sh.Run)
	reply(w, sh)
}

func (s *Server) shellKill(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.shellsUsable(w, r) {
		return
	}
	if !shells.ValidID(id) || !s.Shells.Has(r.Context(), id) {
		http.Error(w, "no such shell", http.StatusNotFound)
		return
	}
	if err := s.Shells.Kill(r.Context(), id); err != nil {
		s.shellErr(w, err)
		return
	}
	log.Printf("shell %s closed", id)
	reply(w, map[string]bool{"ok": true})
}

func (s *Server) shellAttach(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.shellsUsable(w, r) {
		return
	}
	if !shells.ValidID(id) || !s.Shells.Has(r.Context(), id) {
		http.Error(w, "this shell is gone", http.StatusGone)
		return
	}
	cmd, err := s.Shells.Attach(id)
	if err != nil {
		s.shellErr(w, err)
		return
	}
	s.nameViewer(r)
	s.Term.Run(w, r, "sh-"+id, cmd)
}
