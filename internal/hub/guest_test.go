package hub

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGuestReachesNoOneAndKeepsHisChannel(t *testing.T) {
	r := newRig(t, CallConfig{})
	var mu sync.Mutex
	var written []string
	in := r.h.in
	r.h.mu.Lock()
	r.h.in = writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		written = append(written, string(b))
		mu.Unlock()
		return in.Write(b)
	})
	r.h.mu.Unlock()
	wa, all := r.dial("whatsapp"), r.dial("")
	wa.send("message", "hi")
	wa.until("done")
	all.until("done")

	r.h.Say(Guest, "[guest pat on WhatsApp]\nthe site is down")
	if es := all.until("done"); es[len(es)-1].Channel != Guest {
		t.Fatalf("guest turn %v", es)
	}
	select {
	case e := <-wa.ev:
		t.Fatalf("whatsapp got %v", e)
	case <-time.After(200 * time.Millisecond):
	}
	mu.Lock()
	note := written[len(written)-1]
	mu.Unlock()
	if !strings.Contains(note, "[talk-mode: guest, for this message only]") || !strings.Contains(note, "MODE guest") || !strings.Contains(note, "the user last wrote from whatsapp") {
		t.Fatalf("guest note %s", note)
	}

	wa.send("message", "again")
	wa.until("done")
	mu.Lock()
	defer mu.Unlock()
	if last := written[len(written)-1]; strings.Contains(last, "talk-mode") {
		t.Fatalf("whatsapp mode resent after a guest: %s", last)
	}
}

func TestOnCallAsksTheLine(t *testing.T) {
	var mu sync.Mutex
	state := "idle"
	line := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Write([]byte(`{"call":"` + state + `"}`))
	}))
	defer line.Close()
	r := newRig(t, CallConfig{URL: line.URL})
	r.dial(Phone)
	r.h.mu.Lock()
	idle := r.h.onCall()
	r.h.mu.Unlock()
	mu.Lock()
	state = "offhook"
	mu.Unlock()
	r.h.mu.Lock()
	on := r.h.onCall()
	r.h.mu.Unlock()
	if idle || !on {
		t.Fatalf("idle line: %v, call on: %v", idle, on)
	}
}

func TestGuestCallIsSpokenAndHoldsHim(t *testing.T) {
	r := newRig(t, CallConfig{})
	var mu sync.Mutex
	var written []string
	in := r.h.in
	r.h.mu.Lock()
	r.h.cfg.News = func(bool) string { return "[atc now] the user's sessions" }
	r.h.in = writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		written = append(written, string(b))
		mu.Unlock()
		return in.Write(b)
	})
	r.h.mu.Unlock()
	wa := r.dial("whatsapp")
	wa.send("message", "hi")
	wa.until("done")
	call := r.dial(GuestCall)
	call.send("message", "TOOL [guest pat on the phone] site")
	first := call.until("tool")
	wa.send("message", "hello")
	if es := wa.until("held"); len(es) != 1 {
		t.Fatalf("whatsapp got %v before held", es)
	}
	r.finishTool()
	if got := said(append(first, call.until("done")...)); !strings.HasPrefix(got, "looking") {
		t.Fatalf("guest heard %q", got)
	}
	if got := said(wa.until("done")); !strings.HasSuffix(got, "hello") {
		t.Fatalf("whatsapp got %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	var callMsg string
	for _, w := range written {
		if strings.Contains(w, "guest pat on the phone") {
			callMsg = w
		}
	}
	if strings.Contains(callMsg, "the user's sessions") || !strings.Contains(callMsg, "MODE guest-call") {
		t.Fatalf("guest call message %s", callMsg)
	}
	if b, _ := os.ReadFile(r.h.homePath()); strings.TrimSpace(string(b)) != "whatsapp" {
		t.Fatalf("home %q", b)
	}
}

func TestUnusedConversationStartsWithItsFirstMessage(t *testing.T) {
	exe, _ := os.Executable()
	t.Setenv("HUB_FAKE_CLAUDE", "1")
	dir := filepath.Join(t.TempDir(), "guests")
	g := New(Config{Bin: exe, Dir: dir, State: t.TempDir(), Mode: func(ch string) string { return "" }, GuestDesk: true})
	t.Cleanup(g.Stop)
	if g.HasConversation() {
		t.Fatal("nobody has talked to it")
	}
	if _, err := os.Stat(dir); err == nil {
		t.Fatal("its folder should not exist before it is used")
	}
	if _, err := g.Say(Guest, "hello"); err != nil {
		t.Fatal(err)
	}
	if !g.HasConversation() {
		t.Fatal("the first message should start it")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
}

func TestGuestsHaveTheirOwnConversation(t *testing.T) {
	exe, _ := os.Executable()
	t.Setenv("HUB_FAKE_CLAUDE", "1")
	mode := func(ch string) string { return "MODE " + ch }
	g := New(Config{Bin: exe, Dir: t.TempDir(), State: t.TempDir(), Mode: mode, GuestDesk: true})
	h := New(Config{Bin: exe, Dir: t.TempDir(), State: t.TempDir(), Mode: mode, Guests: g})
	for _, x := range []*Hub{g, h} {
		if err := x.Start(); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(h.Handler())
	t.Cleanup(func() { srv.Close(); h.Stop(); g.Stop() })
	r := &rig{t, h, srv}

	mine := r.dial("")
	call := r.dial(GuestCall)
	call.send("message", "[guest pat on the phone] hello")
	if es := call.until("done"); es[len(es)-1].Channel != GuestCall {
		t.Fatalf("guest call %v", es)
	}
	resp, err := http.Post(srv.URL+"/message", "application/json", strings.NewReader(`{"channel":"guest","text":"[guest kim on WhatsApp]\nselam"}`))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("guest message: %v %v", resp, err)
	}
	time.Sleep(300 * time.Millisecond)
	for len(mine.ev) > 0 {
		if e := <-mine.ev; e.Type != "session" {
			t.Fatalf("the assistant's conversation saw a guest: %v", e)
		}
	}
	if st := h.Status(); st.Session == g.Status().Session || st.Channels[GuestCall] != 0 {
		t.Fatalf("assistant %+v", st)
	}
	if st := g.Status(); st.Channels[GuestCall] != 1 {
		t.Fatalf("guests %+v", st)
	}
	if resp, err = http.Get(srv.URL + "/guests/status"); err != nil || resp.StatusCode != 200 {
		t.Fatalf("guests status: %v %v", resp, err)
	}
}
