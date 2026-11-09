package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func useShippedCallLines(t *testing.T) {
	files, _ := filepath.Glob("../../voice/lang/*.json")
	var packs []map[string]string
	for _, f := range files {
		b, _ := os.ReadFile(f)
		var p map[string]any
		json.Unmarshal(b, &p)
		words := map[string]string{}
		for k, v := range p {
			if s, ok := v.(string); ok {
				words[k] = s
			}
		}
		packs = append(packs, words)
	}
	if len(packs) == 0 {
		t.Fatal("no voice language packs")
	}
	UseCallLines(packs...)
	t.Cleanup(func() { UseCallLines() })
}

func TestMarks(t *testing.T) {
	useShippedCallLines(t)
	for _, c := range []struct {
		in, body, kind string
		mark           *Mark
	}{
		{"just words", "just words", "", nil},
		{"[wake-up from your schedule, every 2m]\ncheck the alarms", "check the alarms", "wake", &Mark{Every: "2m"}},
		{"[atc: a new conversation; the previous one (5e1a90b2) left this handover note]\n\nall quiet\n\nRead notes.md, then answer in one line.", "all quiet", "restart", &Mark{Prev: "5e1a90b2"}},
		{"[hub: yeni oturum; önceki oturum (0c1d2e3f-0000-4000-8000-000000000042) şu devir notunu bıraktı]\n\nnot", "not", "restart", &Mark{Prev: "0c1d2e3f-0000-4000-8000-000000000042"}},
		{"what time is it (a second reading of the same sound heard «What time is it?»)", "what time is it", "", &Mark{Alt: "What time is it?"}},
		{"saat kaç (aynı sesi ikinci okuma «Saat kaç?» diye duydu)", "saat kaç", "", &Mark{Alt: "Saat kaç?"}},
		{"(aynı sesi ikinci okuma «evet» diye duydu)", "", "", &Mark{Alt: "evet"}},
		{"yes (only the second reading heard this, the first was empty)", "yes", "", &Mark{AltOnly: true}},
		{"(I cut you off; all I heard of your reply was: «Sure, the first») wait, stop", "wait, stop", "", &Mark{Heard: "Sure, the first"}},
		{"(sözünü kestim; cevabından sadece şunu duydum: «Tamam, bakıyorum») dur (aynı sesi ikinci okuma «dur.» diye duydu)", "dur", "", &Mark{Heard: "Tamam, bakıyorum", Alt: "dur."}},
	} {
		body, mark, kind := marked(c.in)
		if body != c.body || kind != c.kind || !reflect.DeepEqual(mark, c.mark) {
			t.Errorf("%q:\n got %q %q %+v\nwant %q %q %+v", c.in, body, kind, mark, c.body, c.kind, c.mark)
		}
	}
}

func TestACallTheAssistantPlaced(t *testing.T) {
	useShippedCallLines(t)
	UseCallStart("[phone · %s · you called Sam, %s", " · reason: ")
	t.Cleanup(func() { UseCallStart("", "") })
	in := "[talk-mode: phone, until the next talk-mode line]\nrules\n[message]\n" +
		"[phone · 20:16 · you called Sam, it is ringing · reason: test the new line]\n[atc now, 20:16]\nYour turn: none\n\n" +
		"[You are calling Sam and the phone is ringing. They hear this reply first, once they pick up and say hello: greet them briefly, say you are Ada and why you are calling.]"
	sd := envelope(in)
	if sd.body != "" || sd.channel != "phone" || !reflect.DeepEqual(sd.mark, &Mark{Called: true, Reason: "test the new line"}) {
		t.Fatalf("%q %q %+v", sd.body, sd.channel, sd.mark)
	}
	if sd := envelope("[phone · 20:16 · you called Sam, they picked up]\nhello?"); sd.body != "hello?" || !reflect.DeepEqual(sd.mark, &Mark{Called: true}) {
		t.Fatalf("%q %+v", sd.body, sd.mark)
	}
}

func TestStoppedIsAnEvent(t *testing.T) {
	for _, in := range []string{"[Request interrupted by user]", "[Request interrupted by user for tool use]"} {
		if e, ok := event(in, time.Time{}); !ok || e.Kind != "stopped" {
			t.Errorf("%q: %+v", in, e)
		}
	}
}
