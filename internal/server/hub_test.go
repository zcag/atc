package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/whatsapp"
)

// fakeHub answers like atc hub: it records what atc sends and lets the test push events.
type fakeHub struct {
	mu     sync.Mutex
	status hub.Status
	got    []string
	calls  []hub.CallReq
	events chan hub.Event
	srv    *httptest.Server
}

func newFakeHub(t *testing.T, sid string) *fakeHub {
	f := &fakeHub{status: hub.Status{Session: sid, Alive: true, PID: 42}, events: make(chan hub.Event, 64)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		json.NewEncoder(w).Encode(f.status)
	})
	mux.HandleFunc("POST /message", func(w http.ResponseWriter, r *http.Request) {
		var m struct{ Channel, Text string }
		json.NewDecoder(r.Body).Decode(&m)
		f.mu.Lock()
		f.got = append(f.got, m.Channel+": "+m.Text)
		f.mu.Unlock()
		w.Write([]byte(`{"status":"sent"}`))
	})
	mux.HandleFunc("POST /interrupt", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.got = append(f.got, "interrupt "+string(b))
		f.mu.Unlock()
		w.Write([]byte(`{"interrupted":true}`))
	})
	mux.HandleFunc("POST /call", func(w http.ResponseWriter, r *http.Request) {
		var c hub.CallReq
		json.NewDecoder(r.Body).Decode(&c)
		f.mu.Lock()
		f.calls = append(f.calls, c)
		f.mu.Unlock()
		w.Write([]byte(`{"outcome":"no-answer"}`))
	})
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		wsjson.Write(r.Context(), c, hub.Event{Type: "session", Text: sid})
		for {
			select {
			case <-r.Context().Done():
				return
			case e := <-f.events:
				if wsjson.Write(r.Context(), c, e) != nil {
					return
				}
			}
		}
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHub) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.got...)
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for range 100 {
		if ok() {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("never: %s", what)
}

func hubServer(t *testing.T, f *fakeHub, wa *whatsapp.Client) (*Server, *httptest.Server) {
	bin := fakeClaude(t)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{
		M:    &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Token: "tok", Host: "here", Web: fstest.MapFS{}, StateDir: t.TempDir(),
		Hub: hub.NewClient(f.srv.URL), WhatsApp: wa,
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	eventually(t, "hub connected", func() bool { return s.hubUp() })
	return s, ts
}

func api(t *testing.T, ts *httptest.Server, method, path, body string) (int, string) {
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestHubSessionIsListedAndTakesMessages(t *testing.T) {
	f := newFakeHub(t, "hub-sid")
	s, ts := hubServer(t, f, nil)
	eventually(t, "named", func() bool { return s.M.Store.Get("hub-sid").Name == hubName })

	f.mu.Lock()
	f.status.Owners, f.status.Route = []string{"phone"}, "phone"
	f.mu.Unlock()
	list, err := s.liveAll(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	x, ok := find(list, "hub-sid")
	if !ok || x.Kind != "hub" || x.ID != "hub-sid" || x.State != sessions.Working || x.Activity != "on a call" || x.Title != hubName {
		t.Fatalf("hub row %+v", x)
	}

	for _, c := range []struct{ body, want string }{
		{`{"text":"hi"}`, "atc: hi"},
		{`{"text":"report","from":"other-sid"}`, "agent: report"},
	} {
		if code, b := api(t, ts, "POST", "/api/sessions/hub-sid/send", c.body); code != 200 {
			t.Fatalf("send: %d %s", code, b)
		}
		if got := f.sent(); got[len(got)-1] != c.want {
			t.Fatalf("hub got %q, want %q", got[len(got)-1], c.want)
		}
	}
	api(t, ts, "POST", "/api/sessions/hub-sid/keys", `{"keys":"\u001b"}`)
	if got := f.sent(); !strings.HasPrefix(got[len(got)-1], "interrupt ") {
		t.Fatalf("Esc did not interrupt: %v", got)
	}
	if code, b := api(t, ts, "POST", "/api/assist", ""); code != 200 || !strings.Contains(b, `"hub-sid"`) {
		t.Fatalf("assist: %d %s", code, b)
	}
	if code, _ := api(t, ts, "GET", "/api/sessions/hub-sid/attach", ""); code != http.StatusConflict {
		t.Fatalf("attach: %d", code)
	}
}

func TestCallFromTheHubTellsItselfOnNoAnswer(t *testing.T) {
	f := newFakeHub(t, "hub-sid")
	_, ts := hubServer(t, f, nil)
	code, b := api(t, ts, "POST", "/api/call", `{"reason":"why","from":"[from session x]","session":"other","wait":true,"timeout":5,"whatsapp":true}`)
	if code != 200 || !strings.Contains(b, "no-answer") {
		t.Fatalf("call: %d %s", code, b)
	}
	api(t, ts, "POST", "/api/call", `{"reason":"mine","from":"[from session assistant]","session":"hub-sid"}`)
	eventually(t, "second call", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) == 2 })
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.calls[0]; c.Notify || c.From != "[from session x]" || c.Timeout != 5 || !c.WhatsApp {
		t.Errorf("worker's call %+v", c)
	}
	if c := f.calls[1]; !c.Notify || c.From != "" || c.WhatsApp {
		t.Errorf("hub's own call %+v", c)
	}
}

func TestWhatsAppThroughTheHub(t *testing.T) {
	var mu sync.Mutex
	var calls []string
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		calls = append(calls, r.Method+" "+r.URL.Path+" "+string(b))
		mu.Unlock()
		w.Write([]byte(`{"id":"out1","messageId":"out1"}`))
	}))
	defer gw.Close()
	for k, v := range map[string]string{"URL": gw.URL, "KEY": "k", "SESSION": "bot", "OWNER": "12025550100", "SECRET": "0123456789abcdef0123"} {
		t.Setenv("ATC_WHATSAPP_"+k, v)
	}
	f := newFakeHub(t, "hub-sid")
	s, _ := hubServer(t, f, whatsapp.FromEnv())
	ctx := context.Background()
	if err := s.waType(ctx, waMsg{"12025550100@c.us", "in1"}, "hello", ""); err != nil {
		t.Fatal(err)
	}
	if got := f.sent(); len(got) != 1 || got[0] != "whatsapp: hello" {
		t.Fatalf("hub got %v", got)
	}
	for _, e := range []hub.Event{{Type: "turn", Channel: "whatsapp"}, {Type: "read", Channel: "whatsapp"},
		{Type: "block", Channel: "whatsapp", Text: "Hi there"}, {Type: "done", Channel: "whatsapp"}} {
		f.events <- e
	}
	seen := func(part string) bool {
		mu.Lock()
		defer mu.Unlock()
		for _, c := range calls {
			if strings.Contains(c, part) {
				return true
			}
		}
		return false
	}
	eventually(t, "reply sent", func() bool { return seen("Hi there") })
	eventually(t, "ticked", func() bool { return seen("✅") })
}
