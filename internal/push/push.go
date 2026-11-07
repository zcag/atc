package push

import (
	"bytes"
	"cmp"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Message struct {
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Tag     string   `json:"tag"`
	URL     string   `json:"url"`
	Session string   `json:"session,omitempty"`
	Replies []string `json:"replies,omitempty"`
	Open    bool     `json:"open,omitempty"`
	Bay     string   `json:"bay,omitempty"`
	Ask     *Ask     `json:"ask,omitempty"`
}

// Ask is a session's question or permission as the phone answers it, from a push's actions or the
// widget, through POST /api/sessions/{sid}/asks/{id}?key=, which refuses once the session asks
// something else. A permission has a Tool; a question has Options when one tap answers it.
type Ask struct {
	SID     string   `json:"sid"`
	ID      string   `json:"id"`
	Key     string   `json:"key"`
	Host    string   `json:"host,omitempty"`
	Text    string   `json:"text,omitempty"`
	Tool    string   `json:"tool,omitempty"`
	Cmd     string   `json:"cmd,omitempty"`
	Options []string `json:"options,omitempty"`
}

// Device is a phone registered for pushes. Confirms is set once it has said it got one (POST
// /api/push/heard): only such a device can be told apart from one that stopped hearing them.
type Device struct {
	Endpoint string    `json:"endpoint"`
	Name     string    `json:"name,omitempty"`
	Widget   bool      `json:"widget,omitempty"`
	Confirms bool      `json:"confirms,omitempty"`
	Added    time.Time `json:"added"`
}

type Pusher struct {
	path    string
	client  *http.Client
	mu      sync.Mutex
	devices []Device
	unheard map[string]time.Time
	heard   map[string]time.Time
}

// Deaf is a device that has not confirmed a push for a while: Since is the last one it confirmed,
// or when the first unconfirmed one was sent.
type Deaf struct {
	Name, Endpoint string
	Since          time.Time
}

func Open(path string) (*Pusher, error) {
	p := &Pusher{path: path, client: &http.Client{Timeout: 15 * time.Second}, unheard: map[string]time.Time{}, heard: map[string]time.Time{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return p, nil
	}
	if err != nil {
		return nil, err
	}
	return p, json.Unmarshal(b, &p.devices)
}

func (p *Pusher) Devices() []Device {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Device(nil), p.devices...)
}

func (p *Pusher) Count() int { return len(p.Devices()) }

func (p *Pusher) Add(d Device) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.drop(d.Endpoint)
	d.Added = time.Now()
	p.devices = append(p.devices, d)
	return p.save()
}

func (p *Pusher) Remove(endpoint string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.drop(endpoint)
	return p.save()
}

// Heard records that a device got a push.
func (p *Pusher) Heard(endpoint string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.unheard, endpoint)
	p.heard[endpoint] = time.Now()
	for i, d := range p.devices {
		if d.Endpoint == endpoint && !d.Confirms {
			p.devices[i].Confirms = true
			p.save()
		}
	}
}

// Deaf lists the devices that confirm pushes and have left one unconfirmed for longer than after.
func (p *Pusher) Deaf(after time.Duration) []Deaf {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []Deaf
	for _, d := range p.devices {
		sent, ok := p.unheard[d.Endpoint]
		if !d.Confirms || !ok || time.Since(sent) < after {
			continue
		}
		since := p.heard[d.Endpoint]
		if since.IsZero() {
			since = sent
		}
		out = append(out, Deaf{Name: cmp.Or(d.Name, "a phone"), Endpoint: d.Endpoint, Since: since})
	}
	return out
}

func (p *Pusher) sent(endpoint string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.unheard[endpoint]; !ok {
		p.unheard[endpoint] = time.Now()
	}
}

func (p *Pusher) Send(m Message) {
	p.post(m, m.Title+": "+m.Body, func(Device) bool { return true })
}

// Ring has the phone app ring for a call to the user; it connects to the call line to take it.
func (p *Pusher) Ring(reason string) {
	p.post(map[string]any{"ring": map[string]any{"reason": reason, "at": time.Now().Unix()}}, "ring", func(Device) bool { return true })
}

func (p *Pusher) SendWidget(v any) {
	p.post(v, "", func(d Device) bool { return d.Widget })
}

func (p *Pusher) post(v any, what string, to func(Device) bool) {
	body, _ := json.Marshal(v)
	for _, d := range p.Devices() {
		if !to(d) {
			continue
		}
		res, err := p.client.Post(d.Endpoint, "application/json", bytes.NewReader(body))
		if err != nil {
			log.Printf("push: %v", err)
			continue
		}
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
			p.Remove(d.Endpoint)
		case res.StatusCode >= 300:
			log.Printf("push: %s answered %s", d.Name, res.Status)
		default:
			p.sent(d.Endpoint)
			if what != "" {
				log.Printf("push: %q sent to %s", what, d.Name)
			}
		}
	}
}

func (p *Pusher) drop(endpoint string) {
	delete(p.unheard, endpoint)
	delete(p.heard, endpoint)
	out := p.devices[:0]
	for _, d := range p.devices {
		if d.Endpoint != endpoint {
			out = append(out, d)
		}
	}
	p.devices = out
}

func (p *Pusher) save() error {
	b, err := json.MarshalIndent(p.devices, "", "  ")
	if err != nil {
		return err
	}
	os.MkdirAll(filepath.Dir(p.path), 0o700)
	tmp := p.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.path)
}
