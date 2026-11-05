package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// UntrustedHeader carries a refused start's folder, as a query string: dir, and parent and host when known.
const UntrustedHeader = "X-Atc-Untrusted"

// Untrusted is why `claude --bg` refused a folder. Home is its own case: Claude Code never records
// a yes for the home folder, so its prompt could not help a background session there. Parent is a
// folder a yes could go to instead, covering this one and its siblings.
type Untrusted struct {
	Dir, Agent, Parent, Host string
	Home                     bool
}

func (u *Untrusted) Error() string {
	who, how := "it won't start a session there", "Start in atc's New session shows it, and so does atc new in a terminal"
	if u.Agent != "" {
		who, how = "@"+u.Agent+" can't start", "the agent's page in atc shows it, and so does atc send @"+u.Agent+" in a terminal"
	}
	if u.Home {
		return fmt.Sprintf("Claude Code trusts the home folder one session at a time, so a background session can't start in %s. Pick a project folder.", u.Dir)
	}
	return fmt.Sprintf("Claude Code does not trust %s yet, so %s. Whoever uses atc has to accept its prompt once: %s.", u.Dir, who, how)
}

func (u *Untrusted) Is(target error) bool { return target == ErrUntrusted }

// Trusted says what Claude Code has recorded for dir: a yes counts for everything under that folder.
// It only reads, and only to know when to stop asking; `claude --bg` stays the authority on starting.
func Trusted(dir string) bool { return Trust()(dir) }

// Trust reads Claude Code's config once, for asking about several folders.
func Trust() func(dir string) bool {
	path := filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), ".claude.json")
	if os.Getenv("CLAUDE_CONFIG_DIR") == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, ".claude.json")
	}
	var cfg struct {
		Projects map[string]struct {
			Accepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &cfg)
	}
	return func(dir string) bool {
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			dir = real
		}
		for {
			if cfg.Projects[dir].Accepted {
				return true
			}
			up := filepath.Dir(dir)
			if up == dir {
				return false
			}
			dir = up
		}
	}
}
