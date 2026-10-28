package server

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

const checkTimeout = time.Minute

func (p Preset) interval() (time.Duration, error) {
	if p.Every == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(p.Every)
	switch {
	case err != nil:
		return 0, fmt.Errorf("preset %s: every: %w", p.Name, err)
	case d <= 0:
		return 0, fmt.Errorf("preset %s: every must be positive", p.Name)
	case p.Check == "" && p.Prompt == "" && p.Command == "":
		return 0, fmt.Errorf("preset %s: every needs a check, a prompt or a command", p.Name)
	}
	return d, nil
}

func (p Preset) firstMessage(ctx context.Context) (string, string) {
	got, why := p.checked(ctx)
	switch {
	case why != "":
		return "", why
	case p.Check == "":
		return p.Prompt, ""
	case p.Prompt == "":
		return got, ""
	}
	return p.Prompt + "\n\n" + got, ""
}

func (p Preset) checked(ctx context.Context) (string, string) {
	if p.Check == "" {
		return "", ""
	}
	dir, err := expand(p.Dir)
	if err != nil {
		return "", err.Error()
	}
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", p.Check)
	cmd.Dir = dir
	var errOut bytes.Buffer
	cmd.Stderr = &errOut
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Sprintf("check failed: %v %s", err, strings.TrimSpace(errOut.String()))
	}
	got := strings.TrimSpace(string(out))
	if got == "" {
		return "", "check found nothing"
	}
	return got, ""
}

func busy(list []sessions.Session, id string) bool {
	for _, x := range list {
		if x.ID == id {
			return x.State == sessions.Working || x.State == sessions.NeedsYou
		}
	}
	return false
}

func (s *Server) schedule() {
	for _, p := range s.Presets {
		if every, err := p.interval(); err != nil {
			log.Print(err)
		} else if every > 0 {
			log.Printf("preset %s: every %s", p.Name, every)
			go s.every(p, every)
		}
	}
}

func (s *Server) every(p Preset, d time.Duration) {
	t := time.NewTicker(d)
	defer t.Stop()
	var last string
	for range t.C {
		last = s.tick(context.Background(), p, last)
	}
}

func (s *Server) tick(ctx context.Context, p Preset, last string) string {
	if p.Command != "" {
		if got, why := p.checked(ctx); why != "" {
			log.Printf("preset %s: skip, %s", p.Name, why)
		} else {
			s.runCommand(p, got)
		}
		return ""
	}
	if last != "" {
		lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		list, err := s.M.Live(lctx)
		cancel()
		if err != nil {
			log.Printf("preset %s: skip, no session list: %v", p.Name, err)
			return last
		}
		if busy(list, last) {
			log.Printf("preset %s: skip, %s is still running", p.Name, last)
			return last
		}
	}
	msg, why := p.firstMessage(ctx)
	if why != "" {
		log.Printf("preset %s: skip, %s", p.Name, why)
		return last
	}
	id, err := s.startSession(ctx, startReq{Preset: p.Name, Prompt: msg})
	if err != nil {
		log.Printf("preset %s: start: %v", p.Name, err)
		return last
	}
	log.Printf("preset %s: started %s", p.Name, id)
	s.refresh()
	return id
}

const commandTimeout = 5 * time.Minute

type CommandRun struct {
	Running bool      `json:"running,omitempty"`
	At      time.Time `json:"at,omitzero"`
	Code    int       `json:"code"`
	Output  string    `json:"output,omitempty"`
}

func (s *Server) runCommand(p Preset, input string) bool {
	s.cmdMu.Lock()
	if s.cmds == nil {
		s.cmds = map[string]*CommandRun{}
	}
	if r := s.cmds[p.Name]; r != nil && r.Running {
		s.cmdMu.Unlock()
		log.Printf("preset %s: skip, its command is still running", p.Name)
		return false
	}
	run := &CommandRun{Running: true, At: time.Now()}
	s.cmds[p.Name] = run
	s.cmdMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, "sh", "-c", p.Command)
		cmd.Dir, _ = expand(p.Dir)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		code := cmd.ProcessState.ExitCode()
		if err != nil && code == 0 {
			code = -1
		}
		tail := strings.TrimSpace(string(out))
		if len(tail) > 4096 {
			tail = tail[len(tail)-4096:]
		}
		log.Printf("preset %s: command exit %d in %s", p.Name, code, time.Since(run.At).Round(time.Millisecond))
		s.cmdMu.Lock()
		s.cmds[p.Name] = &CommandRun{At: run.At, Code: code, Output: tail}
		s.cmdMu.Unlock()
		s.refresh()
	}()
	return true
}

func (s *Server) commandRun(name string) *CommandRun {
	s.cmdMu.Lock()
	defer s.cmdMu.Unlock()
	if r := s.cmds[name]; r != nil {
		c := *r
		return &c
	}
	return nil
}

func (s *Server) runPreset(w http.ResponseWriter, r *http.Request) {
	p, ok := s.preset(r.PathValue("name"))
	if !ok {
		http.Error(w, "no preset named "+r.PathValue("name"), http.StatusNotFound)
		return
	}
	if p.Command != "" {
		if !s.runCommand(p, "") {
			http.Error(w, p.Name+" is already running", http.StatusConflict)
			return
		}
		reply(w, map[string]string{"ok": "started"})
		return
	}
	id, err := s.startSession(r.Context(), startReq{Preset: p.Name, Prompt: p.Prompt})
	if err != nil {
		fail(w, err)
		return
	}
	s.refresh()
	reply(w, map[string]string{"id": id})
}
