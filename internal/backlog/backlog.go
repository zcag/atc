package backlog

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

const (
	Ready   = "ready"
	Blocked = "blocked"
	Done    = "done"
)

var ErrNotFound = errors.New("no such backlog item")

type Item struct {
	ID       string    `json:"id"`
	Dir      string    `json:"dir"`
	Title    string    `json:"title,omitempty"`
	Prompt   string    `json:"prompt,omitempty"`
	Status   string    `json:"status"`
	Why      string    `json:"why,omitempty"`
	By       string    `json:"by,omitempty"`
	From     string    `json:"from,omitempty"`
	Accepted bool      `json:"accepted,omitempty"`
	Worktree bool      `json:"worktree,omitempty"`
	Session  string    `json:"session,omitempty"`
	SID      string    `json:"sid,omitempty"`
	Aside    bool      `json:"aside,omitempty"`
	Created  time.Time `json:"created"`
	Updated  time.Time `json:"updated"`
	Host     string    `json:"host,omitempty"`
}

func (it Item) Suggested() bool { return it.By != "" && !it.Accepted }

func (it Item) FirstMessage() string { return cmp.Or(it.Prompt, it.Title) }

func (it Item) Of(sid, id string) bool {
	return sid != "" && it.SID == sid || id != "" && it.Session == id
}

type Store struct {
	path  string
	mu    sync.Mutex
	items []Item
}

func Open(path string) (*Store, error) {
	st := &Store{path: path}
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
	return st, json.Unmarshal(b, &st.items)
}

func (st *Store) List() []Item {
	st.mu.Lock()
	defer st.mu.Unlock()
	return slices.Clone(st.items)
}

func (st *Store) Add(it Item) (Item, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	b := make([]byte, 6)
	rand.Read(b)
	it.ID = hex.EncodeToString(b)
	if it.Status == "" {
		it.Status = Ready
	}
	it.Created = time.Now().UTC()
	it.Updated = it.Created
	st.items = append(st.items, it)
	return it, st.save()
}

func (st *Store) Update(id string, f func(*Item)) (Item, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	i := slices.IndexFunc(st.items, func(it Item) bool { return it.ID == id })
	if i < 0 {
		return Item{}, ErrNotFound
	}
	f(&st.items[i])
	st.items[i].Updated = time.Now().UTC()
	return st.items[i], st.save()
}

func (st *Store) Remove(id string) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	n := len(st.items)
	st.items = slices.DeleteFunc(st.items, func(it Item) bool { return it.ID == id })
	if len(st.items) == n {
		return ErrNotFound
	}
	return st.save()
}

func (st *Store) save() error {
	if st.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(st.items, "", "  ")
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
