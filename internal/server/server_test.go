package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

const localAgents = `[{"id":"loc00001","sessionId":"l1","kind":"background","pid":1,"state":"done","cwd":"/tmp","name":"local one"}]`

func fakeClaude(t *testing.T) string {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "agents.json"), []byte(localAgents), 0o644)
	bin := filepath.Join(dir, "claude")
	os.WriteFile(bin, []byte(`#!/bin/sh
case "$1" in
agents) cat "`+dir+`/agents.json" ;;
--bg) echo "$@" > "`+dir+`/started"; echo "backgrounded · abcd1234 · x" ;;
attach) IFS= read -r line; printf '%s' "$line" > "`+dir+`/sent" ;;
esac
`), 0o755)
	return bin
}

func newTestServer(t *testing.T, peers []Peer, voice Voice, roots ...string) *httptest.Server {
	return serverWith(t, fakeClaude(t), peers, voice, roots...)
}

func serverWith(t *testing.T, bin string, peers []Peer, voice Voice, roots ...string) *httptest.Server {
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{
		M:    &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Roots: roots,
		Web:   fstest.MapFS{"index.html": {Data: []byte("<!doctype html>atc")}},
		Token: "tok", Host: "here", Peers: peers, Voice: voice,
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func get(t *testing.T, url, token string) (*http.Response, string) {
	return do(t, "GET", url, token, "")
}

func do(t *testing.T, method, url, token, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, string(b)
}

func TestAuth(t *testing.T) {
	ts := newTestServer(t, nil, Voice{})
	if res, _ := get(t, ts.URL+"/api/sessions", ""); res.StatusCode != 401 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+"/api/sessions", "wrong"); res.StatusCode != 401 {
		t.Fatalf("wrong token: %d", res.StatusCode)
	}
	if res, body := get(t, ts.URL+"/api/sessions", "tok"); res.StatusCode != 200 || !strings.Contains(body, "local one") {
		t.Fatalf("bearer: %d %s", res.StatusCode, body)
	}
	if res, body := get(t, ts.URL+"/", ""); res.StatusCode != 200 || !strings.Contains(body, "atc") {
		t.Fatalf("page should load without a token: %d", res.StatusCode)
	}
	res, _ := get(t, ts.URL+"/?token=tok", "")
	if res.StatusCode != http.StatusFound || len(res.Cookies()) == 0 || res.Cookies()[0].Value != "tok" || !res.Cookies()[0].HttpOnly {
		t.Fatalf("login link: %d %v", res.StatusCode, res.Cookies())
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/sessions", nil)
	req.AddCookie(res.Cookies()[0])
	if r, err := http.DefaultClient.Do(req); err != nil || r.StatusCode != 200 {
		t.Fatalf("cookie: %v %v", err, r)
	}
}

type seen struct {
	mu   sync.Mutex
	reqs []*http.Request
}

func (s *seen) last() *http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.reqs) == 0 {
		return nil
	}
	return s.reqs[len(s.reqs)-1]
}

