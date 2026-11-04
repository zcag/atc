package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/pair"
	"github.com/zcag/atc/internal/sessions"
)

type Peer struct {
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token"`
	// CA is the certificate, as PEM, pinned when this peer was paired, for one no system trusts.
	CA string `json:"ca,omitempty"`
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

// SavePeer adds a peer to the file, or replaces the one of that name.
func SavePeer(path string, p Peer) error {
	ps, err := LoadPeers(path)
	if err != nil {
		return err
	}
	ps = slices.DeleteFunc(ps, func(o Peer) bool { return o.Name == p.Name })
	b, err := json.MarshalIndent(append(ps, p), "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

type fleet struct {
	peers  []Peer
	client *http.Client
	mu     sync.Mutex
	owner  map[string]string
	status map[string]string
	views  map[string]int
	down   map[string]bool
}

const probeEvery = 10 * time.Second

func newFleet(peers []Peer) *fleet {
	dial := &net.Dialer{Timeout: 2 * time.Second}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = dial.DialContext
	var cas []string
	for _, p := range peers {
		cas = append(cas, p.CA)
	}
	if cfg := pair.TLS(cas...); cfg != nil {
		tr.TLSClientConfig = cfg
	}
	return &fleet{peers: peers, client: &http.Client{Transport: tr}, owner: map[string]string{}, status: map[string]string{},
		views: map[string]int{}, down: map[string]bool{}}
}

type offline struct{ name string }

func (e offline) Error() string { return e.name + " is offline" }

// offline peers are skipped at once rather than waited on by every request: the first failure marks
// one down and a probe brings it back when it answers again.
func (f *fleet) isDown(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.down[name]
}

func (f *fleet) failed(p Peer, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status[p.Name] = err.Error()
	if f.down[p.Name] {
		return
	}
	f.down[p.Name] = true
	go f.probe(p)
}

func (f *fleet) probe(p Peer) {
	for {
		time.Sleep(probeEvery)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		var me map[string]any
		err := f.fetch(ctx, p, "/api/me", &me)
		cancel()
		if err == nil {
			f.mu.Lock()
			f.down[p.Name], f.status[p.Name] = false, ""
			f.mu.Unlock()
			return
		}
	}
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
	if f.isDown(p.Name) {
		return offline{p.Name}
	}
	err := f.fetch(ctx, p, path, out)
	var ne net.Error
	if errors.As(err, &ne) || errors.Is(err, context.DeadlineExceeded) {
		f.failed(p, err)
	}
	return err
}

func (f *fleet) fetch(ctx context.Context, p Peer, path string, out any) error {
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
			if f.get(ctx, p, path, &list) != nil {
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
		st := f.status[p.Name]
		if f.down[p.Name] {
			st = "offline: " + st
		}
		out = append(out, peerStatus{p.Name, st})
	}
	return out
}

func (f *fleet) viewing(host, id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.views[host+"/"+id] > 0
}

func (f *fleet) proxy(w http.ResponseWriter, r *http.Request, p *Peer, attachID string) {
	if f.isDown(p.Name) {
		http.Error(w, p.Name+" is offline", http.StatusBadGateway)
		return
	}
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
		Transport:     f.client.Transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var ne net.Error
			if errors.As(err, &ne) {
				f.failed(*p, err)
			}
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
