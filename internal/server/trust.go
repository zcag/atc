package server

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/push"
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
	id, device := "trust-"+q.Get("id"), cmp.Or(q.Get("device"), "a terminal")
	if claude.Trusted(dir) {
		s.Term.Run(w, r, id, exec.Command("true"), nil)
		return
	}
	cmd := exec.Command(s.M.CLI.Bin)
	cmd.Dir, cmd.Env = dir, claude.Env(dir)
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

// agentTrust is what an agent's row needs to ask for trust: its folder, and the folder of all agents
// when a yes there would cover it and every other one.
type agentTrust struct {
	State  string `json:"state"`
	Dir    string `json:"dir"`
	Parent string `json:"parent,omitempty"`
}

func (s *Server) agentsParent(a Agent) string {
	root, err := expand(s.AgentsDir)
	if err != nil || !strings.HasPrefix(a.dir(), root+string(filepath.Separator)) {
		return ""
	}
	return root
}

func (s *Server) trustNeeded(a Agent, trusted func(string) bool) *agentTrust {
	dir := a.dir()
	if !exists(dir) || trusted(dir) {
		return nil
	}
	if h, _ := os.UserHomeDir(); dir == h {
		return &agentTrust{State: "home", Dir: dir}
	}
	return &agentTrust{State: "untrusted", Dir: dir, Parent: s.agentsParent(a)}
}

// agentTrustErr names the agent on a refusal, and a start that works ends any wait for trust.
func (s *Server) agentTrustErr(a Agent, err error) error {
	var u *claude.Untrusted
	switch {
	case err == nil:
		s.setTold(a.Name, "")
	case errors.As(err, &u):
		u.Agent, u.Parent, u.Host = a.Name, s.agentsParent(a), a.Host
	}
	return err
}

// tellUntrusted is for a wake-up with nobody at the screen: the phone hears it once per folder, even
// across restarts, and from then on the schedule waits instead of asking Claude every round.
func (s *Server) tellUntrusted(a Agent, err error) {
	var u *claude.Untrusted
	if !errors.As(err, &u) || !s.setTold(a.Name, u.Dir) {
		return
	}
	log.Printf("agent %s: waits for trust in %s", a.Name, u.Dir)
	if s.Push != nil {
		go s.Push.Send(push.Message{Title: agentRef + a.Name, Body: "Can't wake: Claude Code doesn't trust its folder yet. Open it to decide.",
			Tag: "trust/" + a.Name, URL: "/#/agents/" + a.Name})
	}
	s.refresh()
}

func (s *Server) waitingOnTrust(a Agent) bool {
	s.mu.Lock()
	told := s.toldTrust()[a.Name]
	s.mu.Unlock()
	if told == "" {
		return false
	}
	if claude.Trusted(a.dir()) {
		s.setTold(a.Name, "")
		return false
	}
	return true
}

// setTold records whether a wait for trust was told, and says whether that changed.
func (s *Server) setTold(name, dir string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.toldTrust()
	if m[name] == dir {
		return false
	}
	if dir == "" {
		delete(m, name)
	} else {
		m[name] = dir
	}
	if s.StateDir != "" {
		b, _ := json.Marshal(m)
		os.WriteFile(filepath.Join(s.StateDir, "agents-untrusted.json"), b, 0o644)
	}
	return true
}

func (s *Server) toldTrust() map[string]string {
	if s.told == nil {
		s.told = map[string]string{}
		if b, err := os.ReadFile(filepath.Join(s.StateDir, "agents-untrusted.json")); err == nil {
			json.Unmarshal(b, &s.told)
		}
	}
	return s.told
}
