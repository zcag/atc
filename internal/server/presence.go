package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"sync"
	"time"
)

const (
	pageActive = 90 * time.Second
	handsIdle  = 2 * time.Minute
)

type presence struct {
	mu    sync.Mutex
	pages map[string]time.Time
	idle  time.Duration
	at    time.Time
}

var hidIdle = regexp.MustCompile(`"HIDIdleTime" = (\d+)`)

func machineIdle() (time.Duration, bool) {
	if runtime.GOOS != "darwin" {
		return 0, false
	}
	out, err := exec.Command("ioreg", "-c", "IOHIDSystem", "-d", "4").Output()
	m := hidIdle.FindSubmatch(out)
	if err != nil || m == nil {
		return 0, false
	}
	ns, _ := strconv.ParseInt(string(m[1]), 10, 64)
	return time.Duration(ns), true
}

func (p *presence) seen(device string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pages == nil {
		p.pages = map[string]time.Time{}
	}
	p.pages[device] = time.Now()
}

func (p *presence) here() (bool, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for d, at := range p.pages {
		if time.Since(at) < pageActive {
			return true, d
		}
	}
	if time.Since(p.at) > 10*time.Second {
		p.at = time.Now()
		if idle, ok := machineIdle(); ok {
			p.idle = idle
		} else {
			p.idle = -1
		}
	}
	if p.idle >= 0 && p.idle < handsIdle {
		return true, "this machine"
	}
	return false, ""
}

func (s *Server) presencePost(w http.ResponseWriter, r *http.Request) {
	var in struct{ Device string }
	json.NewDecoder(r.Body).Decode(&in)
	s.here.seen(s.deviceName(r, in.Device))
	reply(w, map[string]bool{"ok": true})
}

func (s *Server) presenceGet(w http.ResponseWriter, r *http.Request) {
	ok, where := s.here.here()
	reply(w, map[string]any{"active": ok, "where": where})
}

func (s *Server) userActive(ctx context.Context) (bool, string) {
	if ok, where := s.here.here(); ok {
		return true, where
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	type res struct {
		Active bool
		Where  string
	}
	ch := make(chan res, len(s.Peers))
	for _, p := range s.Peers {
		go func() {
			var r res
			s.fleet.get(ctx, p, "/api/presence?local=1", &r)
			if r.Active {
				r.Where = p.Name + ": " + r.Where
			}
			ch <- r
		}()
	}
	for range s.Peers {
		if r := <-ch; r.Active {
			return true, r.Where
		}
	}
	return false, ""
}
