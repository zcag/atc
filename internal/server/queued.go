package server

import (
	"context"
	"log"
	"time"

	"github.com/zcag/atc/internal/claude"
)

const queuedPoll = 2 * time.Second

func AskingUser(id string) bool {
	b := claude.Asking(id, true)
	return len(b.Questions) > 0 || b.Approve != ""
}

func (s *Server) queue(id, text string) {
	s.queuedMu.Lock()
	defer s.queuedMu.Unlock()
	if s.queued == nil {
		s.queued = map[string][]string{}
	}
	s.queued[id] = append(s.queued[id], text)
	log.Printf("send %s: holding a session's message until the user answers what it asks", id)
	if len(s.queued[id]) == 1 {
		s.spawn(func(ctx context.Context) { s.deliverQueued(ctx, id) })
	}
}

func (s *Server) deliverQueued(ctx context.Context, id string) {
	for s.asking(id) {
		select {
		case <-ctx.Done():
			return
		case <-time.After(queuedPoll):
		}
	}
	for {
		s.queuedMu.Lock()
		q := s.queued[id]
		if len(q) == 0 {
			delete(s.queued, id)
			s.queuedMu.Unlock()
			return
		}
		s.queued[id] = q[1:]
		s.queuedMu.Unlock()
		if err := s.Term.Send(ctx, id, q[0]); err != nil {
			log.Printf("send %s: queued message: %v", id, err)
		}
	}
}
