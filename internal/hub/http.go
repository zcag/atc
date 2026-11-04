package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Handler serves the hub. With a guests hub (cfg.Guests), what guests say goes to that one, on the
// same paths, and its own API is under /guests/.
func (h *Hub) Handler() http.Handler {
	return onlyPrograms(h.routes())
}

// onlyPrograms keeps web pages out: the hub has no login, and what reaches it is the user talking to a session that may
// run anything, so a page in a browser on this machine must not be able to post to it or rebind a name to it.
func onlyPrograms(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		named := net.ParseIP(strings.Trim(host, "[]")) != nil || !strings.Contains(host, ".")
		if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") != "" || !named {
			http.Error(w, "the hub takes no requests from web pages", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Hub) routes() http.Handler {
	mux := http.NewServeMux()
	if g := h.cfg.Guests; g != nil {
		mux.Handle("/guests/", http.StripPrefix("/guests", g.Handler()))
	}
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		ch := r.URL.Query().Get("channel")
		h.forChannel(ch).serveWS(w, r, ch, true)
	})
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) { h.serveWS(w, r, "", false) })
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) { reply(w, h.Status()) })
	mux.HandleFunc("POST /message", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Channel, Text string }
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Channel == "" || req.Text == "" {
			http.Error(w, "channel and text are required", http.StatusBadRequest)
			return
		}
		st, err := h.forChannel(req.Channel).Say(req.Channel, req.Text)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		reply(w, map[string]string{"status": st})
	})
	mux.HandleFunc("POST /interrupt", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Channel string }
		json.NewDecoder(r.Body).Decode(&req)
		reply(w, map[string]bool{"interrupted": h.forChannel(req.Channel).Interrupt(req.Channel, true)})
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

func (h *Hub) forChannel(ch string) *Hub {
	if g := h.cfg.Guests; g != nil && guest(ch) {
		return g
	}
	return h
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
