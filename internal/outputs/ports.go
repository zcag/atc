package outputs

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Listener struct {
	Port      int       `json:"port"`
	LocalOnly bool      `json:"localOnly,omitempty"`
	Started   time.Time `json:"-"`
	pid       int
}

type Ports struct {
	mu   sync.Mutex
	at   time.Time
	list []Listener
	tree map[int]int
}

var ssPid = regexp.MustCompile(`pid=(\d+)`)

func (p *Ports) refresh() {
	if time.Since(p.at) < 8*time.Second {
		return
	}
	p.at = time.Now()
	p.list, p.tree = listeners(), parents()
}

func (p *Ports) Of(pids ...int) []Listener {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refresh()
	roots := map[int]bool{}
	for _, pid := range pids {
		if pid > 0 {
			roots[pid] = true
		}
	}
	var out []Listener
	seen := map[int]bool{}
	for _, l := range p.list {
		if seen[l.Port] || roots[l.pid] {
			continue
		}
		for pid, hops := l.pid, 0; pid > 1 && hops < 64; pid, hops = p.tree[pid], hops+1 {
			if roots[pid] {
				out = append(out, l)
				seen[l.Port] = true
				break
			}
		}
	}
	return out
}

func (p *Ports) Listening(port int) (Listener, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refresh()
	for _, l := range p.list {
		if l.Port == port {
			return l, true
		}
	}
	return Listener{}, false
}

func listeners() []Listener {
	byPort := map[int]*Listener{}
	add := func(addr string, pid int) {
		i := strings.LastIndex(addr, ":")
		port, err := strconv.Atoi(addr[i+1:])
		if i < 0 || err != nil {
			return
		}
		host := strings.Trim(addr[:i], "[]")
		local := host == "127.0.0.1" || host == "::1" || host == "localhost"
		if l, ok := byPort[port]; ok {
			l.LocalOnly = l.LocalOnly && local
			return
		}
		byPort[port] = &Listener{Port: port, LocalOnly: local, pid: pid}
	}
	if runtime.GOOS == "darwin" {
		out, _ := exec.Command(bin("lsof", "/usr/sbin/lsof"), "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn").Output()
		pid := 0
		for _, line := range strings.Split(string(out), "\n") {
			switch {
			case strings.HasPrefix(line, "p"):
				pid, _ = strconv.Atoi(line[1:])
			case strings.HasPrefix(line, "n"):
				add(line[1:], pid)
			}
		}
	} else {
		out, _ := exec.Command(bin("ss", "/usr/sbin/ss"), "-ltnpH").Output()
		sc := bufio.NewScanner(bytes.NewReader(out))
		for sc.Scan() {
			f := strings.Fields(sc.Text())
			if len(f) < 6 {
				continue
			}
			pid := 0
			if m := ssPid.FindStringSubmatch(sc.Text()); m != nil {
				pid, _ = strconv.Atoi(m[1])
			}
			add(f[3], pid)
		}
	}
	self := os.Getpid()
	for port, l := range byPort {
		if l.pid == self {
			delete(byPort, port)
		}
	}
	var pids []string
	for _, l := range byPort {
		pids = append(pids, strconv.Itoa(l.pid))
	}
	started := startTimes(pids)
	var list []Listener
	for _, l := range byPort {
		l.Started = started[l.pid]
		list = append(list, *l)
	}
	return list
}

func startTimes(pids []string) map[int]time.Time {
	out := map[int]time.Time{}
	if len(pids) == 0 {
		return out
	}
	b, _ := exec.Command("ps", "-o", "pid=,etime=", "-p", strings.Join(pids, ",")).Output()
	now := time.Now()
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		if d, ok := elapsed(f[1]); ok {
			out[pid] = now.Add(-d)
		}
	}
	return out
}

func elapsed(s string) (time.Duration, bool) {
	days := 0
	if d, rest, ok := strings.Cut(s, "-"); ok {
		days, _ = strconv.Atoi(d)
		s = rest
	}
	parts := strings.Split(s, ":")
	secs := 0
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return 0, false
		}
		secs = secs*60 + n
	}
	return time.Duration(days*86400+secs) * time.Second, true
}

func parents() map[int]int {
	out, _ := exec.Command("ps", "-axo", "pid=,ppid=").Output()
	tree := map[int]int{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		ppid, _ := strconv.Atoi(f[1])
		tree[pid] = ppid
	}
	return tree
}

func bin(name, fallback string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return fallback
}
