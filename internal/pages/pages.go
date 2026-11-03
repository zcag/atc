package pages

import (
	"encoding/json"
	"errors"
	"html"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/outputs"
)

type Page struct {
	Session string              `json:"session"`
	Name    string              `json:"name"`
	Title   string              `json:"title,omitempty"`
	Path    string              `json:"path"`
	Note    string              `json:"note,omitempty"`
	At      string              `json:"at,omitempty"`
	Shown   time.Time           `json:"shown"`
	Kind    string              `json:"kind,omitempty"`
	Updated time.Time           `json:"updated,omitzero"`
	StateAt time.Time           `json:"stateAt,omitzero"`
	Size    int64               `json:"size,omitempty"`
	Gone    bool                `json:"gone,omitempty"`
	URL     string              `json:"url,omitempty"`
	Host    string              `json:"host,omitempty"`
	Of      string              `json:"of,omitempty"`
	Cwd     string              `json:"cwd,omitempty"`
	Actions map[string][]string `json:"actions,omitempty"`
}

type saved struct {
	Pages map[string][]Page          `json:"pages"`
	State map[string]json.RawMessage `json:"state,omitempty"`
}

type Store struct {
	path   string
	mu     sync.Mutex
	s      saved
	titles map[string]titled
}

type titled struct {
	mod   time.Time
	title string
}

const MaxState = 256 << 10

var ErrTooBig = errors.New("state is at most 256 KB")

var (
	nameRe  = regexp.MustCompile(`[^a-z0-9]+`)
	titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	h1Re    = regexp.MustCompile(`(?m)^#\s+(.+)$`)
	atRe    = regexp.MustCompile(`^[A-Za-z0-9][\w.:-]*$`)
)

var ErrAt = errors.New("a section is an element id: letters, digits and - _ . :")

func Ref(name, at string) (string, error) {
	if at == "" {
		return name, nil
	}
	if !atRe.MatchString(at) {
		return "", ErrAt
	}
	return name + "#" + at, nil
}

func (p Page) Ref() string {
	r, _ := Ref(p.Name, p.At)
	return r
}

func Link(sid, ref string) string { return "/#/s/" + sid + "/p/" + ref }

func Open(path string) (*Store, error) {
	st := &Store{path: path, s: saved{Pages: map[string][]Page{}, State: map[string]json.RawMessage{}}, titles: map[string]titled{}}
	if path == "" {
		return st, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &st.s); err != nil {
		return nil, err
	}
	if st.s.Pages == nil {
		st.s.Pages = map[string][]Page{}
	}
	if st.s.State == nil {
		st.s.State = map[string]json.RawMessage{}
	}
	return st, nil
}

func Name(s string) string {
	return Slug(strings.TrimSuffix(filepath.Base(s), filepath.Ext(s)))
}

