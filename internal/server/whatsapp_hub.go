package server

import (
	"cmp"
	"context"
	"log"
	"slices"
	"time"

	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/whatsapp"
)

// waRoute is one conversation the hub runs that talks on WhatsApp, and the chat it talks in: the assistant in
// the owner's DM (chat ""), or an agent's line in that agent's own group. Each has its own turn.
type waRoute struct {
	link *hubLink
	chat string
	turn *waHubTurn
}

// to is ctx sending into the route's chat.
func (r *waRoute) to(ctx context.Context) context.Context {
	if r.chat == "" {
		return ctx
	}
	return whatsapp.To(ctx, r.chat)
}

// waHubTurn is what a route waits on from the hub: the messages typed in and how many the session has read, the
// reply held back until the turn's end, and the status line.
type waHubTurn struct {
	asks        []waMsg
	typed, read int
	voice       string
	busy        bool
	since       time.Time
	held, last  string
	status      string
	shown       string
	statusAt    time.Time
	lastOut     time.Time
	typingAt    time.Time
	heardAt     time.Time
	checkedAt   time.Time
	lost        bool
}

// waOrphan is how long a turn goes without a whatsapp event from the hub before atc asks the hub
// whether whatsapp is still part of anything: a hub restart or a dropped event otherwise leaves the
// turn open, typing every 20 s for as long as atc runs.
var waOrphan = time.Minute

// waHubType hands a WhatsApp message to the route's conversation; its answer comes back through waHubLoop.
func (s *Server) waHubType(ctx context.Context, r *waRoute, msg waMsg, text, voice string) error {
	if _, err := r.link.c.Send(ctx, waName, text); err != nil {
		return err
	}
	s.wa.mu.Lock()
	t := s.waHubBegin(r)
	if msg.id != "" {
		t.asks = append(t.asks, msg)
	}
	t.voice, t.typed = cmp.Or(voice, t.voice), t.typed+1
	s.wa.mu.Unlock()
	return nil
}

// waHubBegin returns the turn being followed, or starts one. The caller holds s.wa.mu.
func (s *Server) waHubBegin(r *waRoute) *waHubTurn {
	now := time.Now()
	if r.turn == nil {
		r.turn = &waHubTurn{since: now, lastOut: now}
	}
	r.turn.busy, r.turn.heardAt = true, now
	return r.turn
}

// waHubLoop sends what the route's conversation writes on the whatsapp channel: each text block once it is
// whole (a long one held back until it is clear whether it is the final answer), the typing indicator and a
// status line while it works quietly, and the ticks once everything typed in has been answered. A turn nobody
// started from WhatsApp (a session reporting back) comes the same way. It ends with the route's link.
func (s *Server) waHubLoop(r *waRoute) {
	tick := time.NewTicker(waTick)
	defer tick.Stop()
	for {
		select {
		case <-r.link.ctx.Done():
			return
		case e := <-r.link.wa:
			s.waHubEvent(r.to(context.Background()), r, e)
		case <-tick.C:
			s.waHubTick(r.to(context.Background()), r)
		}
	}
}

func (s *Server) waHubEvent(ctx context.Context, r *waRoute, e hub.Event) {
	s.wa.mu.Lock()
	t := r.turn
	switch e.Type {
	case "turn", "read", "joined", "held", "tool", "text", "block":
		t = s.waHubBegin(r)
	}
	if t != nil {
		t.heardAt = time.Now()
	}
	s.wa.mu.Unlock()
	if t == nil {
		return
	}
	switch e.Type {
	case "read":
		s.wa.mu.Lock()
		t.read++
		s.wa.mu.Unlock()
	case "block":
		s.waHubRelease(ctx, r, t, false)
		if len(e.Text) > waLong {
			t.held = e.Text
		} else {
			s.waReply(ctx, e.Text)
		}
		t.last, t.lastOut = e.Text, time.Now()
	case "error":
		s.waHubRelease(ctx, r, t, false)
		s.waText(ctx, "⚠️ "+e.Error)
		s.waHubFinish(ctx, r, t, true)
	case "done":
		s.waHubRelease(ctx, r, t, true)
		s.wa.mu.Lock()
		waiting := t.read < t.typed
		s.wa.mu.Unlock()
		if waiting {
			return
		}
		s.waHubFinish(ctx, r, t, e.Interrupted)
	}
}

