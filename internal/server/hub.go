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
	"github.com/zcag/atc/modes"
)

const (
	hubName    = "assistant"
	guestsName = "guests"
)

// GuestsArgs are the flags for the guests' conversation: its own brief, only atc's tools (no WhatsApp,
// mail or browser of the user's), and no approvals to pass on.
func GuestsArgs() []string {
	return append(standingArgs(modes.Text("guests-desk")), "--strict-mcp-config", "--disallowedTools", "AskUserQuestion,EnterPlanMode")
}

// HubArgs are the flags for the hub's Claude: the same tools and switchboard as atc's standing
// sessions, plus how the channels work.
func HubArgs() []string {
	return append(standingArgs(modes.Text("hub")+" "+switchboard), "--disallowedTools", "AskUserQuestion,EnterPlanMode")
}

// hubLink is atc's view of one of the hub's conversations (the assistant's, or the guests'): its
// session, whether it answers, and who each live turn serves.
type hubLink struct {
	name    string
	c       *hub.Client
	mu      sync.Mutex
	up      bool
	sid     string
	path    string
	onAtc   bool
	streams map[chan hub.Event]string
	wa      chan hub.Event
}

func (s *Server) newHubLink(name string, c *hub.Client, state string) *hubLink {
	l := &hubLink{name: name, c: c, streams: map[chan hub.Event]string{}, wa: make(chan hub.Event, 4096)}
	if s.StateDir != "" {
		l.path = filepath.Join(s.StateDir, state)
		var saved struct{ Session string }
		if b, err := os.ReadFile(l.path); err == nil && json.Unmarshal(b, &saved) == nil {
			l.sid = saved.Session
		}
	}
	return l
}

func (s *Server) startHub() {
	s.hub = s.newHubLink(hubName, s.Hub, "hub.json")
	s.guests = s.newHubLink(guestsName, hub.NewClient(s.Hub.URL+"/guests"), "hub-guests.json")
	if s.WhatsApp != nil {
		go s.waHubLoop()
	}
	go s.watchHub(s.hub, s.hubEvent)
	go s.watchHub(s.guests, func(e hub.Event) {
		if e.Type == "session" {
			go s.guestsClaim(e.Text)
		}
	})
}

func (s *Server) watchHub(l *hubLink, also func(hub.Event)) {
	for {
		err := l.c.Watch(context.Background(), func(e hub.Event) {
			l.mu.Lock()
			if !l.up {
				l.up = true
				log.Printf("hub: %s connected", l.name)
			}
			l.mu.Unlock()
			s.linkEvent(l, e)
			also(e)
		})
		l.mu.Lock()
		if l.up {
			log.Printf("hub: %s lost (%v)", l.name, err)
		}
		l.up = false
		l.mu.Unlock()
		s.refresh()
		time.Sleep(3 * time.Second)
	}
}

func (l *hubLink) live() bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.up && l.sid != ""
}

// is says whether id is this conversation's session while the hub is up, for routing what is sent to it.
func (l *hubLink) is(id string) bool {
	return id != "" && l.live() && l.session() == id
}

