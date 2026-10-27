package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

type Peer struct {
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token"`
}

type peerStatus struct {
	Name  string `json:"name"`
	Error string `json:"error,omitempty"`
}

func LoadPeers(path string) ([]Peer, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ps []Peer
	return ps, json.Unmarshal(b, &ps)
}

type fleet struct {
	peers  []Peer
	client *http.Client
	mu     sync.Mutex
	owner  map[string]string
	status map[string]string
	views  map[string]int
}

func (f *fleet) peer(name string) *Peer {
	for i := range f.peers {
		if f.peers[i].Name == name {
			return &f.peers[i]
		}
	}
	return nil
}

func (f *fleet) remember(host string, list []sessions.Session) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range list {
		f.owner[s.SessionID] = host
		if s.ID != "" {
			f.owner[s.ID] = host
		}
		if s.App != "" {
			f.owner[appRef+s.App] = host
		}
	}
}

func (f *fleet) claim(host string, keys ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, k := range keys {
		if k != "" {
			f.owner[k] = host
		}
	}
}

func (f *fleet) ownerOf(key string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.owner[key]
}

func (f *fleet) get(ctx context.Context, p Peer, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(p.URL, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	res, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s", res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (f *fleet) gather(ctx context.Context, path string) []sessions.Session {
	var mu sync.Mutex
	var wg sync.WaitGroup
	var out []sessions.Session
	for _, p := range f.peers {
		wg.Add(1)
		go func(p Peer) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			var list []sessions.Session
			err := f.get(ctx, p, path, &list)
			f.mu.Lock()
			f.status[p.Name] = ""
			if err != nil {
				f.status[p.Name] = err.Error()
			}
			f.mu.Unlock()
			if err != nil {
				return
			}
			for i := range list {
				list[i].Host = p.Name
			}
			f.remember(p.Name, list)
			mu.Lock()
			out = append(out, list...)
			mu.Unlock()
		}(p)
	}
	wg.Wait()
	return out
}

func (f *fleet) statuses() []peerStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []peerStatus{}
	for _, p := range f.peers {
		out = append(out, peerStatus{p.Name, f.status[p.Name]})
	}
	return out
}

func (f *fleet) viewing(host, id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.views[host+"/"+id] > 0
}

func (f *fleet) proxy(w http.ResponseWriter, r *http.Request, p *Peer, attachID string) {
	target, err := url.Parse(p.URL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if attachID != "" {
		key := p.Name + "/" + attachID
		f.mu.Lock()
		f.views[key]++
		f.mu.Unlock()
		defer func() { f.mu.Lock(); f.views[key]--; f.mu.Unlock() }()
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			q := pr.Out.URL.Query()
			q.Del("host")
			pr.Out.URL.RawQuery = q.Encode()
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Set("Authorization", "Bearer "+p.Token)
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, p.Name+" is unreachable: "+err.Error(), http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(w, r)
}

func mergeHistory(lists [][]sessions.Session, limit int) []sessions.Session {
	var all []sessions.Session
	for _, l := range lists {
		all = append(all, l...)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].Updated.After(all[j].Updated) })
	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}
	return all
}
