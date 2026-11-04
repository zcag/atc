package server

import (
	"cmp"
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

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
		return cmp.Or(found.Title, found.AITitle, found.AgentName), found.SessionID
	}
	go s.Res.Run(context.Background())
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