func (l *hubLink) session() string {
	if l == nil {
		return ""
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sid
}

// linkOf is the hub conversation whose session id this is, nil for any other session.
func (s *Server) linkOf(id string) *hubLink {
	for _, l := range []*hubLink{s.hub, s.guests} {
		if l.is(id) {
			return l
		}
	}
	return nil
}

func (s *Server) hubUp() bool               { return s.hub.live() }
func (s *Server) hubSession(id string) bool { return s.linkOf(id) != nil }
func (s *Server) hubSID() string            { return s.hub.session() }

// linkEvent is what every hub conversation's events do in atc: its session, whether atc asked, the
// list's refresh and the live transcript.
func (s *Server) linkEvent(l *hubLink, e hub.Event) {
	switch e.Type {
	case "session":
		l.mu.Lock()
		l.sid = e.Text
		if b, err := json.Marshal(map[string]string{"session": e.Text}); err == nil && l.path != "" {
			os.WriteFile(l.path, b, 0o644)
		}
		l.mu.Unlock()
	case "turn":
		l.mu.Lock()
		l.onAtc = e.Channel == "atc"
		l.mu.Unlock()
	case "read", "joined":
		if e.Channel == "atc" {
			l.mu.Lock()
			l.onAtc = true
			l.mu.Unlock()
		}
	case "reset":
		s.M.Store.Update(e.Text, func(m *store.Meta) { m.Name = l.name + " " + time.Now().Format("01-02 15:04") })
	}
	switch e.Type {
	case "turn", "done", "session", "reset", "held":
		s.refresh()
	}
	l.mu.Lock()
	for ch := range l.streams {
		select {
		case ch <- e:
		default:
		}
	}
	l.mu.Unlock()
}

func (s *Server) hubEvent(e hub.Event) {
	switch e.Type {
	case "session":
		go s.hubClaim(e.Text)
	case "ring":
		if s.Push != nil {
			go s.Push.Ring(e.Text)
		}
	}
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
func (s *Server) hubClaim(sid string) {
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

// guestWork is the guests' conversation or a session it started in ~/guests: none of it pushes
// to the user unless it needs them.
func guestWork(x sessions.Session) bool {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, guestsName)
	return x.Agent == guestsName || x.Cwd == dir || strings.HasPrefix(x.Cwd, dir+"/")
}

// guestsClaim names the guests' conversation in atc and dates the one it replaces.
func (s *Server) guestsClaim(sid string) {
	if sid == "" {
		return
	}
	s.M.Store.Update(sid, func(m *store.Meta) { m.Name = guestsName })
	stamp := time.Now().Format("01-02 15:04")
	for _, old := range s.M.Store.Find(func(id string, m store.Meta) bool { return m.Name == guestsName && id != sid }) {
		s.M.Store.Update(old, func(m *store.Meta) { m.Name = guestsName + " " + stamp })
	}
	s.refresh()
}

// hubMark shows the hub's conversations as what they are: ones atc can send to but not attach
// to, working while the hub runs a turn.
func (s *Server) hubMark(ctx context.Context, list []sessions.Session) []sessions.Session {
	for _, l := range []*hubLink{s.hub, s.guests} {
		list = s.markLink(ctx, list, l)
	}
	return list
}

func (s *Server) markLink(ctx context.Context, list []sessions.Session, l *hubLink) []sessions.Session {
	if !l.live() {
		return list
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	st, err := l.c.Status(ctx)
	if err != nil || st.Session == "" {
		return list
	}
	i := slices.IndexFunc(list, func(x sessions.Session) bool { return x.SessionID == st.Session })
	if i < 0 {
		x, ok := s.M.Session(st.Session)
		if !ok {
			x = sessions.Session{SessionID: st.Session, Cwd: st.Dir}
		}
		list, i = append(list, x), len(list)
	}
	x := &list[i]
	x.Kind, x.ID, x.Harness, x.PID, x.Attachable, x.Agent = "hub", st.Session, "hub", st.PID, st.Alive, l.name
	x.Cwd = cmp.Or(x.Cwd, st.Dir)
	m := s.M.Store.Get(st.Session)
	x.Title, x.Pinned, x.Parked = cmp.Or(m.Name, l.name), m.Pinned, m.Parked
	x.Asks, x.TurnDone = nil, false
	if len(st.Owners) > 0 || len(st.Pending) > 0 {
		x.State = sessions.Working
		where := map[string]string{hub.Phone: "on a call", hub.GuestCall: "on a guest's call", waName: "on WhatsApp"}[cmp.Or(st.Route, append(st.Pending, "")[0])]
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
	l := s.linkOf(x.SessionID)
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.onAtc
}

func (s *Server) hubSend(ctx context.Context, channel, text string) error {
	return s.linkSend(ctx, s.hub, channel, text)
}

func (s *Server) linkSend(ctx context.Context, l *hubLink, channel, text string) error {
	st, err := l.c.Send(ctx, channel, text)
	if err == nil && st == "held" {
		log.Printf("hub: %s message to %s held until the call's turn ends", channel, l.name)
	}
	return err
}

// hubStream relays the hub's events as they come, so the transcript shows a reply as it is written.
func (s *Server) hubStream(w http.ResponseWriter, r *http.Request) {
	l := s.linkOf(r.PathValue("sid"))
	if l == nil {
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
	l.mu.Lock()
	l.streams[ch] = r.PathValue("sid")
	l.mu.Unlock()
	defer func() { l.mu.Lock(); delete(l.streams, ch); l.mu.Unlock() }()
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

// call has the call line ring the user, with the hub's session on the line. The caller hears how it went
// with wait; otherwise a call nobody picked up is reported back to the session that asked.
func (s *Server) call(w http.ResponseWriter, r *http.Request) {
	if s.Hub == nil {
		http.Error(w, "atc on "+s.Host+" has no hub (ATC_HUB)", http.StatusNotFound)
		return
	}
	var req struct {
		Reason, From, Session, Via string
		Wait, WhatsApp             bool
		Timeout                    int
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fromHub := req.Session != "" && req.Session == s.hubSID()
	cr := hub.CallReq{Reason: req.Reason, From: req.From, Timeout: req.Timeout, WhatsApp: req.WhatsApp, Via: req.Via, Notify: fromHub && !req.Wait}
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
		note := fmt.Sprintf(modes.Line("call.not_picked_up"), time.Now().Format("15:04"), out)
		if req.Reason != "" {
			note += modes.Line("call.reason") + req.Reason
		}
		if err := s.sendSession(ctx, req.Session, note+"]"); err != nil {
			log.Printf("call: telling %s: %v", req.Session, err)
		}
	}()
	reply(w, map[string]string{"outcome": "dialing"})
}

// sendSession types text into a running session by its session id, whatever runs it.
func (s *Server) sendSession(ctx context.Context, sid, text string) error {
	if l := s.linkOf(sid); l != nil {
		return s.linkSend(ctx, l, hub.Agent, text)
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
