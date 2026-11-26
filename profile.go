package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
)

// sharedConfig is what a profile links from the default Claude folder: everything that is how you work, nothing that
// is one account's (sign-in, transcripts, history, the daemon).
var sharedConfig = []string{"CLAUDE.md", "settings.json", "settings.local.json", "keybindings.json", "skills", "commands", "agents", "plugins", "hooks", "output-styles"}

// sharedState is what a profile's .claude.json takes from the default one.
var sharedState = []string{"mcpServers", "hasCompletedOnboarding", "lastOnboardingVersion", "theme", "installMethod", "autoUpdates"}

func profilesPath() string { return filepath.Join(client.ConfigDir(), "profiles.json") }

func profileCmd(args []string) error {
	if len(args) == 0 {
		return listProfiles()
	}
	switch args[0] {
	case "add":
		fs := flags("profile")
		dir := fs.String("dir", "", "its Claude config folder (default ~/.claude-<name>)")
		if len(args) < 2 {
			return usageErr("profile")
		}
		name := args[1]
		fs.Parse(args[2:])
		if fs.NArg() == 0 {
			return errors.New("name the folders whose sessions run on this account")
		}
		home, _ := os.UserHomeDir()
		if *dir == "" {
			*dir = filepath.Join(home, ".claude-"+name)
		}
		var paths []string
		for _, p := range fs.Args() {
			abs, err := filepath.Abs(expandHome(p))
			if err != nil {
				return err
			}
			paths = append(paths, abs)
		}
		p := claude.Profile{Name: name, Dir: expandHome(*dir), Paths: paths}
		if err := addProfile(profilesPath(), claude.DefaultProfile(), p); err != nil {
			return err
		}
		fmt.Printf("%s: sessions under %s run in %s.\n", name, strings.Join(paths, ", "), p.Dir)
		if !signedInAs(p) {
			fmt.Printf("Sign it in to that account:\n  CLAUDE_CONFIG_DIR=%s claude auth login\n", p.Dir)
		}
		fmt.Println("Then restart atc (atc service install, or restart its service) so it reads the profile.")
		return nil
	case "move":
		if len(args) != 3 {
			return usageErr("profile")
		}
		c := client.Load()
		s, err := c.Find(args[1], true)
		if err != nil {
			return err
		}
		id, err := c.Move(s.SessionID, args[2])
		if err != nil {
			return err
		}
		if id != "" {
			fmt.Printf("Moved %s to %s; it runs there now as %s.\n", s.Title, args[2], id)
		} else {
			fmt.Printf("Moved %s to %s; it resumes there.\n", s.Title, args[2])
		}
		return nil
	case "rm":
		if len(args) != 2 {
			return usageErr("profile")
		}
		if err := rmProfile(profilesPath(), args[1]); err != nil {
			return err
		}
		fmt.Printf("Removed %s; its folders' sessions run on the default account once atc restarts.\n", args[1])
		return nil
	case "-h", "--help", "help":
		printHelp("profile")
		return nil
	}
	return fmt.Errorf("atc profile: no command %q (atc profile -h)", args[0])
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, p[1:])
	}
	return p
}

func listProfiles() error {
	var rows [][]string
	for _, p := range claude.Profiles() {
		where := "every other folder"
		if !p.Default() {
			where = strings.Join(p.Paths, ", ")
		}
		state := "not signed in"
		if signedInAs(p) {
			state = "signed in"
		}
		rows = append(rows, []string{p.Name, state, p.Home(), where})
	}
	printLines(table([]string{"Profile", "Sign-in", "Config folder", "Sessions under"}, rows, nil, nil, painter()))
	return nil
}

func signedInAs(p claude.Profile) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, cmp.Or(os.Getenv("ATC_CLAUDE_BIN"), "claude"), "auth", "status")
	cmd.Env = append(os.Environ(), p.Env()...)
	out, err := cmd.Output()
	var st struct {
		LoggedIn bool `json:"loggedIn"`
	}
	return err == nil && json.Unmarshal(out, &st) == nil && st.LoggedIn
}

func readProfiles(path string) ([]claude.Profile, error) {
	var ps []claude.Profile
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err == nil {
		err = json.Unmarshal(b, &ps)
	}
	return ps, err
}

func writeProfiles(path string, ps []claude.Profile) error {
	b, _ := json.MarshalIndent(ps, "", "  ")
	os.MkdirAll(filepath.Dir(path), 0o700)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// addProfile makes p's config folder from base's, sharing what is how you work, and records p in profiles.json,
// replacing a profile of the same name.
func addProfile(path string, base, p claude.Profile) error {
	if p.Default() || filepath.Clean(p.Dir) == filepath.Clean(base.Home()) {
		return errors.New("a profile needs a config folder of its own, not the default one")
	}
	if err := os.MkdirAll(p.Dir, 0o700); err != nil {
		return err
	}
	for _, name := range sharedConfig {
		src, dst := filepath.Join(base.Home(), name), filepath.Join(p.Dir, name)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if _, err := os.Lstat(dst); err == nil {
			continue
		}
		if err := os.Symlink(src, dst); err != nil {
			return err
		}
	}
	if err := shareState(base.State(), p.State()); err != nil {
		return err
	}
	ps, err := readProfiles(path)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	ps = slices.DeleteFunc(ps, func(o claude.Profile) bool { return o.Name == p.Name })
	return writeProfiles(path, append(ps, p))
}

// shareState brings sharedState from Claude Code's state file at from into the one at to, keeping everything else
// in it, and MCP servers it has that from does not.
func shareState(from, to string) error {
	src, dst := map[string]json.RawMessage{}, map[string]json.RawMessage{}
	if b, err := os.ReadFile(from); err == nil {
		if err := json.Unmarshal(b, &src); err != nil {
			return fmt.Errorf("%s: %w", from, err)
		}
	}
	if b, err := os.ReadFile(to); err == nil {
		if err := json.Unmarshal(b, &dst); err != nil {
			return fmt.Errorf("%s: %w", to, err)
		}
	}
	for _, k := range sharedState {
		v, ok := src[k]
		if !ok {
			continue
		}
		if k == "mcpServers" {
			merged := map[string]json.RawMessage{}
			json.Unmarshal(dst[k], &merged)
			var theirs map[string]json.RawMessage
			json.Unmarshal(v, &theirs)
			for name, s := range theirs {
				merged[name] = s
			}
			v, _ = json.Marshal(merged)
		}
		dst[k] = v
	}
	b, _ := json.MarshalIndent(dst, "", "  ")
	tmp := to + ".atc"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, to)
}

func rmProfile(path, name string) error {
	ps, err := readProfiles(path)
	if err != nil {
		return err
	}
	n := len(ps)
	if ps = slices.DeleteFunc(ps, func(o claude.Profile) bool { return o.Name == name }); len(ps) == n {
		return fmt.Errorf("no profile called %s", name)
	}
	return writeProfiles(path, ps)
}
