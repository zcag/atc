package server

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/whatsapp"
)

const (
	waTick    = 1500 * time.Millisecond
	waWatchAt = 3 * time.Second
	waTyping  = 20 * time.Second
	waQuiet   = 45 * time.Second
	waSettle  = 30 * time.Second
	waLongest = 6 * time.Hour
	waLong    = 1800
	waDoc     = 9000
	waSkew    = 5 * time.Second
)

// transcriptOf is the session's own transcript file. The index can answer a session forked on
// resume with its parent's file until it has seen the new one, so a path that is not named
// after the session is not taken.
func (s *Server) transcriptOf(sid string) string {
	if tr, ok := s.M.Index.Find(sid); ok && filepath.Base(tr.Path) == sid+".jsonl" {
		return tr.Path
	}
	matches, _ := filepath.Glob(filepath.Join(claude.ConfigDir(), "projects", "*", sid+".jsonl"))
	if len(matches) > 0 {
		return matches[0]
	}
	return ""
}

// waTurn is one stretch of the session's transcript being relayed: from where the last one
// stopped until the session has answered everything typed into it.
type waTurn struct {
	sid, path string
	off       int64
	since     time.Time
	asks      []waMsg
	typed     int
	typedAt   time.Time
	voice     string
}

// waType types a message into the whatsapp session and makes sure its answer is relayed;
// messages sent while it works join the turn already being relayed. A msg without an id
// (a reaction) gets no ⏳/✅ of its own.
func (s *Server) waType(ctx context.Context, msg waMsg, text, voice string) error {
	if text == "" {
		return nil
	}
	id, err := s.keep(ctx, waName, false)
	if err != nil {
		return fmt.Errorf("could not open the whatsapp session: %w", err)
	}
	x, err := s.waReady(ctx, id)
	if err != nil {
		return err
	}
	s.wa.mu.Lock()
	t := s.waBegin(x.SessionID)
	if msg.id != "" {
		t.asks = append(t.asks, msg)
	}
	t.voice, t.typedAt, t.typed = cmp.Or(voice, t.voice), time.Now(), t.typed+1
	s.wa.mu.Unlock()
	return s.Term.Send(ctx, id, text)
}

// waBegin returns the turn being relayed, or starts one from where relaying last stopped.
// The caller holds s.wa.mu.
func (s *Server) waBegin(sid string) *waTurn {
	if t := s.wa.turn; t != nil && t.sid == sid {
		return t
	}
	t := &waTurn{sid: sid, since: time.Now()}
	if t.path = s.transcriptOf(sid); t.path != "" {
		if st, err := os.Stat(t.path); err == nil {
			t.off = st.Size()
			if m := s.wa.mark; m.SID == sid && m.Off <= t.off {
				t.off = m.Off
			}
		}
	}
	s.wa.turn = t
	go s.waPump(t)
	return t
}

