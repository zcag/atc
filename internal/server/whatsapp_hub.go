package server

import (
	"cmp"
	"context"
	"log"
	"slices"
	"time"

	"github.com/zcag/atc/internal/hub"
)

// waHubTurn is what the whatsapp channel waits on from the hub: the messages typed in and how
// many the session has read, the reply held back until the turn's end, and the status line.
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

// waHubType hands a WhatsApp message to the hub; its answer comes back through waHubLoop.
func (s *Server) waHubType(ctx context.Context, msg waMsg, text, voice string) error {
	if _, err := s.Hub.Send(ctx, waName, text); err != nil {
		return err
	}
	s.wa.mu.Lock()
	t := s.waHubBegin()
	if msg.id != "" {
		t.asks = append(t.asks, msg)
	}
	t.voice, t.typed = cmp.Or(voice, t.voice), t.typed+1
	s.wa.mu.Unlock()
	return nil
}

// waHubBegin returns the turn being followed, or starts one. The caller holds s.wa.mu.
func (s *Server) waHubBegin() *waHubTurn {
	now := time.Now()
	if s.wa.hub == nil {
		s.wa.hub = &waHubTurn{since: now, lastOut: now}
	}
	s.wa.hub.busy, s.wa.hub.heardAt = true, now
	return s.wa.hub
}

// waHubLoop sends what the hub's session writes on the whatsapp channel: each text block once it
// is whole (a long one held back until it is clear whether it is the final answer), the typing
// indicator and a status line while it works quietly, and the ticks once everything typed in has
// been answered. A turn nobody started from WhatsApp (a session reporting back) comes the same way.
func (s *Server) waHubLoop() {
	ctx := context.Background()
	tick := time.NewTicker(waTick)
	defer tick.Stop()
	for {
		select {
		case e := <-s.hub.wa:
			s.waHubEvent(ctx, e)
		case <-tick.C:
			s.waHubTick(ctx)
		}
	}
}

func (s *Server) waHubEvent(ctx context.Context, e hub.Event) {
	s.wa.mu.Lock()
	t := s.wa.hub
	switch e.Type {
	case "turn", "read", "joined", "held", "tool", "text", "block":
		t = s.waHubBegin()
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
		s.waHubRelease(ctx, t, false)
		if len(e.Text) > waLong {
			t.held = e.Text
		} else {
			s.waReply(ctx, e.Text)
		}
		t.last, t.lastOut = e.Text, time.Now()
	case "error":
		s.waHubRelease(ctx, t, false)
		s.waText(ctx, "⚠️ "+e.Error)
		s.waHubFinish(ctx, t, true)
	case "done":
		s.waHubRelease(ctx, t, true)
		s.wa.mu.Lock()
		waiting := t.read < t.typed
		s.wa.mu.Unlock()
		if waiting {
			return
		}
		s.waHubFinish(ctx, t, e.Interrupted)
	}
}

func (s *Server) waHubRelease(ctx context.Context, t *waHubTurn, final bool) {
	if t.held == "" {
		return
	}
	if final {
		s.waFinal(ctx, s.hubSID(), t.held)
	} else {
		s.waReply(ctx, t.held)
	}
	t.held = ""
}

func (s *Server) waHubFinish(ctx context.Context, t *waHubTurn, interrupted bool) {
	s.wa.mu.Lock()
	if s.wa.hub == t {
		s.wa.hub = nil
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
func (s *Server) waHubOrphan(ctx context.Context, t *waHubTurn) bool {
	if time.Since(t.heardAt) < waOrphan || time.Since(t.checkedAt) < waOrphan/2 {
		return false
	}
	t.checkedAt = time.Now()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	st, err := s.Hub.Status(ctx)
	if err != nil || !st.Alive || slices.Contains(st.Owners, waName) || slices.Contains(st.Pending, waName) || slices.Contains(st.Held, waName) {
		return false
	}
	s.wa.mu.Lock()
	if s.wa.hub != t || time.Since(t.heardAt) < waOrphan {
		s.wa.mu.Unlock()
		return false
	}
	t.lost = t.read < t.typed
	s.wa.mu.Unlock()
	log.Printf("whatsapp: the hub has no whatsapp turn any more (read %d of %d), ending it", t.read, t.typed)
	if t.lost {
		s.waText(ctx, "⚠️ The assistant restarted before reading your last message, so it is lost. Send it again.")
	}
	s.waHubFinish(ctx, t, true)
	return true
}

func (s *Server) waHubTick(ctx context.Context) {
	s.wa.mu.Lock()
	t := s.wa.hub
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
	if s.waHubOrphan(ctx, t) {
		return
	}
	tr, _ := s.M.Index.Find(s.hubSID())
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
