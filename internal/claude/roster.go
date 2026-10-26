package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

type Question struct {
	Question string `json:"question"`
	Header   string `json:"header"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
	MultiSelect bool `json:"multiSelect"`
}

type Block struct {
	Questions []Question
	Approve   string
}

func Asking(id string) Block {
	b, err := os.ReadFile(filepath.Join(ConfigDir(), "jobs", id, "state.json"))
	if err != nil {
		return Block{}
	}
	var st struct {
		Tempo string `json:"tempo"`
		Needs string `json:"needs"`
		Block *struct {
			Questions []Question `json:"questions"`
		} `json:"block"`
	}
	if json.Unmarshal(b, &st) != nil || st.Tempo != "blocked" {
		return Block{}
	}
	if st.Block != nil && len(st.Block.Questions) > 0 {
		return Block{Questions: st.Block.Questions}
	}
	approve, _ := strings.CutPrefix(st.Needs, "approve ")
	if approve == st.Needs {
		return Block{}
	}
	return Block{Approve: approve}
}
