package claude

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// A Profile is one Claude Code account: its own config folder, so its own sign-in, transcripts and background
// daemon. The default profile is Claude Code's usual folder; others are chosen by the folder a session runs in.
//
// An ephemeral profile is for private sessions: Dir keeps only its instructions, settings and sign-in, and everything
// a session writes goes to Home, a folder in memory that a reboot empties. Its sessions run in folders under Scratch.
type Profile struct {
	Name      string   `json:"name"`
	Dir       string   `json:"dir,omitempty"`
	Paths     []string `json:"paths,omitempty"`
	Ephemeral bool     `json:"ephemeral,omitempty"`
}

const DefaultName = "default"

var (
	profilesMu sync.RWMutex
	profiles   = []Profile{{Name: DefaultName}}
	jobProfile sync.Map
)

func (p Profile) Default() bool { return p.Dir == "" }

// Home is the profile's Claude Code config folder.
func (p Profile) Home() string {
	if p.Default() {
		return ConfigDir()
	}
	if p.Ephemeral {
		return filepath.Join(MemoryDir(), "atc-"+p.Name)
	}
	return p.Dir
}

func (p Profile) Projects() string { return filepath.Join(p.Home(), "projects") }

// Env is what a claude process needs in its environment to run as this profile.
func (p Profile) Env() []string {
	if p.Default() {
		return nil
	}
	if !p.Ephemeral {
		return []string{"CLAUDE_CONFIG_DIR=" + p.Dir}
	}
	env := []string{"CLAUDE_CONFIG_DIR=" + p.Home(), "TMPDIR=" + filepath.Join(p.Home(), "tmp"), "ENABLE_CLAUDEAI_MCP_SERVERS=false"}
	if tok := p.Token(); tok != "" {
		env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+tok)
	}
	return env
}

// State is the file Claude Code keeps its trust list and cached usage in: beside the default folder, inside any other.
func (p Profile) State() string {
	if !p.Default() || os.Getenv("CLAUDE_CONFIG_DIR") != "" {
		return filepath.Join(p.Home(), ".claude.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude.json")
}

// LoadProfiles reads profiles.json: a list of {name, dir, paths}. An entry without a dir names the default profile.
// A missing file leaves only the default.
func LoadProfiles(path string) error {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var in []Profile
	if err := json.Unmarshal(b, &in); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return SetProfiles(in)
}

func SetProfiles(in []Profile) error {
	out := []Profile{{Name: DefaultName}}
	seen := map[string]bool{}
	for _, p := range in {
		p.Dir = expand(p.Dir)
		if filepath.Clean(p.Dir) == filepath.Clean(ConfigDir()) {
			p.Dir = ""
		}
		for i, d := range p.Paths {
			p.Paths[i] = filepath.Clean(expand(d))
		}
		if p.Name == "" || seen[p.Name] {
			return fmt.Errorf("profiles: every profile needs a name of its own, got %q", p.Name)
		}
		if p.Ephemeral && (p.Default() || MemoryDir() == "") {
			log.Printf("profiles: %s is ephemeral, which needs a folder of its own and a memory folder ($XDG_RUNTIME_DIR); left out", p.Name)
			continue
		}
		if p.Ephemeral {
			p.Paths = append(p.Paths, p.Scratch())
		}
		seen[p.Name] = true
		if p.Default() {
			out[0] = p
		} else {
			out = append(out, p)
		}
	}
	profilesMu.Lock()
	profiles = out
	profilesMu.Unlock()
	return nil
}

func expand(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, p[1:])
	}
	return p
}

func Profiles() []Profile {
	profilesMu.RLock()
	defer profilesMu.RUnlock()
	return append([]Profile(nil), profiles...)
}

func DefaultProfile() Profile { return Profiles()[0] }

// ProfileNamed is the profile called name; "" is the default.
func ProfileNamed(name string) (Profile, bool) {
	for _, p := range Profiles() {
		if p.Name == name || name == "" && p.Default() {
			return p, true
		}
	}
	return Profile{}, false
}

// ProfileFor is the profile a new session in dir runs as: the one with the longest path holding dir.
func ProfileFor(dir string) Profile {
	dirs := withReal(filepath.Clean(expand(dir)))
	best, n := DefaultProfile(), -1
	for _, p := range Profiles() {
		for _, root := range p.Paths {
			for _, r := range withReal(root) {
				for _, d := range dirs {
					if (d == r || strings.HasPrefix(d, r+string(filepath.Separator))) && len(r) > n {
						best, n = p, len(r)
					}
				}
			}
		}
	}
	return best
}

// withReal is path and, when a symlink is on the way to it, where it really is.
func withReal(path string) []string {
	if real, err := filepath.EvalSymlinks(path); err == nil && real != path {
		return []string{path, real}
	}
	return []string{path}
}

// ProfileOf is the profile whose daemon runs the job id.
func ProfileOf(id string) Profile {
	if v, ok := jobProfile.Load(id); ok {
		if p, ok := ProfileNamed(v.(string)); ok {
			return p
		}
	}
	for _, p := range Profiles() {
		if _, err := os.Stat(filepath.Join(p.Home(), "jobs", id)); err == nil {
			return p
		}
	}
	return DefaultProfile()
}

// ProfileOfFile is the profile whose config folder holds path, such as a transcript.
func ProfileOfFile(path string) Profile {
	best, n := DefaultProfile(), -1
	for _, p := range Profiles() {
		if h := p.Home(); strings.HasPrefix(path, h+string(filepath.Separator)) && len(h) > n {
			best, n = p, len(h)
		}
	}
	return best
}

// ProfileOfSession is the profile that keeps the transcript of the conversation sid.
func ProfileOfSession(sid string) Profile {
	if t := Transcript(sid); t != "" {
		return ProfileOfFile(t)
	}
	return DefaultProfile()
}

// Transcript is where the conversation sid's transcript is, in whichever profile keeps it.
func Transcript(sid string) string {
	for _, p := range Profiles() {
		if m, _ := filepath.Glob(filepath.Join(p.Projects(), "*", sid+".jsonl")); len(m) > 0 {
			return m[0]
		}
	}
	return ""
}

func Homes() []string {
	var out []string
	for _, p := range Profiles() {
		out = append(out, p.Home())
	}
	return out
}

// files is what p keeps of the conversation sid whose transcript is at path: the transcript, its subagents'
// transcripts and its file history.
func files(p Profile, sid, path string) []string {
	return []string{path, filepath.Join(filepath.Dir(path), sid), filepath.Join(p.Home(), "file-history", sid)}
}

// Move puts the conversation sid's files on the account to. Resumed after, it runs there with everything it had.
func Move(sid string, to Profile) error {
	path := Transcript(sid)
	if path == "" {
		return fmt.Errorf("no transcript for %s", sid)
	}
	from := ProfileOfFile(path)
	if from.Name == to.Name {
		return fmt.Errorf("it is on %s already", to.Name)
	}
	dst := files(to, sid, filepath.Join(to.Projects(), filepath.Base(filepath.Dir(path)), sid+".jsonl"))
	for i, src := range files(from, sid, path) {
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst[i]), 0o755); err != nil {
			return err
		}
		if err := os.Rename(src, dst[i]); err != nil {
			return err
		}
	}
	return nil
}

// ProjectRoots is every profile's transcript folder.
func ProjectRoots() []string {
	var out []string
	for _, p := range Profiles() {
		out = append(out, p.Projects())
	}
	return out
}
