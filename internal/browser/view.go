package browser

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type cdp struct {
	ws   *websocket.Conn
	mu   sync.Mutex
	next int64
	wait map[int64]chan message
}

func (c *cdp) call(ctx context.Context, session, method string, params any) (json.RawMessage, error) {
	raw, _ := json.Marshal(params)
	c.mu.Lock()
	c.next++
	id := c.next
	ch := make(chan message, 1)
	c.wait[id] = ch
	c.mu.Unlock()
	if err := wsjson.Write(ctx, c.ws, message{ID: &id, Method: method, SessionID: session, Params: raw}); err != nil {
		return nil, err
	}
	select {
	case m := <-ch:
		if m.Error != nil {
			var e struct{ Message string }
			json.Unmarshal(m.Error, &e)
			return nil, errors.New(e.Message)
		}
		return m.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *cdp) read(ctx context.Context, event func(message)) error {
	for {
		var m message
		if err := wsjson.Read(ctx, c.ws, &m); err != nil {
			return err
		}
		if m.ID == nil {
			event(m)
			continue
		}
		c.mu.Lock()
		ch := c.wait[*m.ID]
		delete(c.wait, *m.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}

var viewable = map[string]bool{
	"Input.dispatchMouseEvent": true, "Input.dispatchKeyEvent": true, "Input.insertText": true,
	"Page.navigate": true, "Page.reload": true, "Page.getNavigationHistory": true, "Page.navigateToHistoryEntry": true,
	"Page.startScreencast": true, "Page.stopScreencast": true, "Emulation.setDeviceMetricsOverride": true,
}

type viewIn struct {
	ID     int64           `json:"id"`
	Method string          `json:"m"`
	Params json.RawMessage `json:"p"`
}

type viewOut struct {
	T      string          `json:"t"`
	ID     int64           `json:"id,omitempty"`
	Result json.RawMessage `json:"r,omitempty"`
	Error  string          `json:"e,omitempty"`
	Data   string          `json:"data,omitempty"`
	Meta   json.RawMessage `json:"meta,omitempty"`
	Title  string          `json:"title,omitempty"`
	URL    string          `json:"url,omitempty"`
}

// View streams one of the session's tabs to the user and takes their input back:
// frames from Page.startScreencast out, a short list of Input and Page calls in.
func (b *Browser) View(w http.ResponseWriter, r *http.Request, sid, tab string) {
	if b.Owner(tab) != sid {
		http.Error(w, "no such tab in this session", http.StatusNotFound)
		return
	}
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
	defer up.CloseNow()
	down, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer down.CloseNow()
	up.SetReadLimit(-1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wmu sync.Mutex
	tell := func(o viewOut) error {
		wmu.Lock()
		defer wmu.Unlock()
		return wsjson.Write(ctx, down, o)
	}
	c := &cdp{ws: up, wait: map[int64]chan message{}}
	var session string
	acks := make(chan json.RawMessage, 8)
	go func() {
		defer cancel()
		c.read(ctx, func(m message) {
			switch m.Method {
			case "Page.screencastFrame":
				var f struct {
					Data      string          `json:"data"`
					Metadata  json.RawMessage `json:"metadata"`
					SessionID int64           `json:"sessionId"`
				}
				json.Unmarshal(m.Params, &f)
				if tell(viewOut{T: "frame", Data: f.Data, Meta: f.Metadata}) == nil {
					ack, _ := json.Marshal(map[string]int64{"sessionId": f.SessionID})
					select {
					case acks <- ack:
					default:
					}
				}
			case "Target.targetInfoChanged":
				var p struct {
					TargetInfo struct{ TargetID, Title, URL string } `json:"targetInfo"`
				}
				json.Unmarshal(m.Params, &p)
				if p.TargetInfo.TargetID == tab {
					tell(viewOut{T: "info", Title: p.TargetInfo.Title, URL: p.TargetInfo.URL})
				}
			case "Target.targetDestroyed", "Target.detachedFromTarget":
				var p struct{ TargetID string }
				json.Unmarshal(m.Params, &p)
				if p.TargetID == tab {
					tell(viewOut{T: "gone"})
					cancel()
				}
			}
		})
	}()
	go func() {
		for {
			select {
			case ack := <-acks:
				c.call(ctx, session, "Page.screencastFrameAck", ack)
			case <-ctx.Done():
				return
			}
		}
	}()
	res, err := c.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": tab, "flatten": true})
	if err != nil {
		tell(viewOut{T: "gone", Error: err.Error()})
		return
	}
	var att struct{ SessionID string }
	json.Unmarshal(res, &att)
	session = att.SessionID
	c.call(ctx, "", "Target.setDiscoverTargets", map[string]bool{"discover": true})
	c.call(ctx, session, "Page.enable", nil)
	c.call(ctx, session, "Page.bringToFront", nil)

	for {
		var in viewIn
		if err := wsjson.Read(ctx, down, &in); err != nil {
			return
		}
		if in.Method == "Target.closeTarget" {
			c.call(ctx, "", in.Method, map[string]string{"targetId": tab})
			continue
		}
		if !viewable[in.Method] {
			tell(viewOut{T: "r", ID: in.ID, Error: in.Method + " is not allowed here"})
			continue
		}
		go func() {
			r, err := c.call(ctx, session, in.Method, in.Params)
			o := viewOut{T: "r", ID: in.ID, Result: r}
			if err != nil {
				o.Error = err.Error()
			}
			tell(o)
		}()
	}
}
