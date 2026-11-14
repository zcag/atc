package server

import (
	"net/http"
	"os"
)

// trustState says whether dir is the home folder, the one place Claude Code won't start a background
// session; anywhere else a start records Claude Code's trust itself.
func (s *Server) trustState(w http.ResponseWriter, r *http.Request) {
	state := ""
	if dir, err := folderAt(r.URL.Query().Get("dir")); err == nil && isHome(dir) {
		state = "home"
	}
	reply(w, map[string]string{"state": state})
}

func isHome(dir string) bool {
	h, _ := os.UserHomeDir()
	return dir == h
}
