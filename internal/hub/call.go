package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/zcag/atc/modes"
)

// CallConfig is the call line the hub's session talks on and the one number it dials.
type CallConfig struct {
	URL     string
	Number  string
	Timeout time.Duration
	Poll    time.Duration
	AppAck  time.Duration
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
	told         bool
	notify       string
}

// envelope is what the session reads before the phone's first message: once they pick up, or while
// it still rings, when delta-talk writes the opening ahead so it plays the moment they answer.
func (c *call) envelope(now time.Time) string {
	state := modes.Line("call.answered")
	if !c.answered {
		state = modes.Line("call.ringing")
	}
	s := fmt.Sprintf(modes.Line("call.you_called"), now.Format("15:04"), state)
	if c.reason != "" {
		s += modes.Line("call.reason") + c.reason
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
	Via      string `json:"via,omitempty"`
}

// lines are the lines a call is tried on, in order: atc's phone app first, then delta's phone
// line. A call the app never reports ringing (the push did not reach the phone) falls back.
func (r CallReq) lines() ([]string, error) {
	via := r.Via
	if r.WhatsApp {
		via = "whatsapp"
	}
	switch via {
	case "":
		return []string{"app", "phone"}, nil
	case "app", "phone", "whatsapp":
		return []string{via}, nil
	}
	return nil, fmt.Errorf("unknown line %q (app, phone or whatsapp)", via)
}

const unreached = "unreached"

// Call has them rung and waits for the outcome. Answered, the call's first message reaches the
// session with the reason in front of it, so it speaks first and knows why. Not answered, a
// Notify call puts that in front of the session on the channel it was busy with.
func (h *Hub) Call(ctx context.Context, r CallReq) (string, error) {
	c := h.cfg.Call
	if c.URL == "" || c.Number == "" {
		return "", ErrNoPhone
	}
	lines, err := r.lines()
	if err != nil {
		return "", err
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
	deadline := time.Now().Add(timeout)
	out := unreached
	for i, via := range lines {
		if out, err = h.ring(ctx, pc, via, deadline, i < len(lines)-1); err != nil || out != unreached {
			break
		}
	}
	if err != nil {
		clear()
		return "", err
	}
	if out == Answered {
		h.mu.Lock()
		told := pc.told
		h.mu.Unlock()
		if told {
			clear()
		} else {
			time.AfterFunc(2*time.Minute, clear)
		}
		return Answered, nil
	}
	clear()
	log.Printf("hub: call not answered")
	if pc.notify != "" {
		text := fmt.Sprintf(modes.Line("call.no_answer"), h.cfg.Now().Format("15:04"))
		if pc.reason != "" {
			text += modes.Line("call.reason") + pc.reason
		}
		h.Say(pc.notify, text+"]")
	}
	return NoAnswer, nil
}

// ring dials one line until they answer, it stops ringing or the deadline passes. On the app
// line, with a line left to fall back to, a call the phone has not reported ringing within
// AppAck is dropped as unreached.
func (h *Hub) ring(ctx context.Context, pc *call, via string, deadline time.Time, fallback bool) (string, error) {
	c := h.cfg.Call
	dial := map[string]string{"number": c.Number}
	if via != "phone" {
		dial["via"] = via
	}
	if err := c.post(ctx, "/dial", dial); err != nil {
		return "", err
	}
	log.Printf("hub: calling %s (%s): %s", c.Number, via, pc.reason)
	if via == "app" {
		h.mu.Lock()
		h.emit(Event{Type: "ring", Text: pc.reason})
		h.mu.Unlock()
	}
	hangup := func() { c.post(context.WithoutCancel(ctx), "/hangup", map[string]any{}) }
	ack := time.Now().Add(cmpDur(c.AppAck, 8*time.Second))
	poll := cmpDur(c.Poll, 500*time.Millisecond)
	rang := false
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			hangup()
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
			log.Printf("hub: call answered (%s)", via)
			return Answered, nil
		}
		if via == "app" && fallback && st.Precise == "dialing" && time.Now().After(ack) {
			hangup()
			log.Printf("hub: the app did not ring")
			return unreached, nil
		}
		if st.Call != "idle" {
			rang = true
		} else if rang {
			return NoAnswer, nil
		}
	}
	hangup()
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
