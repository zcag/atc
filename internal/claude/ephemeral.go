package claude

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed private
var private embed.FS

// Kept is what an ephemeral profile's Dir holds and its Home links to: all of it that outlasts a reboot, beside the
// token it signs in with.
var Kept = []string{"CLAUDE.md", "settings.json"}

// Onboarding is what any profile's state file takes from the default one, so a new folder starts no first-run setup.
var Onboarding = []string{"hasCompletedOnboarding", "lastOnboardingVersion", "theme", "installMethod", "autoUpdates"}

// MemoryDir is where ephemeral profiles keep their sessions: the user's runtime folder, in memory and emptied at
// reboot. "" when there is none.
func MemoryDir() string {
	d := os.Getenv("XDG_RUNTIME_DIR")
	if st, err := os.Stat(d); d == "" || err != nil || !st.IsDir() {
		return ""
	}
	return d
}

// Scratch is the folder an ephemeral profile's sessions run in, one folder each.
func (p Profile) Scratch() string { return filepath.Join(p.Home(), "work") }

func (p Profile) TokenFile() string { return filepath.Join(p.Dir, "oauth-token") }

// Token is the long-lived sign-in an ephemeral profile's sessions run on (`claude setup-token`), kept in Dir since
// Home does not outlast a reboot.
func (p Profile) Token() string {
	b, _ := os.ReadFile(p.TokenFile())
	return string(bytes.TrimSpace(b))
}

// Init writes an ephemeral profile's instructions and settings into its Dir, keeping any already there.
func (p Profile) Init() error {
	if err := os.MkdirAll(p.Dir, 0o700); err != nil {
		return err
	}
	for _, name := range Kept {
		dst := filepath.Join(p.Dir, name)
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		b, _ := private.ReadFile("private/" + name)
		if err := os.WriteFile(dst, b, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// Prepare makes an ephemeral profile's Home, which a reboot removes: its folders, links to what Dir keeps, and a
// state file without the default profile's MCP servers.
func (p Profile) Prepare() error {
	if !p.Ephemeral {
		return nil
	}
	for _, d := range []string{p.Home(), filepath.Join(p.Home(), "tmp"), p.Scratch()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	for _, name := range Kept {
		dst := filepath.Join(p.Home(), name)
		if _, err := os.Lstat(dst); err == nil {
			continue
		}
		if err := os.Symlink(filepath.Join(p.Dir, name), dst); err != nil {
			return err
		}
	}
	if _, err := os.Stat(p.State()); errors.Is(err, os.ErrNotExist) {
		return ShareState(DefaultProfile().State(), p.State(), Onboarding)
	}
	return nil
}

// Owner is the profile of the session id, named by its job's short id or its conversation's.
func Owner(id string) Profile {
	if p := ProfileOf(id); !p.Default() {
		return p
	}
	return ProfileOfSession(id)
}

// Private says whether the session id runs on an ephemeral profile.
func Private(id string) bool { return id != "" && Owner(id).Ephemeral }

// NewScratch is a new, empty folder for one private session.
func (p Profile) NewScratch() (string, error) {
	if err := p.Prepare(); err != nil {
		return "", err
	}
	return os.MkdirTemp(p.Scratch(), "private-")
}

// Erase deletes everything the ephemeral profile p keeps of the conversation sid: its files and its lines in the
// prompt history. It refuses any other profile, whose conversations outlive their sessions on purpose.
func Erase(p Profile, sid string) error {
	if !p.Ephemeral {
		return fmt.Errorf("%s keeps its conversations: only a private session is erased", p.Name)
	}
	if m, _ := filepath.Glob(filepath.Join(p.Projects(), "*", sid+".jsonl")); len(m) > 0 {
		for _, f := range files(p, sid, m[0]) {
			if err := os.RemoveAll(f); err != nil {
				return err
			}
		}
	}
	return dropLines(filepath.Join(p.Home(), "history.jsonl"), sid)
}

func dropLines(path, sid string) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(nil, 64<<20)
	for sc.Scan() {
		var l struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(sc.Bytes(), &l) == nil && l.SessionID == sid {
			continue
		}
		out.Write(append(sc.Bytes(), '\n'))
	}
	if out.Len() == len(b) {
		return nil
	}
	tmp := path + ".atc"
	if err := os.WriteFile(tmp, out.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ShareState brings keys from Claude Code's state file at from into the one at to, keeping everything else in it,
// and MCP servers it has that from does not.
func ShareState(from, to string, keys []string) error {
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
	for _, k := range keys {
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
