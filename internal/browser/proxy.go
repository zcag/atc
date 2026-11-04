package browser

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type message struct {
	ID        *int64          `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     json.RawMessage `json:"error,omitempty"`
}

type targetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	OpenerID string `json:"openerId,omitempty"`
}

const ownID = int64(2_000_000_000)

type conn struct {
	b    *Browser
	sid  string
	up   *websocket.Conn
	down *websocket.Conn

	mu       sync.Mutex
	creating map[int64]bool
	since    time.Time
	held     []message
	listing  map[int64]bool
	hidden   map[string]bool
	foreign  map[string]bool
	next     int64
}

// Proxy relays one CDP client to Chrome, as if the session's tabs were the only ones.
func (b *Browser) Proxy(w http.ResponseWriter, r *http.Request, sid string) {
	ws, err := b.wsURL(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	up, _, err := websocket.Dial(r.Context(), ws, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	down, err := websocket.Accept(w, r, nil)
	if err != nil {
		up.CloseNow()
		return
	}
	up.SetReadLimit(-1)
	down.SetReadLimit(-1)
	c := &conn{b: b, sid: sid, up: up, down: down, creating: map[int64]bool{}, listing: map[int64]bool{},
		hidden: map[string]bool{}, foreign: map[string]bool{}, next: ownID}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		defer cancel()
		c.pump(ctx, down, c.fromClient)
	}()
	c.pump(ctx, up, c.fromChrome)
	up.CloseNow()
	down.CloseNow()
}

func (c *conn) pump(ctx context.Context, from *websocket.Conn, handle func(context.Context, message)) {
	for {
		_, data, err := from.Read(ctx)
		if err != nil {
			return
		}
		var m message
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		handle(ctx, m)
	}
}

func (c *conn) send(ctx context.Context, to *websocket.Conn, m message) {
	data, _ := json.Marshal(m)
	if err := to.Write(ctx, websocket.MessageText, data); err != nil && ctx.Err() == nil {
		log.Printf("browser %s: %v", short(c.sid), err)
	}
}

func (c *conn) fromClient(ctx context.Context, m message) {
	c.mu.Lock()
	if m.ID != nil {
		switch m.Method {
		case "Target.createTarget":
			if len(c.creating) == 0 {
				c.since = time.Now()
			}
			c.creating[*m.ID] = true
		case "Target.getTargets":
			c.listing[*m.ID] = true
		case "Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo":
			var p struct {
				TargetID string `json:"targetId"`
			}
			json.Unmarshal(m.Params, &p)
			if c.foreign[p.TargetID] || (p.TargetID != "" && c.b.Owner(p.TargetID) != "" && c.b.Owner(p.TargetID) != c.sid) {
				c.mu.Unlock()
				c.send(ctx, c.down, message{ID: m.ID, SessionID: m.SessionID, Error: json.RawMessage(`{"code":-32602,"message":"No target with given id found"}`)})
				return
			}
		}
	}
	c.mu.Unlock()
	c.send(ctx, c.up, m)
}

func (c *conn) fromChrome(ctx context.Context, m message) {
	c.mu.Lock()
	if m.ID != nil && *m.ID >= ownID {
		c.mu.Unlock()
		return
	}
	if m.ID != nil && c.creating[*m.ID] {
		delete(c.creating, *m.ID)
		var r struct {
			TargetID string `json:"targetId"`
		}
		if json.Unmarshal(m.Result, &r) == nil && r.TargetID != "" {
			c.b.claim(r.TargetID, c.sid)
		}
		if len(c.creating) > 0 {
			c.held = append(c.held, m)
			c.mu.Unlock()
			return
		}
		out := append(c.held, m)
		c.held = nil
		c.deliver(ctx, out)
		return
	}
	if len(c.creating) > 0 && time.Since(c.since) < 10*time.Second {
		c.held = append(c.held, m)
		c.mu.Unlock()
		return
	}
	out := append(c.held, m)
	c.held, c.creating = nil, map[int64]bool{}
	c.deliver(ctx, out)
}

// deliver is called with c.mu held and releases it.
func (c *conn) deliver(ctx context.Context, ms []message) {
	var out, chrome []message
	for _, m := range ms {
		if keep, extra := c.filter(m); keep != nil {
			out = append(out, *keep)
		} else {
			chrome = append(chrome, extra...)
		}
	}
	c.mu.Unlock()
	for _, m := range chrome {
		c.send(ctx, c.up, m)
	}
	for _, m := range out {
		c.send(ctx, c.down, m)
	}
}

func (c *conn) mine(t targetInfo) bool {
	if t.Type != "page" {
		return true
	}
	switch owner := c.b.Owner(t.TargetID); {
	case owner == c.sid:
		return true
	case owner == "" && t.OpenerID != "" && c.b.Owner(t.OpenerID) == c.sid:
		c.b.claim(t.TargetID, c.sid)
		return true
	}
	c.foreign[t.TargetID] = true
	return false
}

func (c *conn) own() *int64 {
	c.next++
	id := c.next
	return &id
}

func (c *conn) filter(m message) (*message, []message) {
	if m.SessionID != "" && c.hidden[m.SessionID] {
		return nil, nil
	}
	if m.ID != nil && c.listing[*m.ID] {
		delete(c.listing, *m.ID)
		var r struct {
			TargetInfos []json.RawMessage `json:"targetInfos"`
		}
		if json.Unmarshal(m.Result, &r) == nil {
			var keep []json.RawMessage
			for _, raw := range r.TargetInfos {
				var t targetInfo
				if json.Unmarshal(raw, &t) == nil && c.mine(t) {
					keep = append(keep, raw)
				}
			}
			r.TargetInfos = keep
			if r.TargetInfos == nil {
				r.TargetInfos = []json.RawMessage{}
			}
			m.Result, _ = json.Marshal(r)
		}
		return &m, nil
	}
	if m.SessionID != "" || m.Method == "" {
		return &m, nil
	}
	var p struct {
		SessionID          string     `json:"sessionId"`
		TargetID           string     `json:"targetId"`
		TargetInfo         targetInfo `json:"targetInfo"`
		WaitingForDebugger bool       `json:"waitingForDebugger"`
	}
	json.Unmarshal(m.Params, &p)
	switch m.Method {
	case "Target.attachedToTarget":
		if c.mine(p.TargetInfo) {
			return &m, nil
		}
		c.hidden[p.SessionID] = true
		var let []message
		if p.WaitingForDebugger {
			let = append(let, message{ID: c.own(), Method: "Runtime.runIfWaitingForDebugger", SessionID: p.SessionID})
		}
		params, _ := json.Marshal(map[string]string{"sessionId": p.SessionID})
		return nil, append(let, message{ID: c.own(), Method: "Target.detachFromTarget", Params: params})
	case "Target.targetCreated", "Target.targetInfoChanged":
		if c.mine(p.TargetInfo) {
			return &m, nil
		}
		return nil, nil
	case "Target.targetDestroyed", "Target.targetCrashed":
		gone := m.Method == "Target.targetDestroyed"
		if c.foreign[p.TargetID] {
			if gone {
				delete(c.foreign, p.TargetID)
			}
			return nil, nil
		}
		if gone {
			c.b.forget(p.TargetID)
		}
		return &m, nil
	case "Target.detachedFromTarget":
		if c.hidden[p.SessionID] {
			delete(c.hidden, p.SessionID)
			return nil, nil
		}
	}
	return &m, nil
}

func short(sid string) string { return sid[:min(8, len(sid))] }
