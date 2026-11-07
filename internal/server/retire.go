package server

import (
	"cmp"
	"context"
	"log"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

// closeRetiredHub stops and takes off the list any earlier assistant conversation that is running:
// a message or a revive can bring one back, and it would sit as the user's turn for hours.
func (s *Server) closeRetiredHub(list []sessions.Session) {
	for _, x := range list {
		if !x.Retired || !x.Attachable || cmp.Or(x.Host, s.Host) != s.Host || x.State == sessions.Working {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		log.Printf("closing %s (%s), an earlier assistant conversation", x.ID, x.Title)
		if err := s.shelve(ctx, x); err != nil {
			log.Printf("close %s: %v", x.ID, err)
		}
		cancel()
	}
}
