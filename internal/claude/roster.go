package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func Forks() map[string]string {
	out := map[string]string{}
	for _, p := range Profiles() {
		forks(p, out)
	}
	return out
}

func forks(p Profile, out map[string]string) {
	b, err := os.ReadFile(filepath.Join(p.Home(), "daemon", "roster.json"))
	if err != nil {
		return
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
		return
	}
	for _, w := range r.Workers {
		if l := w.Dispatch.Launch; l.Mode == "resume" && l.SessionID != "" && l.SessionID != w.SessionID {
			out[w.SessionID] = l.SessionID
		}
	}
}

func jobState(id string) ([]byte, error) {
	return os.ReadFile(filepath.Join(ProfileOf(id).Home(), "jobs", id, "state.json"))
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

type Task struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	StartedAt int64  `json:"startedAt,omitempty"`
	DoneAt    int64  `json:"doneAt,omitempty"`
}

func Background(id string) []Task {
	b, err := jobState(id)
	if err != nil {
		return nil
	}
	var st struct {
		Fan []Task `json:"fan"`
	}
	json.Unmarshal(b, &st)
	var out []Task
	for _, t := range st.Fan {
		if t.Kind == "agent" || t.Kind == "shell" || t.Kind == "monitor" {
			out = append(out, t)
		}
	}
	return out
}

func Asking(id string) Block {
	b, err := jobState(id)
	if err != nil {
		return Block{}
	}
	return asking(b)
}

func asking(b []byte) Block {
	var st struct {
		Tempo        string `json:"tempo"`
		Needs        string `json:"needs"`
		NeedsOverlay string `json:"needsOverlay"`
		Block        *struct {
			Questions []Question `json:"questions"`
		} `json:"block"`
	}
	if json.Unmarshal(b, &st) != nil || st.Tempo != "blocked" {
		return Block{}
	}
	if st.Block != nil && len(st.Block.Questions) > 0 {
		return Block{Questions: st.Block.Questions}
	}
	if st.NeedsOverlay == "" || st.NeedsOverlay != st.Needs {
		return Block{}
	}
	approve, ok := strings.CutPrefix(st.Needs, "approve ")
	if !ok {
		return Block{}
	}
	return Block{Approve: approve}
}
