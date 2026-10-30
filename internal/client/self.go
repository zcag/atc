package client

import (
	"fmt"
	"os"

	"github.com/zcag/atc/internal/sessions"
)

func Self(pool []sessions.Session) (sessions.Session, bool) {
	sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
	for _, s := range pool {
		if sid != "" && s.SessionID == sid {
			return s, true
		}
	}
	return sessions.Session{}, false
}

func Ref(s sessions.Session) string {
	if s.ID != "" {
		return s.ID
	}
	return s.SessionID[:min(8, len(s.SessionID))]
}

func From(pool []sessions.Session, started, report bool) string {
	me, ok := Self(pool)
	verb := "from"
	if started {
		verb = "started by"
	}
	if !ok {
		if os.Getenv("CLAUDE_CODE_SESSION_ID") == "" {
			return ""
		}
		host, _ := os.Hostname()
		ask := "no need to answer"
		if report {
			ask = "put your report in your final message"
		}
		return fmt.Sprintf("[%s a Claude session on %s that atc does not run, so it cannot take messages · %s]", verb, host, ask)
	}
	who := fmt.Sprintf("session %q (%s", me.Title, Ref(me))
	if me.Host != "" {
		who += " on " + me.Host
	}
	who += ")"
	ask := "no need to answer"
	switch {
	case !report && started:
		ask = "handed off to you: no need to report back"
	case report && !me.Attachable:
		ask = "report back in your final message: it is open in a terminal and cannot take messages, it reads yours with wait"
	case report:
		ask = "report back when done with atc's send tool to " + Ref(me)
	}
	return fmt.Sprintf("[%s %s · %s]", verb, who, ask)
}

func Signed(pool []sessions.Session, started, report bool, text string) string {
	if h := From(pool, started, report); h != "" {
		if text == "" {
			return h
		}
		return text + "\n\n" + h
	}
	return text
}
