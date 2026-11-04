package resources

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const clockTick = 100.0

var jobPath = regexp.MustCompile(`/jobs/([0-9a-f]{8})\b`)

type proc struct {
	pid, ppid int
	start     uint64
	comm      string
	args      string
	cgroup    string
	job, sess string
	cwd       string
	own       float64
	total     float64
	rss       int64
	pss       int64
	read      int64
	write     int64
	hasIO     bool

	kind, owner string
}

func (p *proc) mem() int64 {
	if p.pss > 0 {
		return p.pss
	}
	return p.rss
}

func (p *proc) name() string {
	first, _, _ := strings.Cut(p.args, " ")
	if base := filepath.Base(first); base == "claude" || strings.Contains(first, "/claude/versions/") {
		return "claude"
	}
	return strings.TrimPrefix(p.comm, "-")
}

type identity struct {
	start          uint64
	comm           string
	args, cgroup   string
	job, sess, cwd string
	cwdRead        bool
	pss, pssRSS    int64
	pssAt          time.Time
}

type scanner struct {
	known map[int]*identity
	page  int64
	boot  int64
}

func newScanner() *scanner {
	sc := &scanner{known: map[int]*identity{}, page: int64(os.Getpagesize())}
	if b, err := os.ReadFile("/proc/stat"); err == nil {
		if _, rest, ok := bytes.Cut(b, []byte("btime ")); ok {
			f := bytes.Fields(rest)
			if len(f) > 0 {
				sc.boot, _ = strconv.ParseInt(string(f[0]), 10, 64)
			}
		}
	}
	return sc
}

func (sc *scanner) scan() map[int]*proc {
	if runtime.GOOS == "linux" {
		return sc.scanProc()
	}
	return scanPS()
}

func (sc *scanner) scanProc() map[int]*proc {
	out := map[int]*proc{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	seen := map[int]bool{}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		p := sc.readStat(pid)
		if p == nil {
			continue
		}
		seen[pid] = true
		id := sc.known[pid]
		if id == nil || id.start != p.start || id.comm != p.comm {
			id = readIdentity(pid, p.start, p.comm)
			sc.known[pid] = id
		}
		if id.args == "" {
			continue
		}
		p.args, p.cgroup, p.job, p.sess = id.args, id.cgroup, id.job, id.sess
		out[pid] = p
	}
	for pid := range sc.known {
		if !seen[pid] {
			delete(sc.known, pid)
		}
	}
	return out
}

func (sc *scanner) readStat(pid int) *proc {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return nil
	}
	open, shut := bytes.IndexByte(b, '('), bytes.LastIndexByte(b, ')')
	if open < 0 || shut < 0 {
		return nil
	}
	f := bytes.Fields(b[shut+1:])
	if len(f) < 22 || f[0][0] == 'Z' {
		return nil
	}
	n := func(i int) float64 { v, _ := strconv.ParseFloat(string(f[i]), 64); return v }
	ppid, _ := strconv.Atoi(string(f[1]))
	if ppid == 2 || pid == 2 {
		return nil
	}
	start, _ := strconv.ParseUint(string(f[19]), 10, 64)
	own := (n(11) + n(12)) / clockTick
	return &proc{pid: pid, ppid: ppid, start: start, comm: string(b[open+1 : shut]), own: own,
		total: own + (n(13)+n(14))/clockTick, rss: int64(n(21)) * sc.page}
}

func readIdentity(pid int, start uint64, comm string) *identity {
	id := &identity{start: start, comm: comm}
	dir := fmt.Sprintf("/proc/%d/", pid)
	if b, err := os.ReadFile(dir + "cmdline"); err == nil {
		id.args = strings.TrimSpace(strings.ReplaceAll(string(b), "\x00", " "))
	}
	if b, err := os.ReadFile(dir + "cgroup"); err == nil {
		_, id.cgroup, _ = strings.Cut(strings.TrimSpace(string(b)), "::")
	}
	if b, err := os.ReadFile(dir + "environ"); err == nil {
		id.job, id.sess = sessionEnv(b)
	}
	if id.job == "" {
		if m := jobPath.FindStringSubmatch(id.args); m != nil {
			id.job = m[1]
		}
	}
	return id
}