// waWatch relays turns nobody started from WhatsApp: a session it handed work to reporting
// back, or the user typing into the conversation in atc.
func (s *Server) waWatch() {
	for range time.Tick(waWatchAt) {
		s.wa.mu.Lock()
		m, busy := s.wa.mark, s.wa.turn != nil
		s.wa.mu.Unlock()
		if busy || m.SID == "" {
			continue
		}
		path := s.transcriptOf(m.SID)
		if path == "" {
			continue
		}
		if st, err := os.Stat(path); err != nil || st.Size() <= m.Off {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		x, found := s.waSession(ctx, m.SID)
		cancel()
		if !found || x.State != sessions.Working {
			continue
		}
		s.wa.mu.Lock()
		if s.wa.turn == nil {
			s.waBegin(m.SID)
		}
		s.wa.mu.Unlock()
	}
}

func (s *Server) waReady(ctx context.Context, id string) (sessions.Session, error) {
	for range 40 {
		if x, ok := s.waSession(ctx, id); ok && x.Attachable && x.SessionID != "" {
			return x, nil
		}
		time.Sleep(1500 * time.Millisecond)
	}
	return sessions.Session{}, errors.New("the whatsapp session did not come up")
}

func (s *Server) waSession(ctx context.Context, key string) (sessions.Session, bool) {
	list, err := s.M.Live(ctx)
	if err != nil {
		return sessions.Session{}, false
	}
	for _, x := range list {
		if x.ID == key || x.SessionID == key {
			return x, true
		}
	}
	return sessions.Session{}, false
}

// waPump follows a turn: it sends each reply text as it lands in the transcript (holding a
// long one back until it is clear whether it is the turn's final answer), keeps the typing
// indicator up, shows a status line edited in place while the turn runs quiet, and ticks the
// user's messages once everything typed in has been answered.
func (s *Server) waPump(t *waTurn) {
	ctx := context.Background()
	wa := s.WhatsApp
	began := time.Now()
	var typingAt, statusAt, lastOut, doneAt, idleSince, askedAt time.Time
	seen := 0
	var status, shown, last, held string
	lastOut = began
	release := func(final bool) {
		if held == "" {
			return
		}
		if final {
			s.waFinal(ctx, t.sid, held)
		} else {
			s.waReply(ctx, held)
		}
		held = ""
	}
	for {
		time.Sleep(waTick)
		x, ok := s.waSession(ctx, t.sid)
		if path := s.transcriptOf(t.sid); path != "" && path != t.path {
			if st, err := os.Stat(path); t.path != "" || err != nil || st.Size() < t.off {
				t.off = 0
			}
			t.path = path
		}
		if t.path != "" {
			if p, err := history.ReadRange(t.path, t.off, 0); err == nil {
				t.off = p.End
				for _, m := range p.Messages {
					switch {
					case !m.Time.IsZero() && m.Time.Before(t.since.Add(-waSkew)):
					case m.Role == "assistant" && strings.TrimSpace(m.Text) != "":
						release(false)
						if len(m.Text) > waLong {
							held = m.Text
						} else {
							s.waReply(ctx, m.Text)
						}
						last, lastOut = m.Text, time.Now()
					case m.Role == "user":
						release(false)
						seen, askedAt = seen+1, cmp.Or(m.Time, time.Now())
					case m.Role == "done":
						release(true)
						doneAt = cmp.Or(m.Time, time.Now())
					}
				}
			}
		}
		working := ok && x.State == sessions.Working
		if working {
			idleSince = time.Time{}
			if time.Since(typingAt) > waTyping {
				wa.Typing(ctx, "typing")
				typingAt = time.Now()
			}
			if act := clipRunes(oneLine(x.Activity), 120); act != "" && time.Since(lastOut) > waQuiet {
				line := "⏳ " + act
				switch {
				case status == "":
					status, _ = s.waText(ctx, line)
					shown, statusAt = act, time.Now()
				case act != shown && time.Since(statusAt) > 15*time.Second:
					wa.Edit(ctx, status, line)
					shown, statusAt = act, time.Now()
				}
			}
		} else if idleSince.IsZero() {
			idleSince = time.Now()
		}
		s.wa.mu.Lock()
		needs := ok && x.State == sessions.NeedsYou
		finished := needs || !working && seen >= t.typed && doneAt.After(askedAt) && !doneAt.IsZero() ||
			!working && time.Since(idleSince) > waSettle && time.Since(t.typedAt) > waSettle ||
			time.Since(t.typedAt) > waLongest && time.Since(began) > waLongest
		if !finished {
			s.wa.mu.Unlock()
			continue
		}
		asks, voice := t.asks, t.voice
		s.wa.turn = nil
		s.wa.mu.Unlock()
		s.wa.setMark(waMark{SID: t.sid, Off: t.off})

		release(true)
		if typingAt != (time.Time{}) {
			wa.Typing(ctx, "paused")
		}
		mark := "✅"
		if needs {
			mark = "❓"
			s.waText(ctx, "⚠️ The session is waiting on something only atc can answer: "+clipRunes(oneLine(x.Activity), 300)+"\nOpen it in atc.")
		}
		if status != "" {
			wa.Edit(ctx, status, "✓ worked "+time.Since(began).Round(time.Second).String())
		}
		if voice != "" && last != "" {
			if err := s.waVoice(ctx, last, voice, true); err != nil {
				log.Printf("whatsapp: voice reply: %v", err)
			}
		}
		for _, a := range asks {
			wa.React(ctx, a.chat, a.id, mark)
		}
		return
	}
}

// waFinal sends a long final answer with its gist first, so the notification says the outcome,
// and as a document when it would take more than a couple of screens.
func (s *Server) waFinal(ctx context.Context, sid, text string) {
	if g := s.waGist(ctx, sid, text); g != "" {
		s.waText(ctx, g)
	}
	if len(text) <= waDoc {
		s.waReply(ctx, text)
		return
	}
	s.waFile(ctx, []byte(text), "text/markdown", "reply.md", "The full reply")
}

func (s *Server) waGist(ctx context.Context, sid, text string) string {
	tr, ok := s.M.Index.Find(sid)
	head := strings.TrimSuffix(tr.LastReply, "…")
	if !ok || s.M.Summary == nil || head == "" || !strings.HasPrefix(oneLine(text), head[:min(80, len(head))]) {
		return ""
	}
	s.M.Summary.Want(tr)
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	sum := s.M.Summary.Wait(ctx, tr)
	if sum == nil || sum.Status == "" {
		return ""
	}
	g := "📌 *" + whatsapp.Plain(sum.Status) + "*"
	for _, l := range sum.Gist {
		g += "\n- " + whatsapp.Plain(l)
	}
	return g
}

func (s *Server) waNew(ctx context.Context, msg waMsg) error {
	list, err := s.M.Live(ctx)
	if err != nil {
		return err
	}
	for _, x := range list {
		if x.Kind == "background" && cmp.Or(s.M.Store.Get(x.SessionID).Name, x.Name) == waName {
			s.M.Store.Update(x.SessionID, func(m *store.Meta) { m.Name = waName + " " + x.Last().Format("01-02 15:04") })
			if x.Attachable {
				s.M.CLI.Stop(ctx, x.ID)
			}
		}
	}
	s.wa.mu.Lock()
	s.wa.turn = nil
	s.wa.mu.Unlock()
	id, err := s.keep(ctx, waName, true)
	if err != nil {
		return err
	}
	x, err := s.waReady(ctx, id)
	if err != nil {
		return err
	}
	s.wa.setMark(waMark{SID: x.SessionID})
	s.refresh()
	s.WhatsApp.React(ctx, msg.chat, msg.id, "🆕")
	_, err = s.waText(ctx, "🆕 Fresh conversation. The last one stays in atc, named _"+waName+" "+time.Now().Format("01-02")+"…_")
	return err
}

func (s *Server) waStop(ctx context.Context, msg waMsg) error {
	s.wa.mu.Lock()
	t := s.wa.turn
	s.wa.mu.Unlock()
	if t == nil {
		return s.WhatsApp.React(ctx, msg.chat, msg.id, "🤷")
	}
	x, ok := s.waSession(ctx, t.sid)
	if !ok || x.ID == "" {
		return errors.New("the whatsapp session is not running")
	}
	if err := s.Term.Keys(ctx, x.ID, "\x1b"); err != nil {
		return err
	}
	return s.WhatsApp.React(ctx, msg.chat, msg.id, "🛑")
}
