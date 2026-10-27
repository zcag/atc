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
	owner    map[string]owned

	cmu      sync.Mutex
	cached   map[string][]Tab
	cachedAt time.Time
	loading  bool

	seen     map[string]time.Time
	reapedAt time.Time
}

const abandoned = time.Hour

type owned struct {
	Session string    `json:"session"`
	At      time.Time `json:"at"`
}

func Open(endpoint, path string) (*Browser, error) {
	b := &Browser{Endpoint: endpoint, path: path, owner: map[string]owned{}, seen: map[string]time.Time{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return b, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &b.owner); err != nil {
		b.owner = map[string]owned{}
	}
	return b, nil
}

func (b *Browser) Owner(target string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.owner[target].Session
}

func (b *Browser) claim(target, sid string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.owner[target].Session == sid {
		return
	}
	b.owner[target] = owned{sid, time.Now()}
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
	ID     string    `json:"id"`
	Title  string    `json:"title"`
	URL    string    `json:"url"`
	Opened time.Time `json:"opened"`
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

func (b *Browser) Tabs(ctx context.Context) (map[string][]Tab, error) {
	all, err := b.list(ctx)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	open := map[string]bool{}
	tabs := map[string][]Tab{}
	for _, t := range all {
		open[t.ID] = true
		if o, ok := b.owner[t.ID]; ok && t.Type == "page" {
			tabs[o.Session] = append(tabs[o.Session], Tab{t.ID, t.Title, t.URL, o.At})
		}
	}
	gone := false
	for id := range b.owner {
		if !open[id] {
			delete(b.owner, id)
			gone = true
		}
	}
	if gone {
		b.save()
	}
	return tabs, nil
}

// Of is the session's tabs as of the last look, never waiting on Chrome; a stale
// answer starts a new look in the background.
func (b *Browser) Of(sid string) []Tab {
	b.cmu.Lock()
	defer b.cmu.Unlock()
	if !b.loading && time.Since(b.cachedAt) > time.Second {
		b.loading = true
		go func() {
			tabs, err := b.Tabs(context.Background())
			b.cmu.Lock()
			defer b.cmu.Unlock()
			b.loading, b.cachedAt = false, time.Now()
			if err != nil {
				tabs = nil
			}
			b.cached = tabs
		}()
	}
	return b.cached[sid]
}

// Reap closes the tabs of sessions that have been out of atc's list for an hour.
func (b *Browser) Reap(live []string) {
	now := time.Now()
	b.mu.Lock()
	for _, sid := range live {
		b.seen[sid] = now
	}
	if now.Sub(b.reapedAt) < time.Minute {
		b.mu.Unlock()
		return
	}
	b.reapedAt = now
	var gone []string
	for id, o := range b.owner {
		if now.Sub(b.seen[o.Session]) > abandoned && now.Sub(o.At) > abandoned {
			gone = append(gone, id)
		}
	}
	b.mu.Unlock()
	for _, id := range gone {
		var ignored any
		b.get(context.Background(), "/json/close/"+id, &ignored)
		b.forget(id)
	}
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
