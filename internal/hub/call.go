package hub

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// CallConfig is delta-call (the phone line the hub's session talks on) and the one number it dials.
type CallConfig struct {
	URL     string
	Number  string
	Timeout time.Duration
	Poll    time.Duration
	HTTP    *http.Client
}

const (
	Answered = "answered"
	NoAnswer = "no-answer"
	Busy     = "busy"
)

type call struct {
	reason, from string
	at           time.Time
	answered     bool
	notify       string
}

// envelope is what the session reads before the phone's first message once they pick up.
func (c *call) envelope(now time.Time) string {
	s := fmt.Sprintf("[telefon · %s · kullanıcıyı sen aradın, açtı", now.Format("15:04"))
	if c.reason != "" {
		s += " · sebep: " + c.reason
	}
	s += "]"
	if c.from != "" {
		s += "\n" + c.from
	}
	return s
}

type lineState struct {
	Call    string `json:"call"`
	Precise string `json:"precise"`
}

func (c CallConfig) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (c CallConfig) status(ctx context.Context) (lineState, error) {
	var st lineState
	req, _ := http.NewRequestWithContext(ctx, "GET", c.URL+"/status", nil)
	resp, err := c.client().Do(req)
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	return st, json.NewDecoder(resp.Body).Decode(&st)
}

func (c CallConfig) post(ctx context.Context, path string, body any) error {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", c.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var r struct {
		OK    *bool  `json:"ok"`
		Error string `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&r)
	if resp.StatusCode >= 300 || r.Error != "" || r.OK != nil && !*r.OK {
		return fmt.Errorf("delta-call %s: %s %s", path, resp.Status, r.Error)
	}
	return nil
}

func (c CallConfig) onCall(ctx context.Context) bool {
	if c.URL == "" {
		return false
	}
	st, err := c.status(ctx)
	return err == nil && st.Call != "idle"
}

var ErrNoPhone = errors.New("no phone line configured (ATC_DELTA_CALL)")

type CallReq struct {
	Reason   string `json:"reason"`
	From     string `json:"from,omitempty"`
	Notify   bool   `json:"notify,omitempty"`
	Timeout  int    `json:"timeout,omitempty"`
	WhatsApp bool   `json:"whatsapp,omitempty"`
}

// Call has delta ring them and waits for the outcome. Answered, the phone's first message reaches
// the session with the reason in front of it, so it speaks first and knows why. Not answered,
// a Notify call puts that in front of the session on the channel it was busy with.
func (h *Hub) Call(ctx context.Context, r CallReq) (string, error) {
	c := h.cfg.Call
	if c.URL == "" || c.Number == "" {
		return "", ErrNoPhone
	}
	timeout := cmpDur(time.Duration(r.Timeout)*time.Second, c.Timeout, 45*time.Second)
	h.mu.Lock()
	if h.call != nil {
		h.mu.Unlock()
		return Busy, nil
	}
	pc := &call{reason: strings.TrimSpace(r.Reason), from: strings.TrimSpace(r.From), at: h.cfg.Now()}
	if r.Notify {
		pc.notify = h.last
		if h.turn != nil {
			pc.notify = h.turn.route
		}
		if pc.notify == Phone || pc.notify == "" {
			pc.notify = h.home
		}
	}
	h.call = pc
	h.mu.Unlock()
	clear := func() {
		h.mu.Lock()
		if h.call == pc {
			h.call = nil
		}
		h.mu.Unlock()
	}
	if st, err := c.status(ctx); err != nil {
		clear()
		return "", fmt.Errorf("delta-call: %w", err)
	} else if st.Call != "idle" {
		clear()
		return Busy, nil
	}
	dial := map[string]string{"number": c.Number}
	if r.WhatsApp {
		dial["via"] = "whatsapp"
	}
	if err := c.post(ctx, "/dial", dial); err != nil {
		clear()
		return "", err
	}
	log.Printf("hub: calling %s (%s): %s", c.Number, cmp.Or(dial["via"], "phone"), pc.reason)
	poll := cmpDur(c.Poll, 500*time.Millisecond)
	deadline := time.Now().Add(timeout)
	rang := false
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			clear()
			return "", ctx.Err()
		case <-time.After(poll):
		}
		st, err := c.status(ctx)
		if err != nil {
			continue
		}
		if st.Precise == "active" {
			h.mu.Lock()
			pc.answered = true
			h.mu.Unlock()
			time.AfterFunc(2*time.Minute, clear)
			log.Printf("hub: call answered")
			return Answered, nil
		}
		if st.Call != "idle" {
			rang = true
		} else if rang {
			break
		}
	}
	if !rang || time.Now().After(deadline) {
		c.post(context.WithoutCancel(ctx), "/hangup", map[string]any{})
	}
	clear()
	log.Printf("hub: call not answered")
	if pc.notify != "" {
		text := fmt.Sprintf("[telefon · %s · kullanıcıyı aradın, açmadı", h.cfg.Now().Format("15:04"))
		if pc.reason != "" {
			text += " · sebep: " + pc.reason
		}
		h.Say(pc.notify, text+"]")
	}
	return NoAnswer, nil
}

func cmpDur(ds ...time.Duration) time.Duration {
	for _, d := range ds {
		if d > 0 {
			return d
		}
	}
	return 0
}
