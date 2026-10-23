package server

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
)

const continuePrompt = "The machine restarted while you were working, which interrupted you. Continue where you left off."

type running struct {
	SID     string `json:"sid"`
	ID      string `json:"id"`
	Dir     string `json:"dir"`
	Title   string `json:"title"`
	Name    string `json:"name,omitempty"`
	Working bool   `json:"working,omitempty"`
}

type runningFile struct {
	At       time.Time `json:"at"`
	Sessions []running `json:"sessions"`
}

type reviver struct {
	path     string
	mu       sync.Mutex
	last     map[string]running
	written  time.Time
	intended map[string]bool
}

func (rv *reviver) stopping(id string) {
	rv.mu.Lock()
	defer rv.mu.Unlock()
	if rv.intended == nil {
		rv.intended = map[string]bool{}
	}
	rv.intended[id] = true
}

func runningOf(list []sessions.Session, host string) map[string]running {
	out := map[string]running{}
	for _, x := range list {
		if x.Attachable && cmp.Or(x.Host, host) == host {
			out[x.SessionID] = running{x.SessionID, x.ID, cmp.Or(x.StartCwd, x.Cwd), x.Title, x.Name, x.State == sessions.Working}
		}
	}
	return out
}

func (rv *reviver) observe(now map[string]running) (lost []running) {
	rv.mu.Lock()
	defer rv.mu.Unlock()
	if rv.last != nil && len(rv.last) >= 2 && len(now) == 0 {
		for _, r := range rv.last {
			if !rv.intended[r.ID] {
				lost = append(lost, r)
			}
		}
		if len(lost) < 2 {
			lost = nil
		}
	}
	if lost == nil {
		changed := len(now) != len(rv.last)
		for sid, r := range now {
			if p, ok := rv.last[sid]; !ok || p != r {
				changed = true
			}
		}
		rv.last = now
		if changed || time.Since(rv.written) > time.Minute {
			rv.save(now)
		}
	}
	rv.intended = nil
	return lost
}

func (rv *reviver) save(now map[string]running) {
	f := runningFile{At: time.Now()}
	for _, r := range now {
		f.Sessions = append(f.Sessions, r)
	}
	b, _ := json.MarshalIndent(f, "", "  ")
	tmp := rv.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil && os.Rename(tmp, rv.path) == nil {
		rv.written = time.Now()
	}
}

func (rv *reviver) afterReboot() []running {
	b, err := os.ReadFile(rv.path)
	if err != nil {
		return nil
	}
	var f runningFile
	if json.Unmarshal(b, &f) != nil {
		return nil
	}
	boot, err := bootTime()
	if err != nil || !boot.After(f.At) {
		return nil
	}
	return f.Sessions
}

var bootSec = regexp.MustCompile(`sec = (\d+)`)

func bootTime() (time.Time, error) {
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("sysctl", "-n", "kern.boottime").Output()
		if err != nil {
			return time.Time{}, err
		}
		m := bootSec.FindSubmatch(out)
		if m == nil {
			return time.Time{}, fmt.Errorf("unexpected kern.boottime: %s", out)
		}
		n, _ := strconv.ParseInt(string(m[1]), 10, 64)
		return time.Unix(n, 0), nil
	}
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "btime "); ok {
			n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return time.Unix(n, 0), err
		}
	}
	return time.Time{}, fmt.Errorf("no btime in /proc/stat")
}

func (s *Server) revive(lost []running, why string) {
	if len(lost) == 0 {
		return
	}
	var back []string
	for _, r := range lost {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		id, err := s.relaunch(ctx, r.Name, r.Dir, r.SID)
		cancel()
		if err != nil {
			log.Printf("revive %s: %v", r.Title, err)
			continue
		}
		back = append(back, r.Title)
		if r.Working {
			go func() {
				time.Sleep(5 * time.Second)
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := s.Term.Send(ctx, id, continuePrompt); err != nil {
					log.Printf("revive %s: continue: %v", r.Title, err)
				}
			}()
		}
	}
	log.Printf("revived %d sessions %s", len(back), why)
	s.refresh()
	if s.Push != nil && len(back) > 0 {
		s.Push.Send(push.Message{Title: fmt.Sprintf("%s: %d sessions back", s.Host, len(back)), Body: why + ". Resumed " + strings.Join(back, ", ") + ".", Tag: "revive", URL: "/"})
	}
}

func revivePath(dir string) string { return filepath.Join(dir, "running.json") }
