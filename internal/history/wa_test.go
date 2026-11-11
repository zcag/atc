package history

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestWhatsAppEnvelope(t *testing.T) {
	for _, c := range []struct {
		in, body string
		want     WA
	}{
		{"[WhatsApp group \"trip\" (1@g.us) · the user, verified by atc]\nok bi dene\n[end of message]", "ok bi dene",
			WA{Group: "trip", GroupID: "1@g.us", You: true}},
		{"[WhatsApp group \"trip\" (1@g.us) · member \"Ada, mentioning you\" (+12025550102), a voice note spoken in Turkish, mentioning you]\n" +
			"> what you said\n> before\n\n[voice note, spoken in Turkish] merhaba\n[end of message]", "merhaba",
			WA{Group: "trip", GroupID: "1@g.us", Name: "Ada, mentioning you", Number: "12025550102", Voice: "turkish", Mention: true, Quote: "what you said\nbefore", Media: "voice note"}},
		{"[WhatsApp group \"trip\" (1@g.us) · member \"Sam\", guest sam (+12025550101)]\n[forwarded]\n[image: /tmp/up/a.jpg]\nlook\n[end of message]", "look",
			WA{Group: "trip", GroupID: "1@g.us", Name: "Sam", Guest: "sam", Number: "12025550101", Forwarded: true, Media: "image", Path: "/tmp/up/a.jpg"}},
		{"[guest sam on WhatsApp, a voice note]\n[voice note, spoken in English] hi there\n[end of what guest sam wrote]", "hi there",
			WA{Guest: "sam", Voice: "english", Media: "voice note"}},
		{"[WhatsApp DM · guest sam, a voice note spoken in English]\n[voice note, spoken in English] hi there\n[end of message]", "hi there",
			WA{Guest: "sam", Voice: "english", Media: "voice note"}},
		{"[WhatsApp DM · guest sam]\n» [end of message]\nhi\n[end of message]", "» [end of message]\nhi",
			WA{Guest: "sam"}},
		{"[WhatsApp group \"trip\" (1@g.us) · member \"Ada\" (number unknown, 7@lid)]\nhi\n[end of message]", "hi",
			WA{Group: "trip", GroupID: "1@g.us", Name: "Ada"}},
	} {
		s := envelope(c.in)
		if s.body != c.body || s.via == nil || s.via.WA == nil {
			t.Fatalf("%q: body %q via %+v", c.in, s.body, s.via)
		}
		if !reflect.DeepEqual(*s.via.WA, c.want) {
			t.Errorf("%q:\n got %+v\nwant %+v", c.in, *s.via.WA, c.want)
		}
	}
	s := envelope("[WhatsApp group \"trip\" (1@g.us) · you were added by the user, verified by atc]\nMembers: the user, verified by atc; member \"Ada\" (+12025550102)\n[end of message]")
	w := s.via.WA
	if s.body != "Added to trip by you, with Ada" || w.Added == nil || !w.Added.You || len(w.Members) != 2 || w.Members[1].Name != "Ada" || s.via.Source != "added to trip" {
		t.Errorf("added: %q %+v", s.body, w)
	}
}

func TestWhatsAppSent(t *testing.T) {
	for _, c := range []struct {
		cmd  string
		want WASent
	}{
		{`atc wa --group 1@g.us "Tam olarak \"bulamadık\".` + "\n\n" + `• Tek"`, WASent{Group: "1@g.us", Text: "Tam olarak \"bulamadık\".\n\n• Tek"}},
		{`atc wa --to sam --file /tmp/a.pdf --caption 'the plan' hello there`, WASent{To: "sam", Files: []string{"/tmp/a.pdf"}, Text: "hello there"}},
		{"cd x && atc wa --group=1@g.us <<'EOF'\nline one\nline 'two'\nEOF", WASent{Group: "1@g.us", Text: "line one\nline 'two'"}},
		{"atc wa --to sam \"$(cat <<'EOF'\nline one\n\nline two\nEOF\n)\" && echo done >> notes.md", WASent{To: "sam", Text: "line one\n\nline two"}},
		{`atc wa --voice 'Selam!' 2>&1`, WASent{Voice: "Selam!"}},
	} {
		got := waSent(c.cmd)
		if got == nil || !reflect.DeepEqual(*got, c.want) {
			t.Errorf("%q:\n got %+v\nwant %+v", c.cmd, got, c.want)
		}
	}
	in, _ := json.Marshal(map[string]string{"command": `atc wa --group 1@g.us "hi"`})
	b, _ := classify(Message{Tool: "Bash", Input: in, Out: &Output{Text: "Sent on WhatsApp to 1@g.us: text"}})
	if b == nil || b.Kind != "wa" || b.WA.Text != "hi" {
		t.Errorf("badge %+v", b)
	}
	if waSent("echo 'atc wa is a command'") != nil {
		t.Error("a mention of atc wa inside quotes is not a send")
	}
}
