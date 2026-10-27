package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Meta struct {
	Name   string `json:"name,omitempty"`
	Pinned bool   `json:"pinned,omitempty"`
	Parked bool   `json:"parked,omitempty"`
	Engine string `json:"engine,omitempty"`
	Live   string `json:"live,omitempty"`
	App    string `json:"app,omitempty"`
}

const (
	Running = "running"
	Stopped = "stopped"
)

type Store struct {
	path string
	mu   sync.Mutex
	m    map[string]Meta
}

func Open(path string) (*Store, error) {
	s := &Store{path: path, m: map[string]Meta{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	return s, json.Unmarshal(b, &s.m)
}

func (s *Store) Get(id string) Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[id]
}

func (s *Store) Find(match func(id string, m Meta) bool) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ids []string
	for id, m := range s.m {
		if match(id, m) {
			ids = append(ids, id)
		}
	}
	return ids
}

func (s *Store) Update(id string, f func(*Meta)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.m[id]
	f(&m)
	if m == (Meta{}) {
		delete(s.m, id)
	} else {
		s.m[id] = m
	}
	b, err := json.MarshalIndent(s.m, "", "  ")
	if err != nil {
		return err
	}
	os.MkdirAll(filepath.Dir(s.path), 0o755)
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
