package history

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
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
	talkMode = regexp.MustCompile(`(?s)^\[talk-mode: ([\w-]+), until the next talk-mode line\]\n.*?\n\[message\]\n`)
	pasted   = regexp.MustCompile(`(?s)<pasted_content[^>]*>\n?(.*?)</pasted_content[^>]*>`)
	// unsaid is the hub reminding the assistant, ahead of the user's words on a call, that a report came in meanwhile.
	unsaid = regexp.MustCompile(`^\[hub: a report or a guest's message came in while you were on the call[^\]\n]*\]\n`)
	// lineEvent is the call line telling the session what happened on it ("[phone event] ..."): a call ending starts
	// with its bracketed words, anything else is a note in parentheses.
	lineEvent = regexp.MustCompile(`(?s)^\[([\w-]+) event\] (.*)$`)
	// asideMode is the hub's header on a message that is not the user talking (another session, a guest).
	asideMode  = regexp.MustCompile(`(?s)^\[talk-mode: ([\w-]+), for this message only\]\n(.*?)\[message\]\n`)
	asideWhere = regexp.MustCompile(`(?m)^\[now: (.*)\]$`)
	fromSource = regexp.MustCompile(`^\[message from ([^\]\n]+)\]\n`)
	signature  = regexp.MustCompile(`(?s)\s*\[(from|started by) (?:session ("(?:[^"\\]|\\.)*") \((\S+?)(?: on (\S+))?\)|a Claude session on (\S+) that atc does not run, so it cannot take messages)(?: · (relays the user's own go-ahead)[^·\]]*)? · ([^\]]*)\]\s*$`)
)

// said is a user turn taken apart: the message itself, who sent it when the user didn't, the channel the hub
// announced it on (only when it changed), and what was pasted into it alongside the user's own words.
type said struct {
	body    string
	via     *Via
	channel string
	pastes  []string
}

// envelope splits what atc and the hub wrapped around a user turn from the message itself.
func envelope(t string) said {
	raw := strings.TrimSpace(t)
	var out said
	for _, m := range pasted.FindAllStringSubmatch(t, -1) {
		out.pastes = append(out.pastes, strings.TrimSpace(m[1]))
	}
	t = strings.TrimSpace(pastedTag.ReplaceAllString(t, ""))
	if m := talkMode.FindStringSubmatch(t); m != nil {
		out.channel, t = m[1], strings.TrimSpace(t[len(m[0]):])
	}
	t = strings.TrimSpace(unsaid.ReplaceAllString(t, ""))
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
	out.body = t
	if len(out.pastes) > 0 && strings.TrimSpace(pasted.ReplaceAllString(raw, "")) == "" {
		out.pastes = nil
	}
	if v.Title == "" && v.Host == "" && v.Source == "" && v.Channel == "" {
		return out
	}
	v.Raw = raw
	out.via = v
	return out
}

// event is what a user turn says happened rather than what someone wrote: a background task ending, a call
// line's news, the conversation being continued.
func event(t string, at time.Time) (Message, bool) {
	t = strings.TrimSpace(t)
	switch {
	case strings.HasPrefix(t, "<task-notification>"):
		return Message{Role: "event", Text: noticeText(t), Time: at, Task: taskOf(t)}, true
	case strings.HasPrefix(t, compactPrefix):
		return Message{Role: "event", Text: noticeText(t), Time: at}, true
	}
	if m := talkMode.FindStringSubmatch(t); m != nil {
		t = strings.TrimSpace(t[len(m[0]):])
	}
	t, _ = news(t)
	if m := lineEvent.FindStringSubmatch(t); m != nil {
		e := Message{Role: "event", Channel: m[1], Time: at, Kind: "line"}
		if strings.HasPrefix(m[2], "[") {
			e.Kind = "call-end"
			e.Text, _, _ = strings.Cut(m[2][1:], "]")
		} else {
			e.Text = strings.Trim(strings.TrimSpace(m[2]), "()")
		}
		return e, true
	}
	return Message{}, false
}

var taskField = regexp.MustCompile(`<(task-id|tool-use-id|output-file|status)>([^<]*)</`)

// Task is a background task's end as Claude Code tells the session: which one, how it ended, where its output is.
type Task struct {
	ID     string `json:"id,omitempty"`
	Call   string `json:"call,omitempty"`
	Output string `json:"output,omitempty"`
	Status string `json:"status,omitempty"`
}

func taskOf(t string) *Task {
	var k Task
	for _, m := range taskField.FindAllStringSubmatch(t, -1) {
		switch m[1] {
		case "task-id":
			k.ID = m[2]
		case "tool-use-id":
			k.Call = m[2]
		case "output-file":
			k.Output = m[2]
		case "status":
			k.Status = m[2]
		}
	}
	if k == (Task{}) {
		return nil
	}
	return &k
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

// viaName is how a sender is called where there is room for one name.
func viaName(v *Via) string {
	switch {
	case v.Title != "":
		return v.Title
	case v.Source != "":
		return v.Source
	case v.Host != "":
		return "a session on " + v.Host
	}
	return v.Channel
}

func unpaste(t string) string {
	return envelope(t).body
}
