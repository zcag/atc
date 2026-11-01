package server

import (
	"cmp"
	"context"
	"log"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

// parkedIdle is how long a parked session holds its memory before atc stops it; pins.json keeps
// Claude's own idle sweep from ever doing it.
const parkedIdle = 12 * time.Hour

func retirable(x sessions.Session, host string, now time.Time) bool {
	return cmp.Or(x.Host, host) == host && x.Attachable && x.Parked && x.Harness == "" &&
		x.State == sessions.YourTurn && len(x.Background) == 0 && len(x.Servers) == 0 &&
		now.Sub(x.Last()) > parkedIdle
}

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

func (s *Server) retireIdle(list []sessions.Session) {
	for _, x := range list {
		if !retirable(x, s.Host, time.Now()) || s.Term.Viewing(x.ID) {
			continue
		}
		if _, ok := standing(s.M.Store.Get(x.SessionID).Name); ok {
			continue
		}
		s.rv.stopping(x.ID)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := s.M.CLI.Stop(ctx, x.ID)
		cancel()
		if err != nil {
			log.Printf("retire %s: %v", x.ID, err)
			continue
		}
		log.Printf("retired %s (%s): parked and idle for %s", x.ID, x.Title, time.Since(x.Last()).Round(time.Minute))
	}
}
