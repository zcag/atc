package server

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func continuePrompt(why string) string {
	return "[atc: you were interrupted mid-turn: " + why + "] Continue where you left off."
}

type running struct {
	SID     string `json:"sid"`
	ID      string `json:"id"`
	Dir     string `json:"dir"`
	Title   string `json:"title"`
	Name    string `json:"name,omitempty"`
	Working bool   `json:"working,omitempty"`
	Harness string `json:"harness,omitempty"`
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
	reviving bool
	revived  time.Time
}

// reviveEvery spaces revives out: a service dying again that soon is likely dying of the revive.
const reviveEvery = 10 * time.Minute

func (rv *reviver) begin() bool {
	rv.mu.Lock()
	defer rv.mu.Unlock()
	return rv.beginLocked()
}

func (rv *reviver) beginLocked() bool {
	if rv.reviving {
		log.Print("revive: one is already running")
		return false
	}
	if !rv.revived.IsZero() && time.Since(rv.revived) < reviveEvery {
		log.Printf("revive: not again, the last one was %s ago", time.Since(rv.revived).Round(time.Second))
		return false
	}
	rv.reviving, rv.revived = true, time.Now()
	return true
}

func (rv *reviver) end() {
	rv.mu.Lock()
	defer rv.mu.Unlock()
	rv.reviving = false
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
			out[x.SessionID] = running{x.SessionID, x.ID, cmp.Or(x.StartCwd, x.Cwd), x.Title, x.Name, x.State == sessions.Working, x.Harness}
		}
	}
	return out
}

func (rv *reviver) observe(now map[string]running) (lost []running) {
	rv.mu.Lock()
	defer rv.mu.Unlock()
	if rv.last != nil && claudes(rv.last) >= 2 && claudes(now) == 0 {
		for _, r := range rv.last {
			if r.Harness == "" && !rv.intended[r.ID] {
				lost = append(lost, r)
			}
		}
		if len(lost) < 2 || !rv.beginLocked() {
			lost = nil
		}
	}
	if !rv.reviving {
		changed := len(now) != len(rv.last)
		for sid, r := range now {
			if p, ok := rv.last[sid]; !ok || p != r {
				changed = true
			}
		}
		if changed || time.Since(rv.written) > time.Minute {
			rv.save(now)
		}
	}
	rv.last = now
	rv.intended = nil
	return lost
}

func claudes(m map[string]running) int {
	n := 0
	for _, r := range m {
		if r.Harness == "" {
			n++
		}
	}
	return n
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

// revive runs after rv.begin (observe calls it for a stop) and ends that claim.
func (s *Server) revive(lost []running, why string) {
	defer s.rv.end()
	var back []string
	for _, r := range lost {
		r.Working = r.Working || s.midTurn(r.SID)
		if r.Harness == opencode.Harness {
			if r.Working && s.M.OC != nil {
				back = append(back, r.Title)
				go s.continueOpenCode(r)
			}
			continue
		}
		id, err := s.reviveOne(r)
		if errors.Is(err, errBack) {
			log.Printf("revive %s: already back as %s", r.Title, id)
			continue
		}
		if err != nil {
			log.Printf("revive %s: %v", r.Title, err)
			continue
		}
		back = append(back, r.Title)
		if r.Working {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
				defer cancel()
				err := s.untilAttachable(ctx, id)
				if err == nil {
					err = s.Term.Send(ctx, id, continuePrompt(why))
				}
				if err != nil {
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

// midTurn reads it from the transcript: a dying daemon's replacement lists its sessions as blocked.
func (s *Server) midTurn(sid string) bool {
	t, ok := s.M.Index.Find(sid)
	return ok && !t.Ended && t.PromptAt.After(time.Time{}) && time.Since(t.Updated) < 15*time.Minute
}

var errBack = errors.New("already back")

// reviveOne holds the agent's lock so a wake-up cannot resume the same conversation alongside it.
func (s *Server) reviveOne(r running) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	was := s.M.Store.Get(r.SID)
	if was.Agent != "" {
		mu := s.agentLock(was.Agent)
		mu.Lock()
		defer mu.Unlock()
	}
	agents, err := s.M.CLI.Agents(ctx)
	if err != nil {
		return "", err
	}
	if id, ok := s.liveIn(s.chain(r.SID, agents), agents); ok {
		return id, errBack
	}
	if i := slices.IndexFunc(agents, func(a claude.Agent) bool {
		return a.PID > 0 && was.Agent != "" && s.M.Store.Get(a.SessionID).Agent == was.Agent
	}); i >= 0 {
		return agents[i].ID, errBack
	}
	id, err := s.relaunch(ctx, s.standingName(r.SID, r.Name), r.Dir, r.SID)
	if err == nil && was.Parked && was.Agent == "" {
		s.tag(ctx, id, func(m *store.Meta) { m.Parked = true })
	}
	return id, err
}

func (s *Server) continueOpenCode(r running) {
	for range 12 {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := s.sendOpenCode(ctx, r.SID, continuePrompt("the machine restarted"))
		cancel()
		if err == nil {
			return
		}
		log.Printf("revive %s: continue: %v", r.Title, err)
		time.Sleep(10 * time.Second)
	}
}

func revivePath(dir string) string { return filepath.Join(dir, "running.json") }
