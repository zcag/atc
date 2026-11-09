package history

import (
	"reflect"
	"testing"
)

func TestEnvelope(t *testing.T) {
	report := "[talk-mode: agent, for this message only]\nanother session writes; your reply reaches no one\n[now: The user is not on a call; the user last wrote from atc]\n[message]\n" +
		"[atc since your last turn, 17:14]\n- @sweeper started working\n\n" +
		"Done.\n\n- one\n- two\n\n[from session \"Sweeper\" (5e1a90b2 on box1) · no need to answer]"
	for _, c := range []struct {
		name, in, body string
		via            *Via
	}{
		{"typed by the user", "[talk-mode: atc, until the next talk-mode line]\nbe short\n[message]\nhello", "hello", nil},
		{"a report to the assistant", report, "Done.\n\n- one\n- two", &Via{
			Title: "Sweeper", Ref: "5e1a90b2", Host: "box1", AskText: "no need to answer", Channel: "agent",
			Where: "The user is not on a call; the user last wrote from atc", News: []string{"@sweeper started working"}, Raw: report,
		}},
		{"started, wants a report", "fix it\n\n[started by session \"ops \\\"x\\\"\" (ab12cd34) · report back when done with atc's send tool to ab12cd34]", "fix it", &Via{
			Title: `ops "x"`, Ref: "ab12cd34", Started: true, Ask: "report", AskText: "report back when done with atc's send tool to ab12cd34",
		}},
		{"handed off", "go\n\n[started by session \"assistant\" (hub on box1) · handed off to you: no need to report back]", "go", &Via{
			Title: "assistant", Ref: "hub", Host: "box1", Started: true, Ask: "handoff", AskText: "handed off to you: no need to report back",
		}},
		{"the user's go-ahead", "merge it\n\n[from session \"assistant\" (hub on box1) · relays the user's own go-ahead: what this message asks counts as their approval · no need to answer]", "merge it", &Via{
			Title: "assistant", Ref: "hub", Host: "box1", Approved: true, AskText: "no need to answer",
		}},
		{"a session atc does not run", "hi\n\n[from a Claude session on box2 that atc does not run, so it cannot take messages · put your report in your final message]", "hi", &Via{
			Host: "box2", Ask: "report", AskText: "put your report in your final message",
		}},
		{"sent before the hub read JSON", "{\"text\":\"Done.\\n\\n[from session \\\"Sweeper\\\" (5e1a90b2 on box1) · no need to answer]\"}", "Done.", &Via{
			Title: "Sweeper", Ref: "5e1a90b2", Host: "box1", AskText: "no need to answer",
		}},
		{"a webhook", "[message from grafana]\n{\"alert\":1}", "{\"alert\":1}", &Via{Source: "grafana"}},
	} {
		sd := envelope(c.in)
		body, via := sd.body, sd.via
		if c.via != nil && c.via.Raw == "" {
			c.via.Raw = c.in
		}
		if body != c.body || !reflect.DeepEqual(via, c.via) {
			t.Errorf("%s:\n body %q\n via %+v\nwant %q\n     %+v", c.name, body, via, c.body, c.via)
		}
	}
}
