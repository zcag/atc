package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func ForkedFrom(sid string) string {
	b, err := os.ReadFile(filepath.Join(ConfigDir(), "daemon", "roster.json"))
	if err != nil {
		return ""
	}
	var r struct {
		Workers map[string]struct {
			SessionID string `json:"sessionId"`
			Dispatch  struct {
				Launch struct {
					Mode      string `json:"mode"`
					SessionID string `json:"sessionId"`
				} `json:"launch"`
			} `json:"dispatch"`
		} `json:"workers"`
	}
	if json.Unmarshal(b, &r) != nil {
		return ""
	}
	for _, w := range r.Workers {
		if l := w.Dispatch.Launch; w.SessionID == sid && l.Mode == "resume" && l.SessionID != sid {
			return l.SessionID
		}
	}
	return ""
}
