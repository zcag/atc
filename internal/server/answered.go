package server

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
)

const answeredFor = time.Hour

type answers struct {
	mu sync.Mutex
	m  map[string]sessions.Answered
}

func (a *answers) mark(sid string, x sessions.Answered) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.m == nil {
		a.m = map[string]sessions.Answered{}
	}
	for k, v := range a.m {
		if time.Since(v.At) > answeredFor {
			delete(a.m, k)
		}
	}
	a.m[sid] = x
}

func (a *answers) attach(list []sessions.Session) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := range list {
		x, ok := a.m[list[i].SessionID]
		if !ok {
			x, ok = a.m[list[i].ID]
		}
		if ok && time.Since(x.At) < answeredFor {
			list[i].Answered = &x
		}
	}
}

func answerWhat(a opencode.Answer) string {
	switch {
	case a.Reject:
		return "Deny"
	case a.Reply == "always":
		return "Always allow"
	case a.Reply != "":
		return "Allow once"
	}
	var picked []string
	for _, x := range a.Answers {
		picked = append(picked, strings.Join(x, ", "))
	}
	return strings.Join(picked, "; ")
}

// pushAsk is the session's first ask as push and the widget carry it. Options come only for a
// single question; anything else is answered in atc.
func pushAsk(x sessions.Session) *push.Ask {
	if len(x.Asks) == 0 {
		return nil
	}
	a := x.Asks[0]
	out := &push.Ask{SID: x.SessionID, ID: a.ID, Key: a.Fingerprint(), Host: x.Host}
	if a.Permission != "" {
		out.Tool, out.Cmd = a.Permission, strings.Join(a.Patterns, " ")
		return out
	}
	if len(a.Questions) == 0 {
		return nil
	}
	q := a.Questions[0]
	out.Text = q.Question
	if len(a.Questions) > 1 {
		return out
	}
	for _, o := range q.Options {
		out.Options = append(out.Options, o.Label)
	}
	return out
}

func askBody(a *push.Ask) string {
	switch {
	case a.Tool == "Bash":
		return "Wants to run " + a.Cmd
	case a.Tool != "":
		return strings.TrimSuffix("Wants to use "+a.Tool+": "+a.Cmd, ": ")
	}
	return a.Text
}

var (
	inWorktree = regexp.MustCompile(`/\.claude/worktrees/[^/]+`)
	homeDir    = regexp.MustCompile(`^/(home|Users)/[^/]+(/.*)?$`)
	containers = map[string]bool{"proj": true, "projects": true, "src": true, "code": true, "dev": true, "work": true, "repos": true, "git": true, "Developer": true}
)

func bayOf(x sessions.Session) string {
	if x.Kind == "hub" || x.Cwd == "" {
		return ""
	}
	p := inWorktree.ReplaceAllString(x.Cwd, "")
	if home, _ := os.UserHomeDir(); home != "" && (p == home || strings.HasPrefix(p, home+"/")) {
		p = "~" + strings.TrimPrefix(p, home)
	} else if m := homeDir.FindStringSubmatch(p); m != nil {
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
