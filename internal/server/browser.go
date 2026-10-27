package server

import "net/http"

func (s *Server) browserCDP(w http.ResponseWriter, r *http.Request) {
	if s.Browser == nil {
		http.Error(w, s.Host+" has no browser for sessions (ATC_BROWSER)", http.StatusNotFound)
		return
	}
	s.Browser.Proxy(w, r, r.PathValue("sid"))
}

func (s *Server) browserTabs(w http.ResponseWriter, r *http.Request) {
	if s.Browser == nil {
		reply(w, []any{})
		return
	}
	tabs, err := s.Browser.Tabs(r.Context(), r.PathValue("sid"))
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, tabs)
}
