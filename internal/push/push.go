package push

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type Message struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`
	URL   string `json:"url"`
}

type Pusher struct {
	dir     string
	contact string
	pub     string
	priv    string
	mu      sync.Mutex
	subs    []webpush.Subscription
}

func Open(dir, contact string) (*Pusher, error) {
	p := &Pusher{dir: dir, contact: contact}
	var keys struct{ Public, Private string }
	if b, err := os.ReadFile(p.path("vapid.json")); err == nil {
		json.Unmarshal(b, &keys)
	}
	if keys.Public == "" {
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		keys.Public, keys.Private = pub, priv
		if err := p.save("vapid.json", keys); err != nil {
			return nil, err
		}
	}
	p.pub, p.priv = keys.Public, keys.Private
	if b, err := os.ReadFile(p.path("push.json")); err == nil {
		json.Unmarshal(b, &p.subs)
	}
	return p, nil
}

func (p *Pusher) Key() string { return p.pub }

func (p *Pusher) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.subs)
}

func (p *Pusher) Add(s webpush.Subscription) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.drop(s.Endpoint)
	p.subs = append(p.subs, s)
	return p.save("push.json", p.subs)
}

func (p *Pusher) Remove(endpoint string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.drop(endpoint)
	return p.save("push.json", p.subs)
}

func (p *Pusher) Send(m Message) {
	body, _ := json.Marshal(m)
	p.mu.Lock()
	subs := append([]webpush.Subscription(nil), p.subs...)
	p.mu.Unlock()
	for _, s := range subs {
		res, err := webpush.SendNotification(body, &s, &webpush.Options{
			Subscriber: p.contact, VAPIDPublicKey: p.pub, VAPIDPrivateKey: p.priv,
			TTL: 3600, Urgency: webpush.UrgencyHigh, Topic: topic(m.Tag),
		})
		if err != nil {
			log.Printf("push: %v", err)
			continue
		}
		res.Body.Close()
		if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
			p.Remove(s.Endpoint)
		} else if res.StatusCode >= 300 {
			log.Printf("push: %s answered %s", s.Endpoint[:min(len(s.Endpoint), 40)], res.Status)
		} else {
			log.Printf("push: %q sent (%s)", m.Title+": "+m.Body, res.Status)
		}
	}
}

func topic(tag string) string {
	if len(tag) > 32 {
		return tag[:32]
	}
	return tag
}

func (p *Pusher) drop(endpoint string) {
	out := p.subs[:0]
	for _, s := range p.subs {
		if s.Endpoint != endpoint {
			out = append(out, s)
		}
	}
	p.subs = out
}

func (p *Pusher) path(name string) string { return filepath.Join(p.dir, name) }

func (p *Pusher) save(name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	os.MkdirAll(p.dir, 0o700)
	tmp := p.path(name) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.path(name))
}
