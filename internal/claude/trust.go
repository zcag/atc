package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// Untrusted is why `claude --bg` refused a folder after atc recorded its trust. Home is its own case:
// Claude Code trusts the home folder one session at a time, so no recorded yes helps there.
type Untrusted struct {
	Dir  string
	Home bool
	Why  error
}

func (u *Untrusted) Error() string {
	if u.Home {
		return fmt.Sprintf("Claude Code trusts the home folder one session at a time, so a background session can't start in %s. Pick a project folder.", u.Dir)
	}
	return fmt.Sprintf("Claude Code does not trust %s, and recording its trust failed: %v", u.Dir, u.Why)
}

func (u *Untrusted) Is(target error) bool { return target == ErrUntrusted }

var accepting sync.Mutex

func configPath() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, ".claude.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude.json")
}

// bg runs a `claude --bg` and, when Claude Code refuses the folder only for want of its trust prompt,
// records the yes the prompt would and runs it again: a git repo needs its own yes even when a folder
// above it has one, so anything new under an already trusted home would otherwise need a terminal.
func (c CLI) bg(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := c.run(ctx, dir, args...)
	u, ok := err.(*Untrusted)
	if !ok || u.Home {
		return out, err
	}
	root := trustRoot(ctx, dir)
	if u.Why = Accept(root); u.Why != nil {
		return out, u
	}
	log.Printf("trust: recorded Claude Code's trust for %s", root)
	out, err = c.run(ctx, dir, args...)
	if u, ok := err.(*Untrusted); ok && u.Why == nil {
		u.Why = fmt.Errorf("Claude Code still refuses it with the trust recorded for %s", root)
	}
	return out, err
}

// trustRoot is the folder Claude Code asks about for dir: its git repo's top, else dir itself.
func trustRoot(ctx context.Context, dir string) string {
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
	cmd.Dir = dir
	if out, err := cmd.Output(); err == nil && strings.TrimSpace(string(out)) != "" {
		return strings.TrimSpace(string(out))
	}
	return dir
}

// Accept records a yes to Claude Code's trust prompt for dir in its config, as the prompt itself would,
// leaving everything else in the file as it was. Claude Code rewrites the file by renaming a new one
// over it, so this does the same.
func Accept(dir string) error {
	accepting.Lock()
	defer accepting.Unlock()
	path := configPath()
	var cfg map[string]json.RawMessage
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &cfg); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
	}
	if cfg == nil {
		cfg = map[string]json.RawMessage{}
	}
	projects := map[string]map[string]json.RawMessage{}
	if raw, ok := cfg["projects"]; ok {
		if err := json.Unmarshal(raw, &projects); err != nil {
			return fmt.Errorf("%s projects: %w", path, err)
		}
	}
	if projects[dir] == nil {
		projects[dir] = map[string]json.RawMessage{}
	}
	projects[dir]["hasTrustDialogAccepted"] = json.RawMessage("true")
	if cfg["projects"], err = json.Marshal(projects); err != nil {
		return err
	}
	if b, err = json.MarshalIndent(cfg, "", "  "); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".claude.json.atc-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(b); err == nil {
		err = tmp.Chmod(mode)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