func Slug(s string) string {
	return strings.Trim(nameRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

func Target(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return path, nil
	}
	for _, f := range []string{"index.html", "index.htm", "index.md", "README.md"} {
		if p := filepath.Join(path, f); exists(p) {
			return p, nil
		}
	}
	return "", errors.New(path + " is a folder without an index.html")
}

func (st *Store) Show(p Page) (Page, bool, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	list := st.s.Pages[p.Session]
	created := true
	for i, old := range list {
		if old.Name == p.Name {
			created = false
			p.Note = cmpOr(p.Note, old.Note)
			if p.Path == old.Path {
				p.Title = cmpOr(p.Title, old.Title)
			}
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	st.s.Pages[p.Session] = append(list, p)
	return p, created, st.save()
}

func (st *Store) Remove(sid, name string) (bool, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	list := st.s.Pages[sid]
	for i, p := range list {
		if p.Name == name {
			st.s.Pages[sid] = append(list[:i], list[i+1:]...)
			if len(st.s.Pages[sid]) == 0 {
				delete(st.s.Pages, sid)
			}
			delete(st.s.State, sid+"/"+name)
			return true, st.save()
		}
	}
	return false, nil
}

func (st *Store) Of(sid string) []Page {
	st.mu.Lock()
	list := append([]Page(nil), st.s.Pages[sid]...)
	st.mu.Unlock()
	return st.fill(list)
}

func (st *Store) Get(sid, name string) (Page, bool) {
	for _, p := range st.Of(sid) {
		if p.Name == name {
			return p, true
		}
	}
	return Page{}, false
}

func (st *Store) All() []Page {
	st.mu.Lock()
	var list []Page
	for _, ps := range st.s.Pages {
		list = append(list, ps...)
	}
	st.mu.Unlock()
	return st.fill(list)
}

func (st *Store) State(sid, name string) json.RawMessage {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.s.State[sid+"/"+name]
}

func (st *Store) SetState(sid, name string, v json.RawMessage) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	i := slices.IndexFunc(st.s.Pages[sid], func(p Page) bool { return p.Name == name })
	if i < 0 {
		return os.ErrNotExist
	}
	st.s.Pages[sid][i].StateAt = time.Now()
	key := sid + "/" + name
	v = Merge(st.s.State[key], v)
	if len(v) > MaxState {
		return ErrTooBig
	}
	if len(v) == 0 || string(v) == "null" {
		delete(st.s.State, key)
	} else {
		st.s.State[key] = v
	}
	return st.save()
}

func Merge(old, v json.RawMessage) json.RawMessage {
	var patch map[string]json.RawMessage
	cur := map[string]json.RawMessage{}
	if json.Unmarshal(v, &patch) != nil || patch == nil || len(old) > 0 && (json.Unmarshal(old, &cur) != nil || cur == nil) {
		return v
	}
	for k, x := range patch {
		if string(x) == "null" {
			delete(cur, k)
		} else {
			cur[k] = x
		}
	}
	b, _ := json.Marshal(cur)
	return b
}

func (st *Store) has(sid, name string) bool {
	for _, p := range st.s.Pages[sid] {
		if p.Name == name {
			return true
		}
	}
	return false
}

func newest(dir string, t time.Time) time.Time {
	n := 0
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || n > 300 {
			return filepath.SkipDir
		}
		if d.IsDir() {
			if path != dir && (strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules" || strings.Count(strings.TrimPrefix(path, dir), string(filepath.Separator)) > 2) {
				return filepath.SkipDir
			}
			return nil
		}
		n++
		if fi, err := d.Info(); err == nil && fi.ModTime().After(t) {
			t = fi.ModTime()
		}
		return nil
	})
	return t
}

func (st *Store) fill(list []Page) []Page {
	for i := range list {
		p := &list[i]
		p.Kind = outputs.Kind(p.Path)
		fi, err := os.Stat(p.Path)
		if err != nil {
			p.Gone = true
			continue
		}
		p.Updated, p.Size = fi.ModTime(), fi.Size()
		if b := filepath.Base(p.Path); b == "index.html" || b == "index.htm" {
			p.Updated = newest(filepath.Dir(p.Path), p.Updated)
		}
		if p.Title == "" {
			p.Title = st.title(p.Path, p.Kind, fi.ModTime())
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].Last().After(list[j].Last()) })
	return list
}

func (p Page) Last() time.Time {
	if p.Updated.After(p.Shown) {
		return p.Updated
	}
	return p.Shown
}

func (st *Store) title(path, kind string, mod time.Time) string {
	if kind != "html" && kind != "markdown" {
		return ""
	}
	st.mu.Lock()
	c, ok := st.titles[path]
	st.mu.Unlock()
	if ok && c.mod.Equal(mod) {
		return c.title
	}
	t := ""
	if f, err := os.Open(path); err == nil {
		b, _ := io.ReadAll(io.LimitReader(f, 64<<10))
		f.Close()
		re := titleRe
		if kind == "markdown" {
			re = h1Re
		}
		if m := re.FindSubmatch(b); m != nil {
			t = strings.Join(strings.Fields(html.UnescapeString(string(m[1]))), " ")
		}
	}
	st.mu.Lock()
	st.titles[path] = titled{mod, t}
	st.mu.Unlock()
	return t
}

func (st *Store) save() error {
	if st.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(st.s, "", "  ")
	if err != nil {
		return err
	}
	os.MkdirAll(filepath.Dir(st.path), 0o755)
	tmp := st.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, st.path)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
