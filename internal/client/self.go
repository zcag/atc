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

func From(pool []sessions.Session, started bool) string {
	me, ok := Self(pool)
	if !ok {
		if os.Getenv("CLAUDE_CODE_SESSION_ID") == "" {
			return ""
		}
		host, _ := os.Hostname()
		if started {
			return fmt.Sprintf("[started by a Claude session on %s that atc does not run, so it cannot take messages · put your report in your final message]", host)
		}
		return fmt.Sprintf("[from a Claude session on %s that atc does not run, so it cannot take messages · put your answer in your final message]", host)
	}
	who := fmt.Sprintf("session %q (%s", me.Title, Ref(me))
	if me.Host != "" {
		who += " on " + me.Host
	}
	who += ")"
	how := "answer with atc's send tool to " + Ref(me)
	if !me.Attachable {
		how = "it is open in a terminal and cannot take messages; put your answer in your final message, it reads it with wait"
	}
	if started {
		return fmt.Sprintf("[started by %s · when done or blocked, report back: %s]", who, how)
	}
	return fmt.Sprintf("[from %s · %s]", who, how)
}

func Signed(pool []sessions.Session, started bool, text string) string {
	if h := From(pool, started); h != "" {
		if text == "" {
			return h
		}
		return text + "\n\n" + h
	}
	return text
}
