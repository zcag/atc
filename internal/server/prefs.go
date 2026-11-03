package server

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const keepPrefs = 30 * 24 * time.Hour

type draft struct {
	Text string    `json:"text"`
	At   time.Time `json:"at"`
}

type bayMemory struct {
	Sid   string          `json:"sid,omitempty"`
	View  string          `json:"view,omitempty"`
	Panes json.RawMessage `json:"panes,omitempty"`
	At    time.Time       `json:"at"`
}

type bays struct {
	Order  []string             `json:"order"`
	Memory map[string]bayMemory `json:"memory"`
}

func (s *Server) loadPref(name string, v any) {
	if s.StateDir != "" {
		if b, err := os.ReadFile(filepath.Join(s.StateDir, name)); err == nil {
			json.Unmarshal(b, v)
		}
	}
}

func (s *Server) savePref(name string, v any) error {
	if s.StateDir == "" {
		return errors.New("no state dir")
	}
	b, _ := json.Marshal(v)
	p := filepath.Join(s.StateDir, name)
	if err := os.WriteFile(p+".tmp", b, 0o644); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

func (s *Server) editPref(name string, v any, edit func()) error {
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	s.loadPref(name, v)
	edit()
	return s.savePref(name, v)
}

func (s *Server) tell(event string, v any) {
	b, _ := json.Marshal(v)
	s.broadcast(event, b)
}

func prefKey(k string) bool { return k != "" && len(k) <= 200 }

func decodeOr400(w http.ResponseWriter, r *http.Request, v any, want string, ok func() bool) bool {
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v) != nil || !ok() {
		http.Error(w, "want "+want, http.StatusBadRequest)
		return false
	}
	return true
}

func stale[K comparable, V any](m map[K]V, at func(V) time.Time) {
	maps.DeleteFunc(m, func(_ K, v V) bool { return time.Since(at(v)) > keepPrefs })
}

func (s *Server) getSeen(w http.ResponseWriter, r *http.Request) {
	m := map[string]time.Time{}
	s.loadPref("seen.json", &m)
	reply(w, m)
}

func (s *Server) putSeen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string    `json:"sessionId"`
		At        time.Time `json:"at"`
		From      string    `json:"from,omitempty"`
	}
	if !decodeOr400(w, r, &req, "{sessionId, at}", func() bool { return prefKey(req.SessionID) }) {
		return
	}
	if now := time.Now().UTC(); req.At.IsZero() || req.At.After(now) {
		req.At = now
	}
	m := map[string]time.Time{}
	err := s.editPref("seen.json", &m, func() {
		if req.At.After(m[req.SessionID]) {
			m[req.SessionID] = req.At.UTC()
		}
		req.At = m[req.SessionID]
		stale(m, func(t time.Time) time.Time { return t })
	})
	if err != nil {
		fail(w, err)
		return
	}
	s.tell("seen", req)
	reply(w, req)
}

func (s *Server) getDrafts(w http.ResponseWriter, r *http.Request) {
	m := map[string]draft{}
	s.loadPref("drafts.json", &m)
	reply(w, m)
}

func (s *Server) putDraft(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string    `json:"sessionId"`
		Text      string    `json:"text"`
		At        time.Time `json:"at"`
		From      string    `json:"from,omitempty"`
	}
	sid := r.PathValue("sid")
	if !decodeOr400(w, r, &req, "{text}", func() bool { return prefKey(sid) }) {
		return
	}
	req.SessionID, req.At = sid, time.Now().UTC()
	m := map[string]draft{}
	err := s.editPref("drafts.json", &m, func() {
		if req.Text == "" {
			delete(m, sid)
		} else {
			m[sid] = draft{req.Text, req.At}
		}
		stale(m, func(d draft) time.Time { return d.At })
	})
	if err != nil {
		fail(w, err)
		return
	}
	s.tell("drafts", req)
	reply(w, req)
}

func (s *Server) bays() bays {
	b := bays{Order: []string{}, Memory: map[string]bayMemory{}}
	s.loadPref("bays.json", &b)
	return b
}

func (s *Server) getBays(w http.ResponseWriter, r *http.Request) { reply(w, s.bays()) }

func (s *Server) editBays(w http.ResponseWriter, from string, edit func(*bays)) {
	b := bays{Order: []string{}, Memory: map[string]bayMemory{}}
	err := s.editPref("bays.json", &b, func() {
		edit(&b)
		stale(b.Memory, func(m bayMemory) time.Time { return m.At })
	})
	if err != nil {
		fail(w, err)
		return
	}
	s.tell("bays", struct {
		bays
		From string `json:"from,omitempty"`
	}{b, from})
	reply(w, b)
}

func (s *Server) putBays(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Order []string `json:"order"`
		From  string   `json:"from"`
	}
	ok := func() bool { return req.Order != nil && len(req.Order) <= 500 }
	if decodeOr400(w, r, &req, "{order: [bay]}", ok) {
		s.editBays(w, req.From, func(b *bays) { b.Order = req.Order })
	}
}

func (s *Server) patchBay(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Sid, View *string
		Panes     json.RawMessage
		From      string
	}
	bay := r.PathValue("bay")
	if !decodeOr400(w, r, &req, "{sid, view, panes}", func() bool { return prefKey(bay) }) {
		return
	}
	s.editBays(w, req.From, func(b *bays) {
		m := b.Memory[bay]
		if req.Sid != nil {
			m.Sid = *req.Sid
		}
		if req.View != nil {
			m.View = *req.View
		}
		if string(req.Panes) == "null" {
			m.Panes = nil
		} else if req.Panes != nil {
			m.Panes = req.Panes
		}
		m.At = time.Now().UTC()
		b.Memory[bay] = m
	})
}
