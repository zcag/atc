package claude

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
)

func ConfigDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// KeepAlive tells each profile's daemon which of its jobs to keep alive.
func KeepAlive(ids []string) error {
	by := map[string][]string{}
	for _, id := range ids {
		p := ProfileOf(id).Name
		by[p] = append(by[p], id)
	}
	var errs []error
	for _, p := range Profiles() {
		if _, err := os.Stat(filepath.Join(p.Home(), "jobs")); err == nil || p.Default() {
			errs = append(errs, keepAlive(p, by[p.Name]))
		}
	}
	return errors.Join(errs...)
}

func keepAlive(p Profile, ids []string) error {
	path := filepath.Join(p.Home(), "jobs", "pins.json")
	ids = slices.Sorted(slices.Values(ids))
	var have []string
	if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &have) == nil {
		slices.Sort(have)
		if slices.Equal(have, ids) {
			return nil
		}
	}
	b, _ := json.Marshal(append([]string{}, ids...))
	tmp := path + ".atc"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
