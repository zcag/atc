package hub

import (
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"slices"
	"time"
)

// A line is an agent's conversation while the user talks to it on a call: a stream-json process like the
// assistant's, resumed on the agent's own session, so its words stream to the talker as they are written (its
// background session only writes a reply to its transcript when the turn ends: 8 s for a two-sentence answer,
// measured, against 0.7 s to the first word here). atc stops the background copy and starts it again after.
//
//	POST /lines/<agent>              open it (atc says whether it may), the answer is atc's
//	GET  /lines                      what is open
//	/lines/<agent>/ws, /status, ...  the same API as the hub's, for that conversation
//
// It closes itself once no talker holds it and its last turn has ended.

// LineSpec is what atc answers to opening a line, beside what the talker uses (title, person, voices).
type LineSpec struct {
	Session string   `json:"session"`
	Dir     string   `json:"dir"`
	Args    []string `json:"args"`
}

// OpenLine is the agent's name going in, and atc's status and body coming out.
type OpenLine func(name string) (int, []byte, error)

type Line struct {
	Name    string `json:"name"`
	Session string `json:"session"`
}

const (
	lineGrace = 30 * time.Second
	lineQuiet = 3
)

var lineName = regexp.MustCompile(`^[\w.-]+$`)

func (h *Hub) line(name string) *Hub {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lines[name]
}

func (h *Hub) serveOpenLine(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !lineName.MatchString(name) || h.cfg.OpenLine == nil {
		http.Error(w, "no such line", http.StatusNotFound)
		return
	}
	h.lineMu.Lock()
	defer h.lineMu.Unlock()
	code, body, err := h.cfg.OpenLine(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if code == http.StatusOK && h.line(name) == nil {
		var spec LineSpec
		if err := json.Unmarshal(body, &spec); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if err := h.startLine(name, spec); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	w.Write(body)
}

func (h *Hub) startLine(name string, spec LineSpec) error {
	sub := New(Config{Bin: h.cfg.Bin, Args: spec.Args, Dir: spec.Dir, State: filepath.Join(h.cfg.State, "lines", name),
		Mode: h.cfg.LineMode, Call: CallConfig{URL: h.cfg.Call.URL}, Now: h.cfg.Now})
	sub.saveSID(spec.Session)
	if err := sub.Start(); err != nil {
		return err
	}
	h.mu.Lock()
	h.lines[name] = sub
	h.mu.Unlock()
	log.Printf("hub: line %s open on %s", name, spec.Session)
	go h.closeWhenDone(name, sub)
	return nil
}

// closeWhenDone ends a line once no talker has been on it for a few seconds and nothing is left to do. A
// talker that never connects gets lineGrace. The line ends with the call, not with moving away, so coming
// back to the agent in the same call is instant.
func (h *Hub) closeWhenDone(name string, sub *Hub) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	opened, quiet := time.Now(), 0
	for range t.C {
		sub.mu.Lock()
		holders := 0
		for s := range sub.subs {
			if !s.all && spoken(s.channel) {
				holders++
			}
		}
		idle := sub.turn == nil && len(sub.pending) == 0 && len(sub.held) == 0
		joined := sub.talked
		sub.mu.Unlock()
		if holders > 0 || !idle || !joined && time.Since(opened) < lineGrace {
			quiet = 0
			continue
		}
		if quiet++; quiet < lineQuiet {
			continue
		}
		h.mu.Lock()
		if h.lines[name] == sub {
			delete(h.lines, name)
		}
		h.mu.Unlock()
		sub.Stop()
		log.Printf("hub: line %s closed", name)
		return
	}
}

func (h *Hub) serveLines(w http.ResponseWriter, _ *http.Request) {
	h.mu.Lock()
	subs := make(map[string]*Hub, len(h.lines))
	for name, sub := range h.lines {
		subs[name] = sub
	}
	h.mu.Unlock()
	out := []Line{}
	for name, sub := range subs {
		sub.mu.Lock()
		out = append(out, Line{Name: name, Session: sub.sid})
		sub.mu.Unlock()
	}
	slices.SortFunc(out, func(a, b Line) int {
		if a.Name < b.Name {
			return -1
		}
		return 1
	})
	reply(w, out)
}

func (h *Hub) serveLine(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	sub := h.line(name)
	if sub == nil {
		http.Error(w, "no line open to "+name, http.StatusNotFound)
		return
	}
	http.StripPrefix("/lines/"+name, sub.routes()).ServeHTTP(w, r)
}
