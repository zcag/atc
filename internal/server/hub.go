package server

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

const hubName = "assistant"

const hubPrompt = `Messages reach you from several channels: atc (typed on a screen), atc-voice (spoken in atc), whatsapp, phone ` +
	`(a live call on delta's line) and agent (other sessions reporting back). When the channel changes, a "[talk-mode: ...]" line ` +
	`brings how to talk there; follow it until the next one. Answer where the message came from. To reach the user elsewhere use ` +
	"`atc wa` (WhatsApp) or `atc call --reason TEXT` (delta rings their phone and the call comes to you; `atc call -h`). "

// HubArgs are the flags for the hub's Claude: the same tools and switchboard as atc's standing
// sessions, plus how the channels work.
func HubArgs() []string {
	return append(standingArgs(hubPrompt+switchboard), "--disallowedTools", "AskUserQuestion,EnterPlanMode")
}

// hubLink is atc's view of the hub: its session, whether it answers, and who each live turn serves.
type hubLink struct {
	mu      sync.Mutex
	up      bool
	sid     string
	path    string
	onAtc   bool
	streams map[chan hub.Event]string
	wa      chan hub.Event
}

func (s *Server) startHub() {
	s.hub = &hubLink{streams: map[chan hub.Event]string{}, wa: make(chan hub.Event, 4096)}
	if s.StateDir != "" {
		s.hub.path = filepath.Join(s.StateDir, "hub.json")
		var saved struct{ Session string }
		if b, err := os.ReadFile(s.hub.path); err == nil && json.Unmarshal(b, &saved) == nil {
			s.hub.sid = saved.Session
		}
	}
	if s.WhatsApp != nil {
		go s.waHubLoop()
	}
	go func() {
		for {
			err := s.Hub.Watch(context.Background(), func(e hub.Event) {
				s.hub.mu.Lock()
				if !s.hub.up {
					s.hub.up = true
					log.Printf("hub: connected")
				}
				s.hub.mu.Unlock()
				s.hubEvent(e)
			})
			s.hub.mu.Lock()
			if s.hub.up {
				log.Printf("hub: lost (%v), WhatsApp falls back to a background session", err)
			}
			s.hub.up = false
			s.hub.mu.Unlock()
			s.refresh()
			time.Sleep(3 * time.Second)
		}
	}()
}

func (s *Server) hubUp() bool {
	if s.hub == nil {
		return false
	}
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	return s.hub.up && s.hub.sid != ""
}

// hubSession is the hub's session id while the hub is up, for routing what is sent to it.
func (s *Server) hubSession(id string) bool {
	if !s.hubUp() || id == "" {
		return false
	}
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	return s.hub.sid == id
}

func (s *Server) hubSID() string {
	if s.hub == nil {
		return ""
	}
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	return s.hub.sid
}

func (s *Server) hubEvent(e hub.Event) {
	switch e.Type {
	case "session":
		s.hub.mu.Lock()
		changed := s.hub.sid != e.Text
		s.hub.sid = e.Text
		if b, err := json.Marshal(map[string]string{"session": e.Text}); err == nil && s.hub.path != "" {
			os.WriteFile(s.hub.path, b, 0o644)
		}
		s.hub.mu.Unlock()
		go s.hubClaim(e.Text, changed)
	case "reset":
		s.M.Store.Update(e.Text, func(m *store.Meta) { m.Name = hubName + " " + time.Now().Format("01-02 15:04") })
	case "turn":
		s.hub.mu.Lock()
		s.hub.onAtc = e.Channel == "atc" || e.Channel == "atc-voice"
		s.hub.mu.Unlock()
	case "read", "joined":
		if e.Channel == "atc" || e.Channel == "atc-voice" {
			s.hub.mu.Lock()
			s.hub.onAtc = true
			s.hub.mu.Unlock()
		}
	}
	switch e.Type {
	case "turn", "done", "session", "reset", "held":
		s.refresh()
	}
	s.hub.mu.Lock()
	for ch := range s.hub.streams {
		select {
		case ch <- e:
		default:
		}
	}
	s.hub.mu.Unlock()
	if e.Channel == waName && s.WhatsApp != nil {
		select {
		case s.hub.wa <- e:
		default:
			log.Printf("hub: whatsapp is behind, dropped a %s", e.Type)
		}
	}
}

