package push

import (
	"bytes"
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
}

type Device struct {
	Endpoint string    `json:"endpoint"`
	Name     string    `json:"name,omitempty"`
	Widget   bool      `json:"widget,omitempty"`
	Added    time.Time `json:"added"`
}

type Pusher struct {
	path    string
	client  *http.Client
	mu      sync.Mutex
	devices []Device
}

func Open(path string) (*Pusher, error) {
	p := &Pusher{path: path, client: &http.Client{Timeout: 15 * time.Second}}
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

func (p *Pusher) Send(m Message) {
	p.post(m, m.Title+": "+m.Body, func(Device) bool { return true })
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
		case what != "":
			log.Printf("push: %q sent to %s", what, d.Name)
		}
	}
}

func (p *Pusher) drop(endpoint string) {
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
