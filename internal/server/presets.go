package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Preset struct {
	Name     string   `json:"name"`
	Dir      string   `json:"dir"`
	Brief    string   `json:"brief,omitempty"`
	Args     []string `json:"args,omitempty"`
	Worktree bool     `json:"worktree,omitempty"`
	Host     string   `json:"host,omitempty"`
	Every    string   `json:"every,omitempty"`
	From     string   `json:"from,omitempty"`
	Check    string   `json:"check,omitempty"`
	Prompt   string   `json:"prompt,omitempty"`
	Command  string   `json:"command,omitempty"`
	App      bool     `json:"app,omitempty"`
	Title    string   `json:"title,omitempty"`
	Icon     string   `json:"icon,omitempty"`
	Color    string   `json:"color,omitempty"`
}

func LoadPresets(path string) ([]Preset, error) {
	list, err := loadList[Preset](path)
	for _, p := range list {
		if _, e := p.interval(); e != nil {
			return nil, fmt.Errorf("%s: %w", path, e)
		}
	}
	return list, err
}

func loadList[T any](path string) ([]T, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var list []T
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return list, nil
}

func (s *Server) preset(name string) (Preset, bool) {
	for _, p := range s.Presets {
		if p.Name == name {
			return p, true
		}
	}
	return Preset{}, false
}

func (p Preset) extra(dir string) ([]string, error) {
	extra := append([]string(nil), p.Args...)
	brief, err := p.brief(dir)
	if err != nil {
		return nil, err
	}
	if brief != "" {
		extra = append(extra, "--append-system-prompt", brief)
	}
	return extra, nil
}

func (p Preset) brief(dir string) (string, error) {
	if p.Brief == "" {
		return "", nil
	}
	path, err := expand(p.Brief)
	if err != nil {
		path = filepath.Join(dir, p.Brief)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("preset %s: %w", p.Name, err)
	}
	return string(b), nil
}

func (s *Server) presets(w http.ResponseWriter, r *http.Request) {
	gather(s, w, r, "/api/presets", s.Presets, func(p *Preset, h string) { p.Host = h })
}

func gather[T any](s *Server, w http.ResponseWriter, r *http.Request, path string, local []T, setHost func(*T, string)) {
	out := []T{}
	for _, x := range local {
		setHost(&x, s.Host)
		out = append(out, x)
	}
	if r.URL.Query().Get("local") != "" || len(s.Peers) == 0 {
		reply(w, out)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, peer := range s.Peers {
		wg.Go(func() {
			var xs []T
			if s.fleet.get(ctx, peer, path+"?local=1", &xs) == nil {
				mu.Lock()
				for _, x := range xs {
					setHost(&x, peer.Name)
					out = append(out, x)
				}
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	reply(w, out)
}
