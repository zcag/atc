package claude

import (
	"encoding/json"
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

func KeepAlive(ids []string) error {
	path := filepath.Join(ConfigDir(), "jobs", "pins.json")
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
