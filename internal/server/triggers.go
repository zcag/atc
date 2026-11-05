package server

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

const checkTimeout = time.Minute

func (a Agent) interval() (time.Duration, error) {
	if a.Every == "" {
		return 0, nil
	}
	d, err := parseEvery(a.Every)
	_, ferr := a.anchor()
	switch {
	case err != nil:
		return 0, fmt.Errorf("every: %w", err)
	case ferr != nil:
		return 0, fmt.Errorf("from: %w", ferr)
	case d <= 0:
		return 0, fmt.Errorf("every must be positive")
	case a.Check == "" && a.Prompt == "":
		return 0, fmt.Errorf("every needs a check or a prompt")
	}
	return d, nil
}

func parseEvery(s string) (time.Duration, error) {
	for unit, d := range map[string]time.Duration{"d": 24 * time.Hour, "w": 7 * 24 * time.Hour} {
		if n, ok := strings.CutSuffix(s, unit); ok {
			k, err := strconv.Atoi(n)
			if err != nil {
				return 0, fmt.Errorf("%q: want a whole number of %s, like 2%s", s, unit, unit)
			}
			return time.Duration(k) * d, nil
		}
	}
	return time.ParseDuration(s)
}

func (a Agent) anchor() (time.Time, error) {
	if a.From == "" {
		return time.Time{}, nil
	}
	return time.ParseInLocation("2006-01-02T15:04", a.From, time.Local)
}

func step(t time.Time, d time.Duration) time.Time {
	if d%(24*time.Hour) == 0 {
		return t.AddDate(0, 0, int(d/(24*time.Hour)))
	}
	return t.Add(d)
}

func nextRun(from time.Time, d time.Duration, now time.Time) time.Time {
	if d%(24*time.Hour) != 0 && from.Before(now) {
		from = from.Add(now.Sub(from) / d * d)
	}
	for !from.After(now) {
		from = step(from, d)
	}
	return from
}

func (a Agent) firstMessage(ctx context.Context) (string, string) {
	got, why := a.checked(ctx)
	switch {
	case why != "":
		return "", why
	case a.Check == "":
		return a.Prompt, ""
	case a.Prompt == "":
		return got, ""
	}
	return a.Prompt + "\n\n" + got, ""
}

func (a Agent) checked(ctx context.Context) (string, string) {
	if a.Check == "" {
		return "", ""
	}
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", a.Check)
	cmd.Dir = a.Folder
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

// schedule wakes each agent of this machine on its every (and from), rereading the agent
// folders each round so an edited schedule applies without a restart. The first wake-up comes
// one interval after atc starts or the schedule changes.
func (s *Server) schedule() {
	spec := map[string]string{}
	for {
		now := time.Now()
		next := map[string]time.Time{}
		for _, a := range s.localAgents() {
			d, _ := a.interval()
			if d == 0 {
				continue
			}
			s.mu.Lock()
			at, key := s.wakes[a.Name], a.Every+"|"+a.From
			s.mu.Unlock()
			if spec[a.Name] != key || at.IsZero() {
				spec[a.Name], at = key, a.after(d, now)
				log.Printf("agent %s: every %s, next %s", a.Name, a.Every, at.Format("Mon Jan 2 15:04"))
			} else if !now.Before(at) {
				at = a.after(d, now)
				go s.tick(a)
			}
			next[a.Name] = at
		}
		s.mu.Lock()
		s.wakes = next
		s.mu.Unlock()
		time.Sleep(30 * time.Second)
	}
}

func (a Agent) after(d time.Duration, now time.Time) time.Time {
	if from, _ := a.anchor(); !from.IsZero() {
		return nextRun(from, d, now)
	}
	return now.Add(d)
}

func (s *Server) nextWake(name string) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.wakes[name]
}

func (s *Server) tick(a Agent) {
	if s.waitingOnTrust(a) {
		log.Printf("agent %s: skip, Claude Code does not trust %s yet", a.Name, a.dir())
		return
	}
	ctx := context.Background()
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	list, err := s.M.Live(lctx)
	cancel()
	if err != nil {
		log.Printf("agent %s: skip, no session list: %v", a.Name, err)
		return
	}
	if cur := agentSession(list, a.Name); cur != nil && (cur.State == sessions.Working || cur.State == sessions.NeedsYou) {
		log.Printf("agent %s: skip, %s", a.Name, cur.State)
		return
	}
	msg, why := a.firstMessage(ctx)
	if why != "" {
		log.Printf("agent %s: skip, %s", a.Name, why)
		return
	}
	if _, err := s.wakeAgent(ctx, a, "[wake-up from your schedule, every "+a.Every+"]\n"+msg); err != nil {
		log.Printf("agent %s: wake-up: %v", a.Name, err)
		s.tellUntrusted(a, err)
	}
	s.refresh()
}
