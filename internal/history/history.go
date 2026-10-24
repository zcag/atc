package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Transcript struct {
	SessionID      string    `json:"sessionId"`
	Path           string    `json:"-"`
	Cwd            string    `json:"cwd"`
	StartCwd       string    `json:"startCwd"`
	Title          string    `json:"title"`
	AITitle        string    `json:"aiTitle"`
	AgentName      string    `json:"agentName"`
	LastPrompt     string    `json:"lastPrompt"`
	Branch         string    `json:"branch"`
	Model          string    `json:"model"`
	PermissionMode string    `json:"permissionMode"`
	PromptAt       time.Time `json:"promptAt,omitzero"`
	Activity       string    `json:"activity,omitempty"`
	LastReply      string    `json:"lastReply,omitempty"`
	ReplyID        string    `json:"replyId,omitempty"`
	Pending        string    `json:"pending,omitempty"`
	pendingID      string
	Harness        string    `json:"harness,omitempty"`
	Context        int       `json:"context"`
	Updated        time.Time `json:"updated"`
	Size           int64     `json:"size"`
	modTime        time.Time
}

type entry struct {
	Type           string    `json:"type"`
	Cwd            string    `json:"cwd"`
	GitBranch      string    `json:"gitBranch"`
	Timestamp      time.Time `json:"timestamp"`
	AITitle        string    `json:"aiTitle"`
	CustomTitle    string    `json:"customTitle"`
	AgentName      string    `json:"agentName"`
	LastPrompt     string    `json:"lastPrompt"`
	PermissionMode string    `json:"permissionMode"`
	PromptID       string    `json:"promptId"`
	UUID           string    `json:"uuid"`
	IsSidechain    bool      `json:"isSidechain"`
	Message        struct {
		Content json.RawMessage `json:"content"`
		Model   string          `json:"model"`
		Usage   struct {
			Input       int `json:"input_tokens"`
			CacheRead   int `json:"cache_read_input_tokens"`
			CacheCreate int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

type Index struct {
	Root  string
	mu    sync.Mutex
	cache map[string]*Transcript
}

func New(root string) *Index { return &Index{Root: root, cache: map[string]*Transcript{}} }

func (x *Index) Scan() []Transcript {
	paths, _ := filepath.Glob(filepath.Join(x.Root, "*", "*.jsonl"))
	x.mu.Lock()
	defer x.mu.Unlock()
	seen := map[string]bool{}
	out := make([]Transcript, 0, len(paths))
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		seen[p] = true
		t := x.cache[p]
		if t == nil || t.Size != st.Size() || !t.modTime.Equal(st.ModTime()) {
			t = read(p, st)
			x.cache[p] = t
		}
		if t.Cwd != "" {
			out = append(out, *t)
		}
	}
	for p := range x.cache {
		if !seen[p] {
			delete(x.cache, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out
}

func read(path string, st os.FileInfo) *Transcript {
	t := &Transcript{
		SessionID: strings.TrimSuffix(filepath.Base(path), ".jsonl"),
		Path:      path, Size: st.Size(), modTime: st.ModTime(),
	}
	t.StartCwd = headCwd(path)
	for _, n := range []int64{64 << 10, 1 << 20, 4 << 20} {
		parseTail(path, n, t)
		if t.Title != "" && !t.PromptAt.IsZero() || n >= st.Size() {
			break
		}
	}
	if t.Updated.IsZero() {
		t.Updated = st.ModTime()
	}
	return t
}

func parseTail(path string, n int64, t *Transcript) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	if st, _ := f.Stat(); st.Size() > n {
		f.Seek(-n, io.SeekEnd)
	}
	r := bufio.NewReaderSize(f, 1<<20)
	if n < t.Size {
		r.ReadBytes('\n')
	}
	var custom string
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && bytes.HasPrefix(line, []byte("{")) {
			var e entry
			if json.Unmarshal(line, &e) == nil {
				apply(t, &e, &custom)
			}
		}
		if err != nil {
			break
		}
	}
	t.Title = first(custom, t.AITitle)
}

func headCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 256<<10))
	sc.Buffer(make([]byte, 64<<10), 256<<10)
	for sc.Scan() {
		var e struct {
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Cwd != "" {
			return e.Cwd
		}
	}
	return ""
}

func apply(t *Transcript, e *entry, custom *string) {
	if e.Timestamp.After(t.Updated) {
		t.Updated = e.Timestamp
	}
	switch e.Type {
	case "ai-title":
		t.AITitle = e.AITitle
	case "custom-title":
		*custom = e.CustomTitle
	case "agent-name":
		t.AgentName = e.AgentName
	case "last-prompt":
		t.LastPrompt = e.LastPrompt
	case "permission-mode":
		t.PermissionMode = e.PermissionMode
	case "user":
		if e.PromptID != "" && !e.Timestamp.IsZero() {
			t.PromptAt, t.Activity, t.Pending, t.pendingID = e.Timestamp, "", "", ""
		}
		var blocks []block
		if t.pendingID != "" && json.Unmarshal(e.Message.Content, &blocks) == nil {
			for _, b := range blocks {
				if b.Type == "tool_result" && b.ToolUseID == t.pendingID {
					t.Pending, t.pendingID = "", ""
				}
			}
		}
	case "assistant":
		var blocks []block
		if !e.IsSidechain && json.Unmarshal(e.Message.Content, &blocks) == nil {
			for _, b := range blocks {
				switch {
				case b.Type == "tool_use":
					t.Activity = strings.TrimSpace(b.Name + "  " + Detail(b.Input))
					t.Pending, t.pendingID = t.Activity, b.ID
				case b.Type == "text" && strings.TrimSpace(b.Text) != "":
					t.Activity, t.LastReply, t.ReplyID = "", clip(strings.Join(strings.Fields(b.Text), " "), 300), e.UUID
				}
			}
		}
		if e.Message.Model != "" && e.Message.Model != "<synthetic>" {
			t.Model = e.Message.Model
		}
		if u := e.Message.Usage; u.Input+u.CacheRead+u.CacheCreate > 0 {
			t.Context = u.Input + u.CacheRead + u.CacheCreate
		}
	}
	if e.Cwd != "" {
		t.Cwd = e.Cwd
	}
	if e.GitBranch != "" {
		t.Branch = e.GitBranch
	}
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func first(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}
