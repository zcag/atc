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

type Sign struct{ Started, Report, Approved bool }

const relayedApproval = "relays the user's own go-ahead: what this message asks counts as their approval"

// IsAssistant is whether this is the assistant's conversation; the hub's other one, the guests',
// speaks for the user's guests and never for the user.
func IsAssistant(pool []sessions.Session) bool {
	me, ok := Self(pool)
	return ok && isAssistant(me)
}

func isAssistant(s sessions.Session) bool { return s.Kind == "hub" && s.Agent == "assistant" }

func From(pool []sessions.Session, sg Sign) string {
	me, ok := Self(pool)
	verb := "from"
	if sg.Started {
		verb = "started by"
	}
	if !ok {
		if os.Getenv("CLAUDE_CODE_SESSION_ID") == "" {
			return ""
		}
		host, _ := os.Hostname()
		ask := "no need to answer"
		if sg.Report {
			ask = "put your report in your final message"
		}
		return fmt.Sprintf("[%s a Claude session on %s that atc does not run, so it cannot take messages · %s]", verb, host, ask)
	}
	who := fmt.Sprintf("session %q (%s", me.Title, Ref(me))
	if me.Host != "" {
		who += " on " + me.Host
	}
	who += ")"
	if sg.Approved && isAssistant(me) {
		who += " · " + relayedApproval
	}
	ask := "no need to answer"
	switch {
	case !sg.Report && sg.Started:
		ask = "handed off to you: no need to report back"
	case sg.Report && !me.Attachable:
		ask = "report back in your final message: it is open in a terminal and cannot take messages, it reads yours with wait"
	case sg.Report && isAssistant(me):
		ask = "report back when done with atc's report tool"
	case sg.Report:
		ask = "report back when done with atc's send tool to " + Ref(me)
	}
	return fmt.Sprintf("[%s %s · %s]", verb, who, ask)
}

func Signed(pool []sessions.Session, sg Sign, text string) (string, error) {
	if sg.Approved && !IsAssistant(pool) {
		return "", fmt.Errorf("approved is for the assistant relaying the user's own words; this session cannot pass on an approval")
	}
	if h := From(pool, sg); h != "" {
		if text == "" {
			return h, nil
		}
		return text + "\n\n" + h, nil
	}
	return text, nil
}