func sessionEnv(env []byte) (job, sess string) {
	for len(env) > 0 {
		var v []byte
		v, env, _ = bytes.Cut(env, []byte{0})
		if bytes.HasPrefix(v, []byte("CLAUDE_JOB_DIR=")) {
			job = filepath.Base(string(v[len("CLAUDE_JOB_DIR="):]))
		} else if bytes.HasPrefix(v, []byte("CLAUDE_CODE_SESSION_ID=")) {
			sess = string(v[len("CLAUDE_CODE_SESSION_ID="):])
		}
	}
	return job, sess
}

func (sc *scanner) detail(p *proc) {
	dir := fmt.Sprintf("/proc/%d/", p.pid)
	id := sc.known[p.pid]
	if id != nil && !pssStale(id, p.rss) {
		p.pss = int64(float64(id.pss) * float64(p.rss) / float64(id.pssRSS))
	} else if b, err := os.ReadFile(dir + "smaps_rollup"); err == nil {
		p.pss = field(b, "Pss:") * 1024
		if id != nil {
			id.pss, id.pssRSS, id.pssAt = p.pss, p.rss, time.Now()
		}
	}
	if b, err := os.ReadFile(dir + "io"); err == nil {
		p.read, p.write, p.hasIO = field(b, "read_bytes:"), field(b, "write_bytes:"), true
	}
	if id != nil {
		if !id.cwdRead {
			id.cwd, _ = os.Readlink(dir + "cwd")
			id.cwdRead = true
		}
		p.cwd = id.cwd
	}
}

// pssStale keeps smaps_rollup, by far the slowest read here (about 1.5 ms a process: the kernel walks
// the page tables), to once a minute unless the process has clearly grown or shrunk.
func pssStale(id *identity, rss int64) bool {
	if id.pssRSS <= 0 || id.pss <= 0 || time.Since(id.pssAt) > time.Minute {
		return true
	}
	d := rss - id.pssRSS
	return d > id.pssRSS/10 || -d > id.pssRSS/10
}

func field(b []byte, name string) int64 {
	key := []byte(name)
	for len(b) > 0 {
		var line []byte
		line, b, _ = bytes.Cut(b, []byte{'\n'})
		if bytes.HasPrefix(line, key) {
			f := bytes.Fields(line[len(key):])
			if len(f) == 0 {
				return 0
			}
			v, _ := strconv.ParseInt(string(f[0]), 10, 64)
			return v
		}
	}
	return 0
}

func scanPS() map[int]*proc {
	out := map[int]*proc{}
	b, err := exec.Command("ps", "-axo", "pid=,ppid=,rss=,time=,command=").Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		ppid, _ := strconv.Atoi(f[1])
		rss, _ := strconv.ParseInt(f[2], 10, 64)
		args := strings.Join(f[4:], " ")
		cpu := parseCPUTime(f[3])
		p := &proc{pid: pid, ppid: ppid, comm: filepath.Base(f[4]), args: args, rss: rss * 1024, own: cpu, total: cpu}
		if m := jobPath.FindStringSubmatch(args); m != nil {
			p.job = m[1]
		}
		out[pid] = p
	}
	return out
}

func parseCPUTime(s string) float64 {
	days := 0.0
	if d, rest, ok := strings.Cut(s, "-"); ok {
		days, _ = strconv.ParseFloat(d, 64)
		s = rest
	}
	total := 0.0
	for _, part := range strings.Split(s, ":") {
		v, _ := strconv.ParseFloat(part, 64)
		total = total*60 + v
	}
	return total + days*float64(24*time.Hour/time.Second)
}
