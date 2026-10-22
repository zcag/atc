package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var cgnat = mustCIDR("100.64.0.0/10")

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

type Proxies struct {
	nets       []*net.IPNet
	containers []string
	mu         sync.Mutex
	ips        map[string]bool
	at         time.Time
}

func ParseProxies(list string) *Proxies {
	p := &Proxies{}
	for _, s := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == ' ' }) {
		if name, ok := strings.CutPrefix(s, "docker:"); ok {
			p.containers = append(p.containers, name)
		} else if _, n, err := net.ParseCIDR(s); err == nil {
			p.nets = append(p.nets, n)
		}
	}
	return p
}

func (p *Proxies) Trusts(ip net.IP) bool {
	if p == nil {
		return false
	}
	for _, n := range p.nets {
		if n.Contains(ip) {
			return true
		}
	}
	if len(p.containers) == 0 {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ips[ip.String()] && time.Since(p.at) < time.Minute {
		return true
	}
	if time.Since(p.at) > 5*time.Second {
		p.ips, p.at = map[string]bool{}, time.Now()
		for _, c := range p.containers {
			out, _ := exec.Command("docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", c).Output()
			for _, a := range strings.Fields(string(out)) {
				p.ips[a] = true
			}
		}
	}
	return p.ips[ip.String()]
}

type tailnet struct {
	bin   string
	mu    sync.Mutex
	self  string
	known map[string]tailnetEntry
}

type tailnetEntry struct {
	ok bool
	at time.Time
}

func (t *tailnet) run(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, t.bin, args...).Output()
}

func (t *tailnet) owner(ctx context.Context, ip string) string {
	out, err := t.run(ctx, "whois", "--json", ip)
	if err != nil {
		return ""
	}
	var w struct{ UserProfile struct{ ID json.Number } }
	json.Unmarshal(out, &w)
	return w.UserProfile.ID.String()
}

func (t *tailnet) mine(ctx context.Context, ip string) bool {
	t.mu.Lock()
	if e, ok := t.known[ip]; ok && time.Since(e.at) < 5*time.Minute {
		t.mu.Unlock()
		return e.ok
	}
	self := t.self
	t.mu.Unlock()
	if self == "" {
		if out, err := t.run(ctx, "status", "--json"); err == nil {
			var st struct{ Self struct{ UserID json.Number } }
			json.Unmarshal(out, &st)
			self = st.Self.UserID.String()
		}
	}
	ok := self != "" && t.owner(ctx, ip) == self
	t.mu.Lock()
	t.self = self
	if t.known == nil {
		t.known = map[string]tailnetEntry{}
	}
	t.known[ip] = tailnetEntry{ok, time.Now()}
	t.mu.Unlock()
	return ok
}

func (s *Server) clientIP(r *http.Request) net.IP {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	if ip == nil {
		return nil
	}
	if s.TrustedProxies.Trusts(ip) {
		hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		if fwd := net.ParseIP(strings.TrimSpace(hops[len(hops)-1])); fwd != nil {
			return fwd
		}
	}
	return ip
}

func (s *Server) fromMyTailnet(r *http.Request) bool {
	if s.tailnet == nil {
		return false
	}
	ip := s.clientIP(r)
	return ip != nil && cgnat.Contains(ip) && s.tailnet.mine(r.Context(), ip.String())
}