func TestPeersAreMergedAndForwarded(t *testing.T) {
	var log seen
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.mu.Lock()
		log.reqs = append(log.reqs, r.Clone(r.Context()))
		log.mu.Unlock()
		if r.URL.Path == "/api/sessions" && r.Method == "GET" {
			w.Write([]byte(`[{"sessionId":"p1","host":"laptop-own-name","id":"peer0001","kind":"background","state":"working","title":"remote one"}]`))
			return
		}
		w.Write([]byte(`{"id":"peer0001"}`))
	}))
	ts := newTestServer(t, []Peer{{Name: "lap", URL: peer.URL, Token: "ptok"}}, Voice{})

	_, body := get(t, ts.URL+"/api/sessions", "tok")
	var list []sessions.Session
	json.Unmarshal([]byte(body), &list)
	hosts := map[string]string{}
	for _, s := range list {
		hosts[s.Title] = s.Host
	}
	if hosts["local one"] != "here" || hosts["remote one"] != "lap" {
		t.Fatalf("merged list hosts: %v", hosts)
	}
	if r := log.last(); r.URL.Query().Get("local") != "1" || r.Header.Get("Authorization") != "Bearer ptok" {
		t.Fatalf("peer asked without local=1 or its token: %v %v", r.URL, r.Header)
	}

	do(t, "POST", ts.URL+"/api/sessions/peer0001/stop", "tok", "")
	if r := log.last(); r.Method != "POST" || r.URL.Path != "/api/sessions/peer0001/stop" || r.Header.Get("Authorization") != "Bearer ptok" {
		t.Fatalf("stop not forwarded: %s %s %v", r.Method, r.URL, r.Header)
	}

	do(t, "POST", ts.URL+"/api/sessions?host=lap", "tok", `{"dir":"~/x"}`)
	if r := log.last(); r.URL.Path != "/api/sessions" || r.URL.Query().Has("host") {
		t.Fatalf("new session not forwarded cleanly: %s", r.URL)
	}

	if res, _ := do(t, "POST", ts.URL+"/api/sessions/loc00001/stop", "tok", ""); res.StatusCode != 200 || log.last().URL.Path == "/api/sessions/loc00001/stop" {
		t.Fatalf("a local session must not be forwarded: %d", res.StatusCode)
	}

	peer.Close()
	if res, body := do(t, "POST", ts.URL+"/api/sessions/peer0001/stop", "tok", ""); res.StatusCode != http.StatusBadGateway || !strings.Contains(body, "lap is unreachable") {
		t.Fatalf("unreachable peer: %d %s", res.StatusCode, body)
	}
}

func TestAlerts(t *testing.T) {
	prev := map[string]string{"a": sessions.Working, "b": sessions.YourTurn, "c": sessions.Working, "e": sessions.YourTurn, "f": sessions.Working}
	list := []sessions.Session{
		{SessionID: "a", Title: "A", State: sessions.YourTurn, LastReply: "All tests pass."},
		{SessionID: "b", Title: "B", State: sessions.NeedsYou, Activity: "Bash  rm -rf build"},
		{SessionID: "c", Title: "C", State: sessions.YourTurn, ID: "open0001"},
		{SessionID: "d", Title: "D", State: sessions.NeedsYou},
		{SessionID: "e", Title: "E", State: sessions.Working},
		{SessionID: "f", Title: "F", State: sessions.NeedsYou, Parked: true},
	}
	got := alerts(prev, list, func(s sessions.Session) bool { return s.ID == "open0001" })
	if len(got) != 2 {
		t.Fatalf("want 2 alerts, got %+v", got)
	}
	if got[0].Title != "A" || got[0].Body != "All tests pass." || got[0].URL != "/#/s/a" {
		t.Errorf("finished turn: %+v", got[0])
	}
	if got[1].Title != "B" || got[1].Body != "Needs you: Bash  rm -rf build" {
		t.Errorf("needs you: %+v", got[1])
	}
}

func TestVoice(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stt":
			f, _, err := r.FormFile("file")
			if err != nil || r.FormValue("model") != "whisper-1" || r.FormValue("response_format") != "verbose_json" {
				http.Error(w, "bad form", 400)
				return
			}
			b, _ := io.ReadAll(f)
			if string(b) != "RIFFfake" {
				http.Error(w, "audio not passed through", 400)
				return
			}
			w.Write([]byte(`{"text":"  merhaba dünya ","language":"turkish"}`))
		case "/llm":
			var in struct {
				Messages []struct{ Role, Content string }
			}
			json.NewDecoder(r.Body).Decode(&in)
			if len(in.Messages) != 2 || in.Messages[0].Role != "system" || in.Messages[1].Content != "long reply" {
				http.Error(w, "bad request", 400)
				return
			}
			w.Write([]byte(`{"choices":[{"message":{"content":" Short. "}}]}`))
		}
	}))
	defer up.Close()

	if res, _ := do(t, "POST", newTestServer(t, nil, Voice{}).URL+"/api/voice/stt", "tok", "RIFFfake"); res.StatusCode != http.StatusNotImplemented {
		t.Fatalf("unconfigured stt: %d", res.StatusCode)
	}
	ts := newTestServer(t, nil, Voice{STT: up.URL + "/stt", STTModel: "whisper-1", LLM: up.URL + "/llm"})
	if res, body := do(t, "POST", ts.URL+"/api/voice/stt", "tok", "RIFFfake"); res.StatusCode != 200 || !strings.Contains(body, `"text":"merhaba dünya"`) {
		t.Fatalf("stt: %d %s", res.StatusCode, body)
	}
	if res, body := do(t, "POST", ts.URL+"/api/voice/condense", "tok", `{"text":"long reply"}`); res.StatusCode != 200 || !strings.Contains(body, `"text":"Short."`) {
		t.Fatalf("condense: %d %s", res.StatusCode, body)
	}
	_, me := get(t, ts.URL+"/api/me", "tok")
	if !strings.Contains(me, `"stt":true`) || !strings.Contains(me, `"tts":false`) {
		t.Fatalf("me voice flags: %s", me)
	}
}

