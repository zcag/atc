package server

import (
	"cmp"
	"context"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/ends"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/resources"
	"github.com/zcag/atc/internal/sessions"
)

func (s *Server) startResources() {
	if s.Res == nil {
		return
	}
	s.Res.Resolve = func(key string) (string, string) {
		var found history.Transcript
		for _, t := range s.M.Index.Scan() {
			if strings.HasPrefix(t.SessionID, key) {
				found = t
				break
			}
		}
		title := cmp.Or(s.M.Store.Get(found.SessionID).Name, found.Title, found.AITitle, found.AgentName)
		return title, found.SessionID
	}
	go s.Res.Run(context.Background())
	dir := ""
	if s.StateDir != "" {
		dir = filepath.Join(s.StateDir, "ends")
	}
	s.Ends = ends.New(dir, filepath.Join(claude.ConfigDir(), "daemon.log"), s.Host, s.Res)
	s.Ends.Title = s.Res.Resolve
	go s.Ends.Run(context.Background())
}

func (s *Server) resourcesIncidents(w http.ResponseWriter, r *http.Request) {
	if id := r.PathValue("id"); id != "" {
		inc := s.Ends.Incident(id)
		if inc == nil {
			http.Error(w, "no such incident", http.StatusNotFound)
			return
		}
		reply(w, inc)
		return
	}
	list := s.Ends.Incidents()
	if list == nil {
		list = []ends.Incident{}
	}
	reply(w, list)
}

// ended is why a stopped session stopped, with its evidence and the incident it was part of.
func (s *Server) ended(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("sid")
	list, _ := s.M.Live(r.Context())
	last := time.Time{}
	for _, x := range list {
		if x.SessionID == id || x.ID == id {
			id, last = cmp.Or(x.ID, x.SessionID), x.Last()
		}
	}
	e, inc := s.Ends.Detail(id, last)
	if e == nil {
		http.Error(w, "not measured here", http.StatusNotFound)
		return
	}
	reply(w, map[string]any{"ending": e, "incident": inc})
}

func (s *Server) trackResources(list []sessions.Session) {
	if s.Res == nil {
		return
	}
	var out []resources.Target
	for _, x := range list {
		if x.Host == "" || x.Host == s.Host {
			out = append(out, resources.Target{Key: cmp.Or(x.ID, x.SessionID), SessionID: x.SessionID, Title: x.Title, Cwd: x.Cwd, PID: x.PID})
		}
	}
	s.Res.Track(out)
}

func (s *Server) resourcesNow(w http.ResponseWriter, r *http.Request) {
	if s.Res == nil {
		http.Error(w, "not measured here", http.StatusNotFound)
		return
	}
	rep := s.Res.Report()
	if r.URL.Query().Get("brief") != "" {
		reply(w, map[string]any{"machine": rep.Machine, "left": len(rep.Left)})
		return
	}
	reply(w, rep)
}

func (s *Server) resourcesHistory(w http.ResponseWriter, r *http.Request) {
	if s.Res == nil {
		http.Error(w, "not measured here", http.StatusNotFound)
		return
	}
	hours, err := strconv.Atoi(r.URL.Query().Get("hours"))
	if err != nil || hours <= 0 {
		hours = 24
	}
	reply(w, s.Res.History(time.Duration(min(hours, 24*7))*time.Hour, r.URL.Query().Get("key")))
}
