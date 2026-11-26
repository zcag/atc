package sessions

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	inWorktree = regexp.MustCompile(`/\.claude/worktrees/[^/]+`)
	homeAt     = regexp.MustCompile(`^/(home|Users)/[^/]+(/.*)?$`)
	containers = map[string]bool{"proj": true, "projects": true, "src": true, "code": true, "dev": true, "work": true, "repos": true, "git": true, "Developer": true}
)

// Bay is the project a session works in, as the list groups it: the folder under home (or under
// a folder of projects such as ~/proj), its main checkout for a worktree.
func (x Session) Bay() string {
	if x.Kind == "hub" || x.Cwd == "" {
		return ""
	}
	p := inWorktree.ReplaceAllString(x.Cwd, "")
	if home, _ := os.UserHomeDir(); home != "" && (p == home || strings.HasPrefix(p, home+"/")) {
		p = "~" + strings.TrimPrefix(p, home)
	} else if m := homeAt.FindStringSubmatch(p); m != nil {
		p = "~" + m[2]
	}
	parts := strings.Split(p, "/")
	if parts[0] != "~" {
		return filepath.Base(p)
	}
	if len(parts) == 1 || parts[1] == "" {
		return "~"
	}
	i := 1
	if containers[parts[1]] && len(parts) > 2 {
		i = 2
	}
	return parts[i]
}
