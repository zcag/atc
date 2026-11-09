package history

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Via is who a user turn really came from when the user didn't type it: another session (atc's
// signature line at its end), a webhook ([message from X]) or a channel the hub marked as an aside.
// The text the turn carries is then only the message; Raw is all of it, as the session read it.
type Via struct {
	Title    string   `json:"title,omitempty"`
	Ref      string   `json:"ref,omitempty"`
	Host     string   `json:"host,omitempty"`
	Started  bool     `json:"started,omitempty"`
	Ask      string   `json:"ask,omitempty"`
	AskText  string   `json:"askText,omitempty"`
	Approved bool     `json:"approved,omitempty"`
	Source   string   `json:"source,omitempty"`
	Channel  string   `json:"channel,omitempty"`
	Where    string   `json:"where,omitempty"`
	News     []string `json:"news,omitempty"`
	Raw      string   `json:"raw,omitempty"`
}

var (
	pastedTag = regexp.MustCompile(`</?pasted_content[^>]*>\n?`)
	// talkMode is how the hub tells its session which channel the user's message came from (atc's modes/).
	talkMode = regexp.MustCompile(`(?s)^\[talk-mode: [\w-]+, until the next talk-mode line\]\n.*?\n\[message\]\n`)
	// asideMode is the hub's header on a message that is not the user talking (another session, a guest).
	asideMode  = regexp.MustCompile(`(?s)^\[talk-mode: ([\w-]+), for this message only\]\n(.*?)\[message\]\n`)
	asideWhere = regexp.MustCompile(`(?m)^\[now: (.*)\]$`)
	fromSource = regexp.MustCompile(`^\[message from ([^\]\n]+)\]\n`)
	signature  = regexp.MustCompile(`(?s)\s*\[(from|started by) (?:session ("(?:[^"\\]|\\.)*") \((\S+?)(?: on (\S+))?\)|a Claude session on (\S+) that atc does not run, so it cannot take messages)(?: · (relays the user's own go-ahead)[^·\]]*)? · ([^\]]*)\]\s*$`)
)

// envelope splits what atc and the hub wrapped around a user turn from the message itself.
func envelope(t string) (string, *Via) {
	raw := strings.TrimSpace(t)
	t = strings.TrimSpace(talkMode.ReplaceAllString(pastedTag.ReplaceAllString(t, ""), ""))
	v := &Via{}
	if m := asideMode.FindStringSubmatch(t); m != nil {
		v.Channel = m[1]
		if w := asideWhere.FindStringSubmatch(m[2]); w != nil {
			v.Where = w[1]
		}
		t = strings.TrimSpace(t[len(m[0]):])
	}
	t, v.News = news(t)
	if m := fromSource.FindStringSubmatch(t); m != nil {
		v.Source, t = m[1], strings.TrimSpace(t[len(m[0]):])
	}
	var wrapped struct{ Text string }
	if strings.HasPrefix(t, `{"text":`) && json.Unmarshal([]byte(t), &wrapped) == nil && wrapped.Text != "" {
		t = strings.TrimSpace(wrapped.Text)
	}
	if m := signature.FindStringSubmatchIndex(t); m != nil {
		g := func(i int) string {
			if m[2*i] < 0 {
				return ""
			}
			return t[m[2*i]:m[2*i+1]]
		}
		v.Started = g(1) == "started by"
		if q := g(2); q != "" {
			v.Title, _ = strconv.Unquote(q)
		}
		v.Ref, v.Host = g(3), g(4)+g(5)
		v.Approved = g(6) != ""
		v.AskText = g(7)
		switch {
		case strings.HasPrefix(v.AskText, "handed off"):
			v.Ask = "handoff"
		case strings.Contains(v.AskText, "report"):
			v.Ask = "report"
		}
		t = strings.TrimSpace(t[:m[0]])
	}
	if v.Title == "" && v.Host == "" && v.Source == "" && v.Channel == "" {
		return t, nil
	}
	v.Raw = raw
	return t, v
}

// news takes off what atc tells the session ahead of a message, which nobody wrote: a header line, its lines and
// a blank line. Only what changed since the last turn is kept; the whole state ([atc now]) stays in Raw.
func news(t string) (string, []string) {
	if !strings.HasPrefix(t, "[atc now") && !strings.HasPrefix(t, "[atc since") {
		return t, nil
	}
	head, rest, ok := strings.Cut(t, "\n\n")
	if !ok {
		return t, nil
	}
	if strings.HasPrefix(t, "[atc now") {
		return strings.TrimSpace(rest), nil
	}
	var lines []string
	for _, l := range strings.Split(head, "\n")[1:] {
		if l = strings.TrimSpace(strings.TrimPrefix(l, "- ")); l != "" {
			lines = append(lines, l)
		}
	}
	return strings.TrimSpace(rest), lines
}

func unpaste(t string) string {
	body, _ := envelope(t)
	return body
}
