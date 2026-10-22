package outputs

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type File struct {
	Path string    `json:"path"`
	Kind string    `json:"kind"`
	Op   string    `json:"op"`
	At   time.Time `json:"at"`
	Size int64     `json:"size"`
}

type Link struct {
	URL string    `json:"url"`
	At  time.Time `json:"at"`
}

type found struct {
	files map[string]File
	links map[string]Link
	ports map[string]time.Time
}

type entry struct {
	off   int64
	found found
}

type Scanner struct {
	mu    sync.Mutex
	cache map[string]*entry
}

var (
	urlRe      = regexp.MustCompile(`https?://[^\s"'<>()\[\]{}` + "`" + `]+`)
	localURLRe = regexp.MustCompile(`^https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d+))?`)
	cmdPortRe  = regexp.MustCompile(`(?:--port[= ]?|\s-p\s?|\bPORT=|http\.server\s+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):)(\d{2,5})\b`)
	pathRe     = regexp.MustCompile(`(?:^|[\s"'(=:` + "`" + `])((?:~|/)[\w@%+.,/-]*\.(?i:png|jpe?g|gif|webp|svg|avif|html?|md|markdown|pdf|mp4|webm|mov|mp3|wav|ogg|m4a|csv|tsv))\b`)
	kinds      = map[string]string{
		".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".avif": "image",
		".html": "html", ".htm": "html", ".md": "markdown", ".markdown": "markdown", ".pdf": "pdf",
		".mp4": "video", ".webm": "video", ".mov": "video", ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
	}
	noise = []string{"/.claude/", "/node_modules/", "/.git/", "/.cache/", "/proc/"}
)

func Kind(path string) string {
	if k, ok := kinds[strings.ToLower(filepath.Ext(path))]; ok {
		return k
	}
	return "text"
}

type raw struct {
	Type      string    `json:"type"`
	Timestamp time.Time `json:"timestamp"`
	Message   struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type block struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	Name    string          `json:"name"`
	Input   json.RawMessage `json:"input"`
	Content json.RawMessage `json:"content"`
}

func (s *Scanner) Scan(transcript, home string) ([]File, []Link, map[string]time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		s.cache = map[string]*entry{}
	}
	e := s.cache[transcript]
	if e == nil {
		e = &entry{found: found{map[string]File{}, map[string]Link{}, map[string]time.Time{}}}
		s.cache[transcript] = e
	}
	if f, err := os.Open(transcript); err == nil {
		if st, _ := f.Stat(); st != nil && st.Size() < e.off {
			e.off, e.found = 0, found{map[string]File{}, map[string]Link{}, map[string]time.Time{}}
		}
		f.Seek(e.off, io.SeekStart)
		r := bufio.NewReaderSize(f, 1<<20)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				break
			}
			e.off += int64(len(line))
			e.found.add(line, home)
		}
		f.Close()
	}
	var files []File
	for _, f := range e.found.files {
		st, err := os.Stat(f.Path)
		if err != nil || st.IsDir() {
			continue
		}
		f.Size = st.Size()
		files = append(files, f)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].At.After(files[j].At) })
	var links []Link
	for _, l := range e.found.links {
		links = append(links, l)
	}
	sort.Slice(links, func(i, j int) bool { return links[i].At.After(links[j].At) })
	ports := map[string]time.Time{}
	for p, at := range e.found.ports {
		ports[p] = at
	}
	return files, links, ports
}

func (f *found) add(line []byte, home string) {
	var m raw
	if json.Unmarshal(line, &m) != nil || (m.Type != "assistant" && m.Type != "user") {
		return
	}
	var blocks []block
	if json.Unmarshal(m.Message.Content, &blocks) != nil {
		return
	}
	at := m.Timestamp
	for _, b := range blocks {
		switch b.Type {
		case "tool_use":
			var in struct {
				FilePath     string `json:"file_path"`
				NotebookPath string `json:"notebook_path"`
				Command      string `json:"command"`
			}
			json.Unmarshal(b.Input, &in)
			for _, m := range cmdPortRe.FindAllStringSubmatch(in.Command, -1) {
				f.ports[m[1]] = at
			}
			p := cleanPath(cmpOr(in.FilePath, in.NotebookPath), home)
			switch {
			case p == "":
			case b.Name == "Write":
				op := "made"
				if old, ok := f.files[p]; ok && old.Op == "edited" {
					op = "edited"
				}
				f.files[p] = File{Path: p, Kind: Kind(p), Op: op, At: at}
			case b.Name == "Edit" || b.Name == "MultiEdit" || b.Name == "NotebookEdit":
				f.files[p] = File{Path: p, Kind: Kind(p), Op: "edited", At: at}
			case Kind(p) != "text":
				f.seen(p, at)
			}
		case "text":
			if m.Type == "assistant" {
				f.scanText(b.Text, at, home, true)
			}
		case "tool_result":
			f.scanText(resultText(b.Content), at, home, false)
		}
	}
}

func (f *found) scanText(t string, at time.Time, home string, links bool) {
	if t == "" {
		return
	}
	for _, u := range urlRe.FindAllString(t, -1) {
		u = strings.TrimRight(u, ".,;:!?*_")
		if m := localURLRe.FindStringSubmatch(u); m != nil {
			if m[1] != "" {
				f.ports[m[1]] = at
			}
			continue
		}
		if links {
			f.links[u] = Link{u, at}
		}
	}
	for _, m := range pathRe.FindAllStringSubmatch(t, -1) {
		if p := cleanPath(m[1], home); p != "" {
			f.seen(p, at)
		}
	}
}

func (f *found) seen(p string, at time.Time) {
	if old, ok := f.files[p]; ok {
		if old.Op == "seen" && old.At.Before(at) {
			old.At = at
			f.files[p] = old
		}
		return
	}
	f.files[p] = File{Path: p, Kind: Kind(p), Op: "seen", At: at}
}

func resultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []block
	json.Unmarshal(raw, &parts)
	var b strings.Builder
	for _, p := range parts {
		if p.Type == "text" {
			b.WriteString(p.Text)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func cleanPath(p, home string) string {
	if p == "" {
		return ""
	}
	if strings.HasPrefix(p, "~/") {
		p = filepath.Join(home, p[2:])
	}
	if !filepath.IsAbs(p) {
		return ""
	}
	p = filepath.Clean(p)
	for _, n := range noise {
		if strings.Contains(p+"/", n) {
			return ""
		}
	}
	return p
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
