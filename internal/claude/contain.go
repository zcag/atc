package claude

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// Contain moves Claude's daemon and its process tree into a scope in c.Slice when it runs
// elsewhere: any claude command, not just Launch's `--bg`, starts the daemon when there is none.
func (c CLI) Contain() (string, error) {
	if c.Slice == "" {
		return "", nil
	}
	parent := map[int]int{}
	daemon := 0
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if ppid, ok := ppidOf(pid); ok {
			parent[pid] = ppid
		}
		if isDaemon(pid) {
			daemon = pid
		}
	}
	if daemon == 0 {
		return "", nil
	}
	home := cgroupOf(daemon)
	if home == "" || slices.Contains(strings.Split(home, "/"), c.Slice) {
		return "", nil
	}
	var pids []string
	for pid := range parent {
		if under(pid, daemon, parent) && cgroupOf(pid) == home {
			pids = append(pids, strconv.Itoa(pid))
		}
	}
	unit := fmt.Sprintf("claude-daemon-%d.scope", daemon)
	args := append([]string{"--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
		"org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail",
		"4", "PIDs", "au", strconv.Itoa(len(pids))}, pids...)
	args = append(args, "Slice", "s", c.Slice, "CollectMode", "s", "inactive-or-failed", "OOMPolicy", "s", "continue", "0")
	if out, err := exec.Command("busctl", args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("move %d processes from %s into %s: %v: %s", len(pids), home, unit, err, strings.TrimSpace(string(out)))
	}
	return fmt.Sprintf("%s (%d processes from %s)", unit, len(pids), home), nil
}

func under(pid, root int, parent map[int]int) bool {
	for range 64 {
		if pid == root {
			return true
		}
		p, ok := parent[pid]
		if !ok || p <= 1 {
			return false
		}
		pid = p
	}
	return false
}

func ppidOf(pid int) (int, bool) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, false
	}
	i := strings.LastIndexByte(string(b), ')')
	f := strings.Fields(string(b[i+1:]))
	if len(f) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(f[1])
	return ppid, err == nil
}

func isDaemon(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	argv := strings.Split(string(b), "\x00")
	return len(argv) >= 3 && strings.HasPrefix(filepath.Base(argv[0]), "claude") && argv[1] == "daemon" && argv[2] == "run"
}

func cgroupOf(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return ""
	}
	_, path, _ := strings.Cut(strings.TrimSpace(string(b)), "::")
	return path
}
