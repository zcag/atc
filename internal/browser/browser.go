// Package browser shares one Chrome between sessions: each session's tools reach it
// through Proxy, which shows the session only the tabs it opened, and atc can show
// the user exactly those tabs.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

type Browser struct {
	Endpoint string
	path     string
	mu       sync.Mutex
	owner    map[string]string
}

func Open(endpoint, path string) (*Browser, error) {
	b := &Browser{Endpoint: endpoint, path: path, owner: map[string]string{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return b, nil
	}
	if err != nil {
		return nil, err
	}
	return b, json.Unmarshal(data, &b.owner)
}

func (b *Browser) Owner(target string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.owner[target]
}

func (b *Browser) claim(target, sid string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.owner[target] == sid {
		return
	}
	b.owner[target] = sid
	b.save()
}

func (b *Browser) forget(target string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.owner[target]; ok {
		delete(b.owner, target)
		b.save()
	}
}

func (b *Browser) save() {
	if b.path == "" {
		return
	}
	data, _ := json.Marshal(b.owner)
	tmp := b.path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		os.Rename(tmp, b.path)
	}
}

type Tab struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

type listed struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Title string `json:"title"`
	URL   string `json:"url"`
	WS    string `json:"webSocketDebuggerUrl"`
}

func (b *Browser) list(ctx context.Context) ([]listed, error) {
	var out []listed
	return out, b.get(ctx, "/json/list", &out)
}

func (b *Browser) Tabs(ctx context.Context, sid string) ([]Tab, error) {
	all, err := b.list(ctx)
	if err != nil {
		return nil, err
	}
	open := map[string]bool{}
	var tabs []Tab
	for _, t := range all {
		open[t.ID] = true
		if t.Type == "page" && b.Owner(t.ID) == sid {
			tabs = append(tabs, Tab{t.ID, t.Title, t.URL})
		}
	}
	b.mu.Lock()
	for id := range b.owner {
		if !open[id] {
			delete(b.owner, id)
		}
	}
	b.save()
	b.mu.Unlock()
	return tabs, nil
}

func (b *Browser) wsURL(ctx context.Context) (string, error) {
	var v struct {
		WS string `json:"webSocketDebuggerUrl"`
	}
	if err := b.get(ctx, "/json/version", &v); err != nil {
		return "", err
	}
	if v.WS == "" {
		return "", fmt.Errorf("chrome at %s gave no websocket", b.Endpoint)
	}
	return v.WS, nil
}

func (b *Browser) get(ctx context.Context, path string, v any) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", b.Endpoint+path, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("chrome is not answering at %s: %w", b.Endpoint, err)
	}
	defer res.Body.Close()
	return json.NewDecoder(res.Body).Decode(v)
}
