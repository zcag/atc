package resources

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

type DiskUse struct {
	Path     string   `json:"path"`
	Kind     string   `json:"kind"`
	Size     int64    `json:"size"`
	Sessions []string `json:"sessions,omitempty"`
}

type diskScan struct {
	At   time.Time `json:"at"`
	Uses []DiskUse `json:"uses"`
}

func duSize(path string, except []string) int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	args := []string{"-n", "19"}
	if p, err := exec.LookPath("ionice"); err == nil {
		args = append(args, p, "-c", "3")
	}
	args = append(args, "du", "-skx")
	if runtime.GOOS == "linux" {
		for _, e := range except {
			args = append(args, "--exclude="+e)
		}
	}
	// du exits non-zero on a file that vanished or is unreadable; what it could add up still counts.
	b, _ := exec.CommandContext(ctx, "nice", append(args, path)...).Output()
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	kb, _ := strconv.ParseInt(f[0], 10, 64)
	return kb * 1024
}

func git(dir string, args ...string) string {
	b, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func repoOf(cwd string) string {
	common := git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if filepath.Base(common) != ".git" {
		return ""
	}
	return filepath.Dir(common)
}

func worktrees(repo string) []string {
	var out []string
	for _, line := range strings.Split(git(repo, "worktree", "list", "--porcelain"), "\n") {
		if p, ok := strings.CutPrefix(line, "worktree "); ok && p != repo {
			if _, err := os.Stat(p); err == nil {
				out = append(out, p)
			}
		}
	}
	return out
}

// diskEntries lists what to measure: every repo a session works in with each of its worktrees, and
// a folder that is no repo itself, like one holding many worktrees, with the repos directly inside it.
// A session's working folder decides; what its processes sit in only adds repos.
func diskEntries(cwds, inside []string, claudeDir string) map[string]string {
	home, _ := os.UserHomeDir()
	out := map[string]string{}
	addRepo := func(r string) {
		out[r] = "repo"
		for _, w := range worktrees(r) {
			out[w] = "worktree"
		}
	}
	mine := func(p string) bool { return p != home && within(home, p) && !within(claudeDir, p) }
	for _, c := range cwds {
		if !mine(c) {
			continue
		}
		if r := repoOf(c); r != "" {
			addRepo(r)
			continue
		}
		out[c] = "folder"
		entries, _ := os.ReadDir(c)
		for _, e := range entries {
			if _, err := os.Stat(filepath.Join(c, e.Name(), ".git")); err == nil {
				if r := repoOf(filepath.Join(c, e.Name())); r != "" {
					addRepo(r)
				}
			}
		}
	}
	for _, c := range inside {
		if mine(c) {
			if r := repoOf(c); r != "" {
				addRepo(r)
			}
		}
	}
	for _, name := range []string{"projects", "jobs"} {
		out[filepath.Join(claudeDir, name)] = "claude"
	}
	return out
}

// measureDisk sizes each entry leaving out the entries nested in it. Excluding rather than
// subtracting matters: worktrees that share hardlinked files add up to more than their parent.
func measureDisk(cwds, inside []string, claudeDir string) []DiskUse {
	entries := diskEntries(cwds, inside, claudeDir)
	var out []DiskUse
	for path, kind := range entries {
		var nested []string
		for other := range entries {
			if other != path && within(path, other) {
				nested = append(nested, other)
			}
		}
		out = append(out, DiskUse{Path: path, Kind: kind, Size: duSize(path, nested)})
	}
	if runtime.GOOS != "linux" {
		subtractNested(out)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Size > out[j].Size })
	return out
}

func subtractNested(uses []DiskUse) {
	raw := make([]int64, len(uses))
	for i, u := range uses {
		raw[i] = u.Size
	}
	for i := range uses {
		for j, o := range uses {
			if i == j || !within(uses[i].Path, o.Path) {
				continue
			}
			direct := true
			for _, between := range uses {
				if between.Path != uses[i].Path && between.Path != o.Path && within(uses[i].Path, between.Path) && within(between.Path, o.Path) {
					direct = false
				}
			}
			if direct {
				uses[i].Size -= raw[j]
			}
		}
		uses[i].Size = max(uses[i].Size, 0)
	}
}

func loadDisk(path string) diskScan {
	var d diskScan
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &d)
	}
	return d
}

func saveDisk(path string, d diskScan) {
	b, err := json.Marshal(d)
	if err != nil {
		return
	}
	os.MkdirAll(filepath.Dir(path), 0o755)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, path)
	}
}

func within(dir, path string) bool {
	return path == dir || strings.HasPrefix(path, dir+"/")
}

// claimDisk names the sessions working in each line. A line only claims sessions not already inside
// something nested in it.
func claimDisk(uses []DiskUse, dirs map[string][]string) []DiskUse {
	out := make([]DiskUse, len(uses))
	for i, u := range uses {
		u.Sessions = nil
		if u.Kind != "claude" {
			for title, paths := range dirs {
				if claimedBy(uses, u, paths) {
					u.Sessions = append(u.Sessions, title)
				}
			}
			sort.Strings(u.Sessions)
		}
		out[i] = u
	}
	return out
}

func claimedBy(uses []DiskUse, u DiskUse, paths []string) bool {
	for _, p := range paths {
		if !within(u.Path, p) {
			continue
		}
		nested := false
		for _, other := range uses {
			if other.Path != u.Path && within(u.Path, other.Path) && within(other.Path, p) {
				nested = true
			}
		}
		if !nested {
			return true
		}
	}
	return false
}