// hubClaim names the hub's session in atc, and retires what it replaces: the standing assistant
// gets a dated name, and a background whatsapp session (the conversation the hub took over, or
// one started while the hub was down) is stopped so two processes never write one conversation.
func (s *Server) hubClaim(sid string, changed bool) {
	if sid == "" {
		return
	}
	if m := s.M.Store.Get(sid); m.Name != hubName {
		s.M.Store.Update(sid, func(m *store.Meta) { m.Name, m.Parked = hubName, false })
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	list, err := s.M.Live(ctx)
	if err != nil {
		return
	}
	stamp := time.Now().Format("01-02 15:04")
	for _, x := range list {
		if x.Kind != "background" {
			continue
		}
		if x.SessionID == sid {
			if x.Attachable {
				log.Printf("hub: stopping %s, a background copy of the hub's conversation", x.ID)
				s.M.CLI.Stop(ctx, x.ID)
			}
			continue
		}
		name := cmp.Or(s.M.Store.Get(x.SessionID).Name, x.Name)
		if name != hubName && name != waName {
			continue
		}
		s.M.Store.Update(x.SessionID, func(m *store.Meta) { m.Name = name + " " + stamp })
		if x.Attachable {
			log.Printf("hub: stopping the %s session %s, the hub has it now", name, x.ID)
			s.M.CLI.Stop(ctx, x.ID)
		}
	}
	for _, old := range s.M.Store.Find(func(id string, m store.Meta) bool { return m.Name == hubName && id != sid }) {
		s.M.Store.Update(old, func(m *store.Meta) { m.Name = hubName + " " + stamp })
	}
	s.refresh()
}

// hubMark shows the hub's session as what it is: one atc can send to but not attach to,
// working while the hub runs a turn.
func (s *Server) hubMark(ctx context.Context, list []sessions.Session) []sessions.Session {
	if !s.hubUp() {
		return list
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	st, err := s.Hub.Status(ctx)
	if err != nil || st.Session == "" {
		return list
	}
	i := slices.IndexFunc(list, func(x sessions.Session) bool { return x.SessionID == st.Session })
	if i < 0 {
		x, ok := s.M.Session(st.Session)
		if !ok {
			home, _ := os.UserHomeDir()
			x = sessions.Session{SessionID: st.Session, Cwd: home}
		}
		list, i = append(list, x), len(list)
	}
	x := &list[i]
	x.Kind, x.ID, x.Harness, x.PID, x.Attachable = "hub", st.Session, "hub", st.PID, st.Alive
	x.Title = cmp.Or(s.M.Store.Get(st.Session).Name, hubName)
	x.Pinned, x.Parked = s.M.Store.Get(st.Session).Pinned, false
	x.Asks, x.TurnDone = nil, false
	if len(st.Owners) > 0 || len(st.Pending) > 0 {
		x.State = sessions.Working
		where := map[string]string{hub.Phone: "on a call", waName: "on WhatsApp", "atc-voice": "by voice"}[cmp.Or(st.Route, append(st.Pending, "")[0])]
		x.Activity = strings.Join(slices.DeleteFunc([]string{where, x.Activity}, func(p string) bool { return p == "" }), " · ")
	} else {
		x.State, x.Activity = sessions.YourTurn, ""
	}
	if st.Call != "" {
		x.Activity = cmp.Or(x.Activity, "calling you")
	}
	return list
}

// hubQuiet is a hub turn that was answered on WhatsApp or the phone: that channel already told
// the user, so it doesn't push.
func (s *Server) hubQuiet(x sessions.Session) bool {
	if x.Kind != "hub" {
		return false
	}
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	return !s.hub.onAtc
}

func (s *Server) hubSend(ctx context.Context, channel, text string) error {
	st, err := s.Hub.Send(ctx, channel, text)
	if err == nil && st == "held" {
		log.Printf("hub: %s message held until the call's turn ends", channel)
	}
	return err
}

// hubStream relays the hub's events as they come, so the transcript shows a reply as it is written.
func (s *Server) hubStream(w http.ResponseWriter, r *http.Request) {
	if !s.hubSession(r.PathValue("sid")) {
		http.Error(w, "not the hub's session", http.StatusNotFound)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch := make(chan hub.Event, 1024)
	s.hub.mu.Lock()
	s.hub.streams[ch] = r.PathValue("sid")
	s.hub.mu.Unlock()
	defer func() { s.hub.mu.Lock(); delete(s.hub.streams, ch); s.hub.mu.Unlock() }()
	fmt.Fprint(w, ": hello\n\n")
	fl.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			switch e.Type {
			case "text", "tool", "done", "turn", "error", "notice", "held", "reset":
			default:
				continue
			}
			b, _ := json.Marshal(e)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return
			}
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// call has delta ring the user, with the hub's session on the line. The caller hears how it went
// with wait; otherwise a call nobody picked up is reported back to the session that asked.
func (s *Server) call(w http.ResponseWriter, r *http.Request) {
	if s.Hub == nil {
		http.Error(w, "atc on "+s.Host+" has no hub (ATC_HUB)", http.StatusNotFound)
		return
	}
	var req struct {
		Reason, From, Session string
		Wait                  bool
		Timeout               int
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fromHub := req.Session != "" && req.Session == s.hubSID()
	cr := hub.CallReq{Reason: req.Reason, From: req.From, Timeout: req.Timeout, Notify: fromHub && !req.Wait}
	if fromHub {
		cr.From = ""
	}
	if req.Wait {
		out, err := s.Hub.Call(r.Context(), cr)
		if err != nil {
			fail(w, err)
			return
		}
		reply(w, map[string]string{"outcome": out})
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		out, err := s.Hub.Call(ctx, cr)
		if err != nil {
			log.Printf("call: %v", err)
			out = "failed: " + err.Error()
		}
		if out == hub.Answered || fromHub || req.Session == "" {
			return
		}
		note := fmt.Sprintf("[telefon · %s · kullanıcı aramayı açmadı (%s)", time.Now().Format("15:04"), out)
		if req.Reason != "" {
			note += " · sebep: " + req.Reason
		}
		if err := s.sendSession(ctx, req.Session, note+"]"); err != nil {
			log.Printf("call: telling %s: %v", req.Session, err)
		}
	}()
	reply(w, map[string]string{"outcome": "dialing"})
}

// sendSession types text into a running session by its session id, whatever runs it.
func (s *Server) sendSession(ctx context.Context, sid, text string) error {
	if s.hubSession(sid) {
		return s.hubSend(ctx, hub.Agent, text)
	}
	if s.M.OpenCode(sid) {
		return s.sendOpenCode(ctx, sid, text)
	}
	list, err := s.M.Live(ctx)
	if err != nil {
		return err
	}
	x, ok := find(list, sid)
	if !ok || !x.Attachable {
		return errors.New("that session is not running in the background")
	}
	return s.Term.Send(ctx, x.ID, text)
}
