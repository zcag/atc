package server

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/zcag/atc/internal/claude"
)

func trustDir(r *http.Request) (dir string, home bool, err error) {
	if dir, err = folderAt(r.URL.Query().Get("dir")); err != nil {
		return "", false, err
	}
	h, _ := os.UserHomeDir()
	return dir, dir == h, nil
}

func (s *Server) trustState(w http.ResponseWriter, r *http.Request) {
	state := ""
	if dir, home, err := trustDir(r); err == nil {
		switch {
		case claude.Trusted(dir):
			state = "trusted"
		case home:
			state = "home"
		default:
			state = "untrusted"
		}
	}
	reply(w, map[string]string{"state": state})
}

// trustTerm runs plain `claude` in the folder, for its own trust prompt to be answered in the browser.
// It is there for the prompt only: on a recorded yes it is stopped before anyone can use it as a
// session, and a folder that needs no prompt gets no Claude at all, just the exit the page waits for.
func (s *Server) trustTerm(w http.ResponseWriter, r *http.Request) {
	dir, home, err := trustDir(r)
	if err == nil && home && !claude.Trusted(dir) {
		err = &claude.Untrusted{Dir: dir, Home: true}
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.nameViewer(r)
	q := r.URL.Query()
	id, device := "trust-"+q.Get("id"), q.Get("device")
	if claude.Trusted(dir) {
		s.Term.Run(w, r, id, exec.Command("true"), nil)
		return
	}
	cmd := exec.Command(s.M.CLI.Bin)
	cmd.Dir = dir
	s.Term.Run(w, r, id, cmd, func(ctx context.Context, cmd *exec.Cmd) {
		pid := cmd.Process.Pid
		defer claude.Hide(pid)()
		tick := time.NewTicker(300 * time.Millisecond)
		defer tick.Stop()
		for !claude.Trusted(dir) {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
		log.Printf("trust: %s accepted in Claude Code's prompt from %s", dir, device)
		syscall.Kill(-pid, syscall.SIGHUP)
		select {
		case <-ctx.Done():
		case <-time.After(3 * time.Second):
			syscall.Kill(-pid, syscall.SIGKILL)
		}
	})
}
