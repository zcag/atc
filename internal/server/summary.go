package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/summary"
)

const holdForSummary = 25 * time.Second

type summaryReply struct {
	Summary     *summary.Summary `json:"summary"`
	Summarizing bool             `json:"summarizing"`
}

func (s *Server) summary(w http.ResponseWriter, r *http.Request) {
	if s.M.Summary == nil {
		http.Error(w, "summaries are turned off on "+s.Host, http.StatusNotImplemented)
		return
	}
	t, ok := s.M.Find(r.PathValue("sid"))
	if !ok {
		http.Error(w, "no transcript", http.StatusNotFound)
		return
	}
	if r.Method == "POST" {
		s.M.Summary.Forget(t.SessionID)
	}
	x := s.M.Summary.Get(t)
	if x == nil && s.M.Summary.Want(t) {
		if secs, _ := strconv.Atoi(r.URL.Query().Get("wait")); secs > 0 {
			ctx, cancel := context.WithTimeout(r.Context(), time.Duration(min(secs, 120))*time.Second)
			x = s.M.Summary.Wait(ctx, t)
			cancel()
		}
	}
	reply(w, summaryReply{x, x == nil && s.M.Summary.Want(t)})
}

func pushBody(x *summary.Summary) string {
	if x == nil {
		return ""
	}
	return strings.Join(append([]string{x.Status}, x.Gist...), "\n")
}

type held struct {
	m     push.Message
	until time.Time
}

func (s *Server) release(list []sessions.Session) []push.Message {
	var out []push.Message
	for sid, h := range s.held {
		x, ok := find(list, sid)
		switch {
		case !ok || x.State != sessions.YourTurn:
			delete(s.held, sid)
		case x.Summary != nil || !x.Summarizing || time.Now().After(h.until):
			if b := pushBody(x.Summary); b != "" {
				h.m.Body = b
			}
			out = append(out, h.m)
			delete(s.held, sid)
		}
	}
	return out
}

func find(list []sessions.Session, sid string) (sessions.Session, bool) {
	for _, x := range list {
		if x.SessionID == sid {
			return x, true
		}
	}
	return sessions.Session{}, false
}
