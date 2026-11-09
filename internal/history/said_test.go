package history

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestChannelCarriesUntilTheHubSaysItChanged(t *testing.T) {
	head := func(ch string) string {
		return "[talk-mode: " + ch + ", until the next talk-mode line]\nrules\n[message]\n"
	}
	var msgs []Message
	for _, text := range []string{
		head("whatsapp") + "one",
		"two",
		"[talk-mode: agent, for this message only]\nrules\n[message]\nreport\n\n[from session \"s\" (ab12cd34) · no need to answer]",
		head("phone") + "[hub: a report or a guest's message came in while you were on the call, see above; tell the user]\nthree",
		"[atc since your last turn, 10:00]\n- @x finished\n\n[phone event] [call over] (finish what you were doing)",
		"[phone event] (they moved the line away)",
	} {
		if e, ok := event(text, time.Time{}); ok {
			msgs = append(msgs, e, Message{Role: "done"})
			continue
		}
		sd := envelope(text)
		msgs = append(msgs, Message{Role: "user", Text: sd.body, Via: sd.via, Channel: sd.channel}, Message{Role: "assistant", Text: "ok"}, Message{Role: "done"})
	}
	turns := BuildTurns(msgs, make([]int64, len(msgs)), 0, nil)
	type row struct {
		Prompt, Channel, Kind string
		Switch                bool
	}
	var got []row
	for _, t := range turns {
		got = append(got, row{t.Prompt, t.Channel, t.Kind, t.Switch})
	}
	want := []row{
		{"one", "whatsapp", "", true},
		{"two", "whatsapp", "", false},
		{"report", "", "", false},
		{"three", "phone", "", true},
		{"call over", "phone", "call-end", false},
		{"they moved the line away", "phone", "line", false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

func TestTaskNotification(t *testing.T) {
	in := "<task-notification>\n<task-id>b0h4</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/x/tasks/b0h4.output</output-file>\n<status>failed</status>\n<summary>Background command \"make test\" failed with exit code 2</summary>\n</task-notification>"
	e, ok := event(in, time.Time{})
	if !ok || e.Text != `Background command "make test" failed with exit code 2` || !reflect.DeepEqual(e.Task, &Task{ID: "b0h4", Call: "toolu_01", Output: "/tmp/x/tasks/b0h4.output", Status: "failed"}) {
		t.Fatalf("%+v %+v", e, e.Task)
	}
}

func TestPastesOnlyBesideTheUsersOwnWords(t *testing.T) {
	if sd := envelope("look at this\n\n<pasted_content id=\"1\">\nline one\nline two\n</pasted_content id=\"1\">\nwhy?"); !reflect.DeepEqual(sd.pastes, []string{"line one\nline two"}) || sd.body != "look at this\n\nline one\nline two\nwhy?" {
		t.Fatalf("%q %q", sd.body, sd.pastes)
	}
	if sd := envelope("<pasted_content id=\"1\">\n[wake-up from your schedule]\nalarms\n</pasted_content id=\"1\">"); sd.pastes != nil {
		t.Fatalf("a message that is all paste has no paste block: %q", sd.pastes)
	}
}

func TestATaskEndsOnceThoughTheTranscriptTellsItTwice(t *testing.T) {
	n := `<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"x\" completed</summary>\n</task-notification>`
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"attachment","attachment":{"type":"queued_command","prompt":"`+n+`"}}
{"type":"user","message":{"role":"user","content":"`+n+`"}}
`), 0o644)
	pg, err := ReadRange(p, 0, 1<<20)
	if err != nil || len(pg.Messages) != 1 || pg.Messages[0].Task == nil {
		t.Fatalf("%v %+v", err, pg.Messages)
	}
}