func TestMergeHistory(t *testing.T) {
	at := func(m int) time.Time { return time.Date(2026, 10, 1, 0, m, 0, 0, time.UTC) }
	got := mergeHistory([][]sessions.Session{
		{{Title: "a", Updated: at(1)}, {Title: "c", Updated: at(3)}},
		{{Title: "b", Updated: at(2)}, {Title: "d", Updated: at(4)}},
	}, 3)
	if len(got) != 3 || got[0].Title != "d" || got[1].Title != "c" || got[2].Title != "b" {
		t.Fatalf("got %v", got)
	}
}

func TestGuess(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"alpha", "beta", "gamma"} {
		os.Mkdir(filepath.Join(root, d), 0o755)
	}
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"choices":[{"message":{"content":"3"}}]}`))
	}))
	defer llm.Close()
	ts := newTestServer(t, nil, Voice{LLM: llm.URL}, root)
	cases := map[string][2]string{
		"crash in Beta when saving":                 {"beta", "name"},
		"https://github.com/someone/alpha/issues/3": {"alpha", "name"},
		"something vague":                           {"beta", "model"},
	}
	for text, want := range cases {
		b, _ := json.Marshal(map[string]string{"text": text})
		_, body := do(t, "POST", ts.URL+"/api/guess", "tok", string(b))
		var got struct{ Dir, By string }
		json.Unmarshal([]byte(body), &got)
		if got.Dir != filepath.Join(root, want[0]) || got.By != want[1] {
			t.Errorf("%q: got %s, want %v", text, body, want)
		}
	}
}

func TestStartWorktreeAndSend(t *testing.T) {
	bin := fakeClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	dir := t.TempDir()
	b, _ := json.Marshal(map[string]any{"dir": dir, "name": "Fix the Login bug!", "prompt": "go", "worktree": true})
	if res, body := do(t, "POST", ts.URL+"/api/sessions", "tok", string(b)); res.StatusCode != 200 {
		t.Fatalf("start: %d %s", res.StatusCode, body)
	}
	if args, _ := os.ReadFile(filepath.Join(filepath.Dir(bin), "started")); !strings.Contains(string(args), "--worktree=fix-the-login-bug-") || !strings.Contains(string(args), "--name Fix the Login bug! go") {
		t.Errorf("start args: %s", args)
	}
	if res, body := do(t, "POST", ts.URL+"/api/sessions/loc00001/send", "tok", `{"text":"hello there"}`); res.StatusCode != 200 {
		t.Fatalf("send: %d %s", res.StatusCode, body)
	}
	if sent, _ := os.ReadFile(filepath.Join(filepath.Dir(bin), "sent")); string(sent) != "\x1b[200~hello there\x1b[201~" {
		t.Errorf("sent %q", sent)
	}
}

func TestWorktreeName(t *testing.T) {
	if got := worktreeName("Fix the Login bug!"); !strings.HasPrefix(got, "fix-the-login-bug-") {
		t.Errorf("got %q", got)
	}
	if got := worktreeName(""); !strings.HasPrefix(got, "atc-") {
		t.Errorf("got %q", got)
	}
}
