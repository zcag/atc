package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const event = `{"id":"evt_1","type":"message.new","data":{"conversationId":441,"conversationTitle":"Ada Lovelace","channel":"whatsapp","messageId":90211,"sender":"Ada Lovelace","waitsOnYou":true,"screener":false,"text":"Are we still on for tonight?"}}`

func TestParseInbound(t *testing.T) {
	m, ok, err := parseInbound([]byte(event), "https://inbox.example/c/{conversationId}?m={messageId}")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	want := inbound{ID: "90211", Conv: "whatsapp|441", Sender: "Ada Lovelace", Network: "whatsapp", Text: "Are we still on for tonight?", Link: "https://inbox.example/c/441?m=90211"}
	if m != want {
		t.Fatalf("got %+v", m)
	}
	for name, body := range map[string]string{
		"ping":        `{"id":"evt_2","type":"ping","data":{"webhook":1}}`,
		"other event": `{"type":"unread.changed","data":{"unread":3}}`,
		"not waiting": strings.Replace(event, `"waitsOnYou":true`, `"waitsOnYou":false`, 1),
		"screened":    strings.Replace(event, `"screener":false`, `"screener":true`, 1),
	} {
		if _, ok, err := parseInbound([]byte(body), ""); ok || err != nil {
			t.Errorf("%s: ok=%v err=%v", name, ok, err)
		}
	}
	m, ok, _ = parseInbound([]byte(`{"sender":"Grace","network":"sms","text":"call me","link":"https://x/1"}`), "")
	if !ok || m.Sender != "Grace" || m.Link != "https://x/1" || m.ID == "" {
		t.Fatalf("flat: %+v", m)
	}
	if _, _, err := parseInbound([]byte(`{"text":"who?"}`), ""); err == nil {
		t.Fatal("no sender taken")
	}
}

func TestSigned(t *testing.T) {
	body := []byte(event)
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))
	for _, h := range []http.Header{{"X-Inbox-Signature": {"sha256=" + sig}}, {"X-Hub-Signature-256": {"sha256=" + sig}}, {"X-Signature": {sig}}} {
		if !signed("s3cret", body, h) {
			t.Errorf("refused %v", h)
		}
	}
	if signed("other", body, http.Header{"X-Signature": {sig}}) || signed("s3cret", body, http.Header{"X-Token": {sig}}) {
		t.Fatal("took a wrong signature")
	}
}

func TestFeedMessages(t *testing.T) {
	f := newFeed()
	now := time.Now()
	_, seq := f.news(0, false, now)
	m := inbound{ID: "1", Conv: "whatsapp|7", Sender: "Ada", Network: "whatsapp", Text: "Are we still on?", Link: "https://x/1"}
	if fresh, first := f.message(m, now); !fresh || !first {
		t.Fatal("first message")
	}
	if fresh, _ := f.message(m, now.Add(time.Hour)); fresh {
		t.Fatal("dedup")
	}
	text, seq2 := f.news(seq, false, now.Add(time.Minute))
	if !strings.Contains(text, `Ada on whatsapp wrote (1m ago, waits on the user): "Are we still on?" https://x/1`) {
		t.Fatalf("news %q", text)
	}
	if again, _ := f.news(seq2, false, now); again != "" {
		t.Fatalf("twice: %q", again)
	}
	if stale, _ := f.news(seq, false, now.Add(msgFresh+time.Minute)); stale != "" {
		t.Fatalf("old message still news: %q", stale)
	}
	if snap, _ := f.news(0, true, now); !strings.Contains(snap, "Messages from other apps waiting on the user:\n- Ada on whatsapp") {
		t.Fatalf("snapshot %q", snap)
	}
	if fresh, _ := f.message(m, now.Add(msgMemory+time.Hour)); !fresh {
		t.Fatal("remembered forever")
	}
}

func TestFeedFoldsABurst(t *testing.T) {
	f := newFeed()
	now := time.Now()
	_, seq := f.news(0, false, now)
	for i, text := range []string{"hey", "you there?", "call me"} {
		m := inbound{ID: string(rune('a' + i)), Conv: "whatsapp|7", Sender: "Ada", Network: "whatsapp", Text: text}
		if _, first := f.message(m, now.Add(time.Duration(i)*time.Minute)); first != (i == 0) {
			t.Fatalf("message %d first=%v", i, first)
		}
	}
	f.message(inbound{ID: "z", Conv: "sms|9", Sender: "Grace", Network: "sms", Text: "ok"}, now)
	text, _ := f.news(seq, false, now.Add(2*time.Minute))
	if strings.Count(text, "\n- ") != 2 || !strings.Contains(text, `Ada on whatsapp wrote 3 messages (the last 0m ago, waits on the user): "call me"`) {
		t.Fatalf("news %q", text)
	}
	snap, _ := f.news(0, true, now.Add(2*time.Minute))
	if strings.Count(snap, "\n- ") != 2 || !strings.Contains(snap, "wrote 3 messages") {
		t.Fatalf("snapshot %q", snap)
	}
}

func TestInboundHook(t *testing.T) {
	t.Setenv(inboundSecretKey, "s3cret")
	s := &Server{feed: newFeed()}
	post := func(sig string) int {
		r := httptest.NewRequest("POST", "/api/inbound", strings.NewReader(event))
		r.Header.Set("X-Inbox-Signature", sig)
		w := httptest.NewRecorder()
		s.inboundHook(w, r)
		return w.Code
	}
	if c := post("sha256=00"); c != http.StatusUnauthorized {
		t.Fatalf("bad signature: %d", c)
	}
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write([]byte(event))
	if c := post("sha256=" + hex.EncodeToString(mac.Sum(nil))); c != http.StatusOK || len(s.feed.msgs) != 1 {
		t.Fatalf("good signature: %d, %d kept", c, len(s.feed.msgs))
	}
}
