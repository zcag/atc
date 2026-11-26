package server

import (
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
)

const answeredFor = time.Hour

type answers struct {
	mu sync.Mutex
	m  map[string]sessions.Answered
}

func (a *answers) mark(sid string, x sessions.Answered) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.m == nil {
		a.m = map[string]sessions.Answered{}
	}
	for k, v := range a.m {
		if time.Since(v.At) > answeredFor {
			delete(a.m, k)
		}
	}
	a.m[sid] = x
}

func (a *answers) attach(list []sessions.Session) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := range list {
		x, ok := a.m[list[i].SessionID]
		if !ok {
			x, ok = a.m[list[i].ID]
		}
		if ok && time.Since(x.At) < answeredFor {
			list[i].Answered = &x
		}
	}
}

func answerWhat(a opencode.Answer) string {
	switch {
	case a.Reject:
		return "Deny"
	case a.Reply == "always":
		return "Always allow"
	case a.Reply != "":
		return "Allow once"
	}
	var picked []string
	for _, x := range a.Answers {
		picked = append(picked, strings.Join(x, ", "))
	}
	return strings.Join(picked, "; ")
}

// pushAsk is the session's first ask as push and the widget carry it. Options come only for a
// single question; anything else is answered in atc.
func pushAsk(x sessions.Session) *push.Ask {
	if len(x.Asks) == 0 {
		return nil
	}
	a := x.Asks[0]
	out := &push.Ask{SID: x.SessionID, ID: a.ID, Key: a.Fingerprint(), Host: x.Host}
	if a.Permission != "" {
		out.Tool, out.Cmd = a.Permission, strings.Join(a.Patterns, " ")
		return out
	}
	if len(a.Questions) == 0 {
		return nil
	}
	q := a.Questions[0]
	out.Text = q.Question
	if len(a.Questions) > 1 {
		return out
	}
	for _, o := range q.Options {
		out.Options = append(out.Options, o.Label)
	}
	return out
}

func askBody(a *push.Ask) string {
	if a.Tool != "" {
		return opencode.Wants(a.Tool, a.Cmd)
	}
	return a.Text
}
