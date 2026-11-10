package ends

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type settle struct {
	at      time.Time
	id, how string
	raw     string
}

type retire struct {
	at      time.Time
	id, why string
	raw     string
}

// daemonEvent is something Claude's daemon did to all its sessions at once.
type daemonEvent struct {
	at       time.Time
	kind     string
	cause    string
	from, to string
	raw      string
}

const (
	evDown    = "down"
	evUpgrade = "upgrade"
	evLow     = "low-memory"
)

// Kill is one process the kernel killed for memory.
type Kill struct {
	At     time.Time `json:"at"`
	PID    int       `json:"pid"`
	Name   string    `json:"name"`
	RSS    int64     `json:"rss"`
	Cgroup string    `json:"cgroup,omitempty"`
	Global bool      `json:"global"`
	Raw    []string  `json:"raw,omitempty"`
	Owner  *Owner    `json:"owner,omitempty"`
}

type unitLine struct {
	at   time.Time
	unit string
	raw  string
}

var (
	dLine    = regexp.MustCompile(`^\[([^\]]+)\] \[(?:bg|supervisor)\] (.*)$`)
	dSettle  = regexp.MustCompile(`^bg settled ([0-9a-f]{8}) \(([a-z-]+)\)`)
	dRetire  = regexp.MustCompile(`^bg retire ([0-9a-f]{8}): (.*)$`)
	dDown    = regexp.MustCompile(`^shutting down \(cause=([a-z_]+)`)
	dUpgrade = regexp.MustCompile(`^binary at .* changed \(.*/([^/ ]+) → .*/([^/ )]+)\)`)
	dLow     = regexp.MustCompile(`^bg: low memory`)

	kOOM  = regexp.MustCompile(`oom-kill:constraint=(\w+),.*task_memcg=([^,]*),task=([^,]*),pid=(\d+)`)
	kKill = regexp.MustCompile(`(?:Out of memory|Memory cgroup out of memory): Killed process (\d+) \(([^)]*)\).*anon-rss:(\d+)kB`)
	uOOM  = regexp.MustCompile(`(claude-daemon-[0-9a-z-]+\.scope): (The kernel OOM killer killed some processes in this unit\.|Failed with result 'oom-kill'\.|Stopping timed out\. Killing\.)`)
)

// readDaemon parses Claude's daemon.log from offset on, and returns where it stopped reading.
func (w *Watcher) readDaemon(path string, offset int64) int64 {
	f, err := os.Open(path)
	if err != nil {
		return offset
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() < offset {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset
	}
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return offset
		}
		offset += int64(len(line))
		w.daemonLine(strings.TrimRight(line, "\n"))
	}
}

func (w *Watcher) daemonLine(line string) {
	m := dLine.FindStringSubmatch(line)
	if m == nil {
		return
	}
	at, err := time.Parse(time.RFC3339Nano, m[1])
	if err != nil {
		return
	}
	at, msg := at.Local(), m[2]
	if x := dSettle.FindStringSubmatch(msg); x != nil {
		w.settles[x[1]] = append(w.settles[x[1]], settle{at, x[1], x[2], line})
	} else if x := dRetire.FindStringSubmatch(msg); x != nil {
		w.retires[x[1]] = append(w.retires[x[1]], retire{at, x[1], x[2], line})
	} else if x := dDown.FindStringSubmatch(msg); x != nil {
		w.daemon = append(w.daemon, daemonEvent{at: at, kind: evDown, cause: x[1], raw: line})
	} else if x := dUpgrade.FindStringSubmatch(msg); x != nil {
		w.daemon = append(w.daemon, daemonEvent{at: at, kind: evUpgrade, from: x[1], to: x[2], raw: line})
	} else if dLow.MatchString(msg) {
		w.daemon = append(w.daemon, daemonEvent{at: at, kind: evLow, raw: line})
	}
}

// journal is journalctl's lines since a moment that match pattern, as (time, line).
func journal(since time.Time, pattern string, user bool) [][2]string {
	if runtime.GOOS != "linux" {
		return nil
	}
	args := []string{"-k"}
	if user {
		args = []string{"--user"}
	}
	args = append(args, "-o", "short-unix", "--no-pager", "-q", "--since", "@"+strconv.FormatInt(since.Unix(), 10), "--grep", pattern)
	out, err := exec.Command("journalctl", args...).Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	var lines [][2]string
	for _, l := range strings.Split(string(out), "\n") {
		f := strings.SplitN(l, " ", 3)
		if len(f) < 3 {
			continue
		}
		if _, msg, ok := strings.Cut(f[2], ": "); ok {
			lines = append(lines, [2]string{f[0], msg})
		}
	}
	return lines
}

func unixTime(s string) time.Time {
	sec, frac, _ := strings.Cut(s, ".")
	n, _ := strconv.ParseInt(sec, 10, 64)
	us, _ := strconv.ParseInt((frac + "000000")[:6], 10, 64)
	return time.Unix(n, us*1000)
}

// kernelKills reads the kernel's OOM kills since a moment. The kernel writes two lines per kill:
// which cgroup it was in, then what it was and how big.
func kernelKills(since time.Time) []Kill {
	var kills []Kill
	where := map[string][2]string{}
	for _, l := range journal(since, `oom-kill:|Killed process`, false) {
		if m := kOOM.FindStringSubmatch(l[1]); m != nil {
			where[m[4]] = [2]string{m[2], l[1]}
			continue
		}
		m := kKill.FindStringSubmatch(l[1])
		if m == nil {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		kb, _ := strconv.ParseInt(m[3], 10, 64)
		k := Kill{At: unixTime(l[0]), PID: pid, Name: m[2], RSS: kb << 10, Global: strings.HasPrefix(l[1], "Out of memory")}
		if w, ok := where[m[1]]; ok {
			k.Cgroup, k.Raw = w[0], []string{w[1]}
		}
		k.Raw = append(k.Raw, l[1])
		kills = append(kills, k)
	}
	return kills
}

func unitLines(since time.Time) []unitLine {
	var out []unitLine
	for _, l := range journal(since, `claude-daemon-.*\.scope: (The kernel OOM killer|Failed with result 'oom-kill'|Stopping timed out)`, true) {
		if m := uOOM.FindStringSubmatch(l[1]); m != nil {
			out = append(out, unitLine{unixTime(l[0]), m[1], l[1]})
		}
	}
	return out
}

// bootTime is when this machine last started.
func bootTime() time.Time {
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("sysctl", "-n", "kern.boottime").Output()
		if err == nil {
			if _, rest, ok := strings.Cut(string(out), "sec = "); ok {
				sec, _, _ := strings.Cut(rest, ",")
				if n, err := strconv.ParseInt(strings.TrimSpace(sec), 10, 64); err == nil {
					return time.Unix(n, 0)
				}
			}
		}
		return time.Time{}
	}
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(l, "btime "); ok {
			n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return time.Unix(n, 0)
		}
	}
	return time.Time{}
}