func (s *Server) waHubRelease(ctx context.Context, r *waRoute, t *waHubTurn, final bool) {
	if t.held == "" {
		return
	}
	if final {
		s.waFinal(ctx, r.link.session(), t.held)
	} else {
		s.waReply(ctx, t.held)
	}
	t.held = ""
}

func (s *Server) waHubFinish(ctx context.Context, r *waRoute, t *waHubTurn, interrupted bool) {
	s.wa.mu.Lock()
	if r.turn == t {
		r.turn = nil
	}
	asks, voice := t.asks, t.voice
	s.wa.mu.Unlock()
	wa := s.WhatsApp
	if !t.typingAt.IsZero() {
		wa.Typing(ctx, "paused")
	}
	if t.status != "" {
		wa.Edit(ctx, t.status, "✓ worked "+time.Since(t.since).Round(time.Second).String())
	}
	if voice != "" && t.last != "" && !interrupted {
		if err := s.waVoice(ctx, t.last, voice, true); err != nil {
			log.Printf("whatsapp: voice reply: %v", err)
		}
	}
	mark := "✅"
	if t.lost {
		mark = "⚠️"
	}
	for _, a := range asks {
		wa.React(ctx, a.chat, a.id, mark)
	}
}

// waHubOrphan ends a turn the hub no longer has: whatsapp is not in its running turn, not waiting
// to be read and not held. What was typed and never read is lost, and the user is told to send it again.
func (s *Server) waHubOrphan(ctx context.Context, r *waRoute, t *waHubTurn) bool {
	if time.Since(t.heardAt) < waOrphan || time.Since(t.checkedAt) < waOrphan/2 {
		return false
	}
	t.checkedAt = time.Now()
	sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	st, err := r.link.c.Status(sctx)
	if r.link.ctx.Err() == nil && (err != nil || !st.Alive || slices.Contains(st.Owners, waName) || slices.Contains(st.Pending, waName) || slices.Contains(st.Held, waName)) {
		return false
	}
	s.wa.mu.Lock()
	if r.turn != t || time.Since(t.heardAt) < waOrphan {
		s.wa.mu.Unlock()
		return false
	}
	t.lost = t.read < t.typed
	s.wa.mu.Unlock()
	log.Printf("whatsapp: %s has no whatsapp turn any more (read %d of %d), ending it", r.link.name, t.read, t.typed)
	if t.lost {
		s.waText(ctx, "⚠️ The conversation restarted before reading your last message, so it is lost. Send it again.")
	}
	s.waHubFinish(ctx, r, t, true)
	return true
}

func (s *Server) waHubTick(ctx context.Context, r *waRoute) {
	s.wa.mu.Lock()
	t := r.turn
	busy := t != nil && t.busy
	s.wa.mu.Unlock()
	if !busy {
		return
	}
	wa := s.WhatsApp
	if time.Since(t.typingAt) > waTyping {
		wa.Typing(ctx, "typing")
		t.typingAt = time.Now()
	}
	if s.waHubOrphan(ctx, r, t) {
		return
	}
	tr, _ := s.M.Index.Find(r.link.session())
	act := clipRunes(oneLine(tr.Activity), 120)
	if act == "" || time.Since(t.lastOut) < waQuiet {
		return
	}
	line := "⏳ " + act
	switch {
	case t.status == "":
		t.status, _ = s.waText(ctx, line)
		t.shown, t.statusAt = act, time.Now()
	case act != t.shown && time.Since(t.statusAt) > 15*time.Second:
		wa.Edit(ctx, t.status, line)
		t.shown, t.statusAt = act, time.Now()
	}
}
