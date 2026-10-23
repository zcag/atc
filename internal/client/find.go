package client

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/zcag/atc/internal/sessions"
)

func (c *Client) Find(q string, withPast bool) (sessions.Session, error) {
	pool, err := c.Live()
	if err != nil {
		return sessions.Session{}, err
	}
	if withPast {
		past, err := c.History("", "", 0)
		if err != nil {
			return sessions.Session{}, err
		}
		pool = append(pool, past...)
	}
	return Resolve(q, pool)
}

func Resolve(q string, pool []sessions.Session) (sessions.Session, error) {
	if n, err := strconv.Atoi(q); err == nil && n >= 1 && n <= len(pool) && len(q) < 4 {
		return pool[n-1], nil
	}
	var hits []sessions.Session
	seen := map[string]bool{}
	for _, pass := range []func(sessions.Session) bool{
		func(s sessions.Session) bool { return s.ID == q || s.SessionID == q },
		func(s sessions.Session) bool { return strings.HasPrefix(s.SessionID, q) },
		func(s sessions.Session) bool { return strings.EqualFold(s.Title, q) },
		func(s sessions.Session) bool { return strings.Contains(strings.ToLower(s.Title), strings.ToLower(q)) },
	} {
		for _, s := range pool {
			if pass(s) && !seen[s.SessionID] {
				seen[s.SessionID] = true
				hits = append(hits, s)
			}
		}
		if len(hits) > 0 {
			break
		}
	}
	switch len(hits) {
	case 0:
		return sessions.Session{}, fmt.Errorf("no session matches %q", q)
	case 1:
		return hits[0], nil
	}
	msg := fmt.Sprintf("%q matches %d sessions:", q, len(hits))
	for _, h := range hits[:min(len(hits), 8)] {
		msg += "\n  " + h.SessionID[:8] + "  " + h.Title
	}
	return sessions.Session{}, fmt.Errorf("%s", msg)
}
