package server

import (
	"net/http"

	"github.com/zcag/atc/internal/sessions"
)

func (s *Server) browserCDP(w http.ResponseWriter, r *http.Request) {
	if s.Browser == nil {
		http.Error(w, s.Host+" has no browser for sessions (ATC_BROWSER)", http.StatusNotFound)
		return
	}
	s.Browser.Proxy(w, r, r.PathValue("sid"))
}

func (s *Server) attachTabs(list []sessions.Session) {
	if s.Browser == nil {
		return
	}
	ids := make([]string, len(list))
	for i := range list {
		ids[i] = list[i].SessionID
		list[i].Tabs = s.Browser.Of(list[i].SessionID)
	}
	go s.Browser.Reap(ids)
}

func (s *Server) browserView(w http.ResponseWriter, r *http.Request) {
	if s.Browser == nil {
		http.Error(w, s.Host+" has no browser for sessions (ATC_BROWSER)", http.StatusNotFound)
		return
	}
	s.Browser.View(w, r, r.PathValue("sid"), r.PathValue("tab"))
}
