package client

import (
	"context"
	"fmt"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

// HubAgent is the assistant's name as an agent: its live conversation, whichever that is now.
const HubAgent = "assistant"

type Launch struct {
	Host, Dir, Name, Preset, Prompt, Profile string
	Worktree, Report, Approved               bool
}

func (c *Client) Launch(ctx context.Context, l Launch) (id, dir string, err error) {
	live, _ := c.Live()
	prompt, err := Signed(live, Sign{Started: true, Report: l.Report, Approved: l.Approved}, l.Prompt)
	if err != nil {
		return "", "", err
	}
	if l.Preset != "" {
		id, dir, err = c.StartPreset(l.Preset, prompt)
	} else {
		dir = l.Dir
		id, err = c.Begin(l.Host, map[string]any{"dir": l.Dir, "name": l.Name, "prompt": prompt, "worktree": l.Worktree, "profile": l.Profile})
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

type Delivered struct {
	ID            string
	Resumed, Held bool
}

func (c *Client) Deliver(ctx context.Context, x sessions.Session, text string, report, wake, approved bool) (d Delivered, err error) {
	live, _ := c.Live()
	me, isSession := Self(live)
	if x.Retired {
		signed, err := Signed(live, Sign{Report: report, Approved: approved}, text)
		if err != nil {
			return d, err
		}
		d.ID, err = c.Message(HubAgent, signed)
		return d, err
	}
	switch {
	case isSession && me.SessionID == x.SessionID:
		return d, fmt.Errorf("that is this session itself")
	case x.Kind == "interactive" && x.PID > 0:
		return d, fmt.Errorf("%q is open in a terminal, so it cannot take messages from here; the user has to type into it there", x.Title)
	case !x.Attachable && isSession && !wake && me.ReportsTo != x.Lineage():
		return d, fmt.Errorf("%q is stopped and is not waiting on a report from you, so it stays stopped; leave the outcome in your final message, or pass wake if the user asked for this message", x.Title)
	}
	signed, err := Signed(live, Sign{Report: report, Approved: approved}, text)
	if err != nil {
		return d, err
	}
	d.ID = x.ID
	if !x.Attachable {
		if d.ID, err = c.Resume(x.SessionID); err != nil {
			return d, fmt.Errorf("resume %q: %w", x.Title, err)
		}
		if err = c.Until(ctx, d.ID, 30*time.Second, func(s sessions.Session) bool { return s.Attachable }); err != nil {
			return d, err
		}
		d.Resumed = true
	}
	if d.Held, err = c.Send(d.ID, signed); err != nil {
		return d, err
	}
	if report && isSession {
		c.Patch(x.Lineage(), map[string]any{"reportsTo": me.Lineage()})
	}
	return d, nil
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
