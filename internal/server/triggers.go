package server

import (
	"bytes"
	"context"
	"fmt"
	"log"
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
	case p.Check == "" && p.Prompt == "":
		return 0, fmt.Errorf("preset %s: every needs a check or a prompt", p.Name)
	}
	return d, nil
}

func (p Preset) firstMessage(ctx context.Context) (string, string) {
	if p.Check == "" {
		return p.Prompt, ""
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
	if p.Prompt == "" {
		return got, ""
	}
	return p.Prompt + "\n\n" + got, ""
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
