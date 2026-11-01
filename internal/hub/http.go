package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) { h.serveWS(w, r, r.URL.Query().Get("channel"), true) })
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) { h.serveWS(w, r, "", false) })
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) { reply(w, h.Status()) })
	mux.HandleFunc("POST /message", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Channel, Text string }
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Channel == "" || req.Text == "" {
			http.Error(w, "channel and text are required", http.StatusBadRequest)
			return
		}
		st, err := h.Say(req.Channel, req.Text)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		reply(w, map[string]string{"status": st})
	})
	mux.HandleFunc("POST /interrupt", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Channel string }
		json.NewDecoder(r.Body).Decode(&req)
		reply(w, map[string]bool{"interrupted": h.Interrupt(req.Channel, true)})
	})
	mux.HandleFunc("POST /notice", func(w http.ResponseWriter, r *http.Request) {
		joined, err := h.Notice()
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		reply(w, map[string]bool{"joined": joined})
	})
	mux.HandleFunc("POST /reset", func(w http.ResponseWriter, r *http.Request) {
		if err := h.Reset("asked"); err != nil {
			code := http.StatusServiceUnavailable
			if errors.Is(err, ErrBusy) {
				code = http.StatusConflict
			}
			http.Error(w, err.Error(), code)
			return
		}
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /call", func(w http.ResponseWriter, r *http.Request) {
		var req CallReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		out, err := h.Call(r.Context(), req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		reply(w, map[string]string{"outcome": out})
	})
	return mux
}

// serveWS is one channel's connection (or, with no channel, a watcher of all of them).
func (h *Hub) serveWS(w http.ResponseWriter, r *http.Request, channel string, talk bool) {
	if talk && channel == "" {
		channel = "anon"
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(4 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	events, done := h.Subscribe(channel)
	defer done()
	log.Printf("hub: %s connected", nameOf(channel))
	defer log.Printf("hub: %s left", nameOf(channel))
	defer h.Left(channel)
	go func() {
		defer cancel()
		ping := time.NewTicker(30 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-events:
				if !ok || wsjson.Write(ctx, c, e) != nil {
					return
				}
			case <-ping.C:
				pctx, pc := context.WithTimeout(ctx, 20*time.Second)
				err := c.Ping(pctx)
				pc()
				if err != nil {
					return
				}
			}
		}
	}()
	for {
		var m struct{ Type, Text string }
		if err := wsjson.Read(ctx, c, &m); err != nil {
			c.CloseNow()
			return
		}
		if !talk {
			continue
		}
		switch m.Type {
		case "message":
			if _, err := h.Say(channel, m.Text); err != nil {
				h.mu.Lock()
				h.emit(Event{Type: "error", Channel: channel, Error: err.Error()})
				h.mu.Unlock()
			}
		case "note":
			h.Say(channel, "["+channel+" event] "+m.Text)
		case "interrupt":
			h.Interrupt(channel, false)
		}
	}
}

func nameOf(channel string) string {
	if channel == "" {
		return "a watcher"
	}
	return channel
}

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
