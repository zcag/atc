package server

import (
	"net"
	"net/http"
	"slices"

	"github.com/zcag/atc/internal/sessions"
)

func (s *Server) browserCDP(w http.ResponseWriter, r *http.Request) {
	if s.Browser == nil {
		http.Error(w, s.Host+" has no browser for sessions (ATC_BROWSER)", http.StatusNotFound)
		return
	}
	s.Browser.Proxy(w, r, r.PathValue("sid"))
}

// agentsPage is whether a request may come from atc open in a session's browser tab, where nobody is looking.
func (s *Server) agentsPage(r *http.Request) bool {
	ip := s.clientIP(r)
	if s.Browser == nil || ip == nil {
		return false
	}
	own, _ := net.InterfaceAddrs()
	here := ip.IsLoopback() || slices.ContainsFunc(own, func(a net.Addr) bool { n, ok := a.(*net.IPNet); return ok && n.IP.Equal(ip) })
	return here && s.Browser.Shows(r.Context(), r.Host)
}

func (s *Server) attachTabs(list []sessions.Session) {
	if s.Browser == nil {
		return
	}
	var running []string
	for i := range list {
		list[i].Tabs = s.Browser.Of(list[i].SessionID)
		if list[i].State != sessions.Stopped && list[i].State != sessions.Past {
			running = append(running, list[i].SessionID)
		}
	}
	go s.Browser.Reap(running)
}

func (s *Server) browserView(w http.ResponseWriter, r *http.Request) {
	if s.Browser == nil {
		http.Error(w, s.Host+" has no browser for sessions (ATC_BROWSER)", http.StatusNotFound)
		return
	}
	s.Browser.View(w, r, r.PathValue("sid"), r.PathValue("tab"))
}
