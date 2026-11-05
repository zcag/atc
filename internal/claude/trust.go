package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// UntrustedHeader carries, on a refused start, the folder Claude Code has not been trusted in.
const UntrustedHeader = "X-Atc-Untrusted-Dir"

// Untrusted is why `claude --bg` refused a folder. Home is its own case: Claude Code never records
// a yes for the home folder, so its prompt could not help a background session there.
type Untrusted struct {
	Dir  string
	Home bool
}

func (u *Untrusted) Error() string {
	if u.Home {
		return fmt.Sprintf("Claude Code trusts the home folder one session at a time, so a background session can't start in %s. Pick a project folder.", u.Dir)
	}
	return fmt.Sprintf("Claude Code does not trust %s yet, so it won't start a session there. Whoever uses atc has to accept its prompt once: Start in atc's New session shows it, and so does atc new in a terminal.", u.Dir)
}

func (u *Untrusted) Is(target error) bool { return target == ErrUntrusted }

// Trusted says what Claude Code has recorded for dir: a yes counts for everything under that folder.
// It only reads, and only to know when to stop asking; `claude --bg` stays the authority on starting.
func Trusted(dir string) bool {
	path := filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), ".claude.json")
	if os.Getenv("CLAUDE_CONFIG_DIR") == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, ".claude.json")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var cfg struct {
		Projects map[string]struct {
			Accepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if json.Unmarshal(b, &cfg) != nil {
		return false
	}
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
