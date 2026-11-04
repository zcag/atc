// Package settings is settings.json in atc's config folder: who the user and the assistant are, and values for atc's
// ATC_* settings. It fills in the process environment at startup, so everything that reads os.Getenv keeps working and
// a variable set in the real environment always wins.
package settings

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type File struct {
	User      string            `json:"user,omitempty"`
	Assistant string            `json:"assistant,omitempty"`
	Language  string            `json:"language,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
}

// Settings remembers what this process started with, which is what tells a value that needs a restart.
type Settings struct {
	Dir  string
	boot File
}

const LanguageKey = "ATC_STT_LANGUAGE"

func (s *Settings) Path() string { return filepath.Join(s.Dir, "settings.json") }

func (s *Settings) Load() (File, error) {
	var f File
	b, err := os.ReadFile(s.Path())
	if os.IsNotExist(err) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	return f, json.Unmarshal(b, &f)
}

func (s *Settings) Save(f File) error {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	tmp := s.Path() + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path())
}

// renamed maps a setting's old name to the one atc reads now, so an existing env file keeps working.
var renamed = map[string]string{"ATC_DELTA_CALL": "ATC_CALL_LINE"}

func applyRenamed() {
	for old, now := range renamed {
		v, isOld := os.LookupEnv(old)
		if _, isNow := os.LookupEnv(now); isOld && !isNow {
			os.Setenv(now, v)
		}
	}
}

// Apply puts settings.json's values into the environment for the variables that are not set there. It reports a file
// it could not read; the rest of atc then runs as if there were none.
func Apply(dir string) (*Settings, error) {
	applyRenamed()
	s := &Settings{Dir: dir, boot: File{Env: map[string]string{}}}
	f, err := s.Load()
	if err != nil {
		return s, err
	}
	s.boot.User, s.boot.Assistant, s.boot.Language = f.User, f.Assistant, f.Language
	for k, v := range f.Env {
		if _, inEnv := os.LookupEnv(k); strings.HasPrefix(k, "ATC_") && !inEnv {
			os.Setenv(k, v)
			s.boot.Env[k] = v
		}
	}
	applyRenamed()
	if _, inEnv := os.LookupEnv(LanguageKey); f.Language != "" && !inEnv {
		os.Setenv(LanguageKey, f.Language)
	}
	return s, nil
}

// EnvFile fills in the variables a KEY=value file sets, for a command that runs outside the service that file is
// written for.
func EnvFile(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if _, inEnv := os.LookupEnv(k); ok && !inEnv && !strings.HasPrefix(k, "#") {
			os.Setenv(k, strings.Trim(v, `"'`))
		}
	}
}

func (s *Settings) inEnv(key string) bool {
	_, set := os.LookupEnv(key)
	_, fromFile := s.boot.Env[key]
	return set && !fromFile
}

// Value is a setting as atc will have it after a restart: the environment's if it sets one, else the file's.
func (s *Settings) Value(f File, key string) string {
	if s.inEnv(key) {
		return os.Getenv(key)
	}
	return f.Env[key]
}

// Source says where Value comes from: "env", "settings" or "" for not set.
func (s *Settings) Source(f File, key string) string {
	switch {
	case s.inEnv(key):
		return "env"
	case f.Env[key] != "":
		return "settings"
	}
	return ""
}

// Pending lists the keys whose value in the file differs from what this process runs with.
func (s *Settings) Pending(f File) []string {
	keys := map[string]bool{}
	for _, m := range []map[string]string{f.Env, s.boot.Env} {
		for k := range m {
			if !s.inEnv(k) && f.Env[k] != s.boot.Env[k] {
				keys[k] = true
			}
		}
	}
	return slices.Sorted(maps.Keys(keys))
}

// IdentityChanged says whether the names or language differ from what this process started with.
func (s *Settings) IdentityChanged(f File) bool {
	return f.User != s.boot.User || f.Assistant != s.boot.Assistant || f.Language != s.boot.Language
}
