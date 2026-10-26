package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var toolUseID = regexp.MustCompile(`toolu_[A-Za-z0-9]+`)

type TaskSource struct {
	Tool        string `json:"tool"`
	Description string `json:"description,omitempty"`
	Detail      string `json:"detail"`
}

func FindTask(path, id string) (TaskSource, bool) {
	subs, _ := filepath.Glob(filepath.Join(strings.TrimSuffix(path, ".jsonl"), "subagents", "*.jsonl"))
	files := append([]string{path}, subs...)
	var call string
	for _, f := range files {
		scan(f, func(line []byte) bool {
			if bytes.Contains(line, []byte(id)) {
				call = toolUseID.FindString(string(line))
			}
			return call == ""
		})
		if call != "" {
			break
		}
	}
	if call == "" {
		return TaskSource{}, false
	}
	var out TaskSource
	found := false
	for _, f := range files {
		if found {
			break
		}
		scan(f, func(line []byte) bool {
			if !bytes.Contains(line, []byte(`"id":"`+call+`"`)) {
				return true
			}
			var e struct {
				Message struct {
					Content []struct {
						Type  string `json:"type"`
						ID    string `json:"id"`
						Name  string `json:"name"`
						Input struct {
							Command     string `json:"command"`
							Prompt      string `json:"prompt"`
							Description string `json:"description"`
						} `json:"input"`
					} `json:"content"`
				} `json:"message"`
			}
			if json.Unmarshal(line, &e) != nil {
				return true
			}
			for _, b := range e.Message.Content {
				if b.Type == "tool_use" && b.ID == call {
					out = TaskSource{Tool: b.Name, Description: b.Input.Description, Detail: first(b.Input.Command, b.Input.Prompt)}
					found = true
				}
			}
			return !found
		})
	}
	return out, found
}

func scan(path string, fn func([]byte) bool) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && !fn(line) || err != nil {
			return
		}
	}
}
