package client

import (
	"context"
	"fmt"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

type Launch struct {
	Host, Dir, Name, Preset, Prompt string
	Worktree, Report                bool
}

func (c *Client) Launch(ctx context.Context, l Launch) (id, dir string, err error) {
	live, _ := c.Live()
	prompt := Signed(live, true, l.Report, l.Prompt)
	if l.Preset != "" {
		id, dir, err = c.StartPreset(l.Preset, prompt)
	} else {
		dir = l.Dir
		id, err = c.StartOn(l.Host, l.Dir, l.Name, prompt, l.Worktree)
	}
	if err != nil || !l.Report {
		return id, dir, err
	}
	if me, ok := Self(live); ok {
		var child sessions.Session
		if c.Until(ctx, id, 20*time.Second, func(s sessions.Session) bool { child = s; return s.SessionID != "" }) == nil {
			c.Patch(child.Lineage(), map[string]any{"reportsTo": me.Lineage()})
		}
	}
	return id, dir, nil
}

func (c *Client) Deliver(ctx context.Context, x sessions.Session, text string, report, wake bool) (id string, resumed bool, err error) {
	live, _ := c.Live()
	me, isSession := Self(live)
	switch {
	case isSession && me.SessionID == x.SessionID:
		return "", false, fmt.Errorf("that is this session itself")
	case x.Kind == "interactive" && x.PID > 0:
		return "", false, fmt.Errorf("%q is open in a terminal, so it cannot take messages from here; the user has to type into it there", x.Title)
	case !x.Attachable && isSession && !wake && me.ReportsTo != x.Lineage():
		return "", false, fmt.Errorf("%q is stopped and is not waiting on a report from you, so it stays stopped; leave the outcome in your final message, or pass wake if the user asked for this message", x.Title)
	}
	id = x.ID
	if !x.Attachable {
		if id, err = c.Resume(x.SessionID); err != nil {
			return "", false, fmt.Errorf("resume %q: %w", x.Title, err)
		}
		if err = c.Until(ctx, id, 30*time.Second, func(s sessions.Session) bool { return s.Attachable }); err != nil {
			return "", false, err
		}
		resumed = true
	}
	if err = c.Send(id, Signed(live, false, report, text)); err != nil {
		return "", resumed, err
	}
	if report && isSession {
		c.Patch(x.Lineage(), map[string]any{"reportsTo": me.Lineage()})
	}
	return id, resumed, nil
}

func (c *Client) Until(ctx context.Context, key string, limit time.Duration, ok func(sessions.Session) bool) error {
	end := time.Now().Add(limit)
	for {
		live, err := c.Live()
		if err == nil {
			for _, s := range live {
				if (s.ID == key || s.SessionID == key) && ok(s) {
					return nil
				}
			}
		}
		if time.Now().After(end) {
			return fmt.Errorf("gave up after %s", limit)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}
