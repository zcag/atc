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
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/summary"
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

func TestCrossSiteRefused(t *testing.T) {
	ts := newTestServer(t, nil, Voice{})
	post := func(origin string) int {
		req, _ := http.NewRequest("POST", ts.URL+"/api/sessions", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer tok")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode
	}
	for _, o := range []string{"null", "https://evil.example"} {
		if c := post(o); c != http.StatusForbidden {
			t.Fatalf("origin %s: %d", o, c)
		}
	}
	for _, o := range []string{"", ts.URL} {
		if c := post(o); c == http.StatusForbidden {
			t.Fatalf("origin %q refused", o)
		}
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
	prev := map[string]string{"a": sessions.Working, "b": sessions.YourTurn, "c": sessions.Working, "e": sessions.YourTurn, "f": sessions.Working,
		"g": sessions.Working, "h": sessions.Working}
	list := []sessions.Session{
		{SessionID: "a", Title: "A", State: sessions.YourTurn, LastReply: "All tests pass."},
		{SessionID: "b", Title: "B", State: sessions.NeedsYou, Activity: "Bash  rm -rf build"},
		{SessionID: "c", Title: "C", State: sessions.YourTurn, ID: "open0001"},
		{SessionID: "d", Title: "D", State: sessions.NeedsYou},
		{SessionID: "e", Title: "E", State: sessions.Working},
		{SessionID: "f", Title: "F", State: sessions.NeedsYou, Parked: true},
		{SessionID: "g", Title: "G", State: sessions.YourTurn, LastReply: "A long report…", Summarizing: true},
		{SessionID: "h", Title: "H", State: sessions.YourTurn, LastReply: "A long report…", ID: "hhhh0001", Attachable: true,
			Summary: &summary.Summary{Status: "Found: the cache is stale", Gist: []string{"Clearing it fixes the test"}, Replies: []string{"clear it", "why stale?"}}},
	}
	got, later := alerts(prev, list, func(s sessions.Session) bool { return s.ID == "open0001" })
	if len(got) != 3 {
		t.Fatalf("want 3 alerts, got %+v", got)
	}
	if got[0].Title != "A" || got[0].Body != "All tests pass." || got[0].URL != "/#/s/a" {
		t.Errorf("finished turn: %+v", got[0])
	}
	if got[1].Title != "B" || got[1].Body != "Needs you: Bash  rm -rf build" {
		t.Errorf("needs you: %+v", got[1])
	}
	if got[2].Body != "Found: the cache is stale\nClearing it fixes the test" {
		t.Errorf("summary as the body: %q", got[2].Body)
	}
	if got[2].Session != "hhhh0001" || strings.Join(got[2].Replies, "|") != "clear it|why stale?" || got[0].Replies != nil {
		t.Errorf("suggested replies ride along only with a summary that has them: %+v", got)
	}
	if len(later) != 1 || later[0].Tag != "g" {
		t.Fatalf("a turn still being summarized waits: %+v", later)
	}
}

func TestReleaseHeldPush(t *testing.T) {
	s := &Server{held: map[string]held{
		"ready": {push.Message{Tag: "ready", Body: "raw"}, time.Now().Add(time.Minute)},
		"slow":  {push.Message{Tag: "slow", Body: "raw"}, time.Now().Add(time.Minute)},
		"late":  {push.Message{Tag: "late", Body: "raw"}, time.Now().Add(-time.Second)},
		"moved": {push.Message{Tag: "moved", Body: "raw"}, time.Now().Add(time.Minute)},
	}}
	list := []sessions.Session{
		{SessionID: "ready", State: sessions.YourTurn, Summary: &summary.Summary{Status: "Done: shipped"}},
		{SessionID: "slow", State: sessions.YourTurn, Summarizing: true},
		{SessionID: "late", State: sessions.YourTurn, Summarizing: true},
		{SessionID: "moved", State: sessions.Working},
	}
	out := map[string]string{}
	for _, m := range s.release(list) {
		out[m.Tag] = m.Body
	}
	if len(out) != 2 || out["ready"] != "Done: shipped" || out["late"] != "raw" {
		t.Fatalf("released %v", out)
	}
	if _, ok := s.held["slow"]; !ok || len(s.held) != 1 {
		t.Fatalf("still held: %v", s.held)
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

func TestWidgetList(t *testing.T) {
	list := []sessions.Session{
		{SessionID: "a", Title: "A", State: sessions.NeedsYou},
		{SessionID: "b", Title: "B", State: sessions.Working, Parked: true},
		{SessionID: "c", Title: "C", State: sessions.Stopped},
		{SessionID: "d", Title: "D", State: sessions.Working, PromptAt: time.Unix(100, 0)},
	}
	got := widgetList(list)
	if len(got) != 2 || got[0].SID != "a" || got[1].SID != "d" || !got[1].Since.Equal(time.Unix(100, 0)) {
		t.Fatalf("got %+v", got)
	}
	moved := widgetList(append([]sessions.Session{}, list[0], sessions.Session{SessionID: "d", Title: "D", State: sessions.Working, PromptAt: time.Unix(200, 0)}))
	if widgetKey(got) != widgetKey(moved) {
		t.Error("a new time alone must not count as a change")
	}
}

func TestOutputFileLinks(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: fakeClaude(t)}, Index: history.New(t.TempDir()), Store: st}, Term: &attach.Hub{}, Web: fstest.MapFS{}, Token: "tok"}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	dir := filepath.Join(t.TempDir(), "my site")
	os.MkdirAll(filepath.Join(dir, "css"), 0o755)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>hi</h1>"), 0o644)
	os.WriteFile(filepath.Join(dir, "css", "a.css"), []byte("h1{}"), 0o644)
	os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("no"), 0o644)
	link := s.fileURL("sid1", filepath.Join(dir, "index.html"), time.Now().Add(time.Hour).Unix())

	res, body := get(t, ts.URL+link, "")
	if res.StatusCode != 200 || body != "<h1>hi</h1>" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("page: %d %q %v", res.StatusCode, body, res.Header)
	}
	if res, _ := get(t, ts.URL+strings.Replace(link, "index.html", "css/a.css", 1), ""); res.StatusCode != 200 {
		t.Errorf("a file next to it should load: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+strings.Replace(link, "my%20site/index.html", "secret.txt", 1), ""); res.StatusCode != 404 {
		t.Errorf("a file outside its folder must not load: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+strings.Replace(link, "/o/", "/o/x", 1), ""); res.StatusCode == 200 {
		t.Error("a forged token must not load")
	}
	old := s.fileURL("sid1", filepath.Join(dir, "index.html"), time.Now().Add(-time.Minute).Unix())
	if res, _ := get(t, ts.URL+old, ""); res.StatusCode != http.StatusGone {
		t.Errorf("expired: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+strings.Replace(link, "sid1", "sid2", 1), ""); res.StatusCode != 404 {
		t.Errorf("another session's link must not load: %d", res.StatusCode)
	}
}

func TestStartFromPreset(t *testing.T) {
	bin := fakeClaude(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "brief.md"), []byte("You are the helper."), 0o644)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st}, Term: &attach.Hub{}, Web: fstest.MapFS{}, Token: "tok", Host: "here",
		Presets: []Preset{{Name: "helper", Dir: dir, Brief: "brief.md"}}}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	if res, body := do(t, "POST", ts.URL+"/api/sessions", "tok", `{"preset":"helper","prompt":"hi"}`); res.StatusCode != 200 {
		t.Fatalf("start: %d %s", res.StatusCode, body)
	}
	args, _ := os.ReadFile(filepath.Join(filepath.Dir(bin), "started"))
	if !strings.Contains(string(args), "--append-system-prompt You are the helper. --name helper hi") {
		t.Errorf("args: %s", args)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/sessions", "tok", `{"preset":"nope"}`); res.StatusCode != 400 {
		t.Errorf("unknown preset: %d", res.StatusCode)
	}
	_, body := get(t, ts.URL+"/api/presets", "tok")
	if !strings.Contains(body, `"name":"helper"`) || !strings.Contains(body, `"host":"here"`) {
		t.Errorf("presets: %s", body)
	}

	s.Engines = []Engine{{Name: "qwen", Model: "qwen3", URL: "http://gpu:11439", Token: "secret"}}
	os.WriteFile(filepath.Join(filepath.Dir(bin), "agents.json"), []byte(`[{"id":"abcd1234","sessionId":"s9","kind":"background"}]`), 0o644)
	if res, body := do(t, "POST", ts.URL+"/api/sessions", "tok", `{"preset":"helper","engine":"qwen"}`); res.StatusCode != 200 {
		t.Fatalf("start with engine: %d %s", res.StatusCode, body)
	}
	args, _ = os.ReadFile(filepath.Join(filepath.Dir(bin), "started"))
	if !strings.Contains(string(args), `"ANTHROPIC_BASE_URL":"http://gpu:11439"`) || !strings.Contains(string(args), "--model qwen3") {
		t.Errorf("engine args: %s", args)
	}
	if e, ok := s.engineOf("s9"); !ok || e.Name != "qwen" {
		t.Errorf("engine not remembered for the new session: %+v", st.Get("s9"))
	}
	if _, body := get(t, ts.URL+"/api/engines", "tok"); !strings.Contains(body, `"name":"qwen"`) || strings.Contains(body, "secret") || strings.Contains(body, "gpu") {
		t.Errorf("engines: %s", body)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/sessions", "tok", `{"preset":"helper","engine":"nope"}`); res.StatusCode != 400 {
		t.Errorf("unknown engine: %d", res.StatusCode)
	}
}

type fakeTypist struct {
	keys    []string
	screens []string
}

func (f *fakeTypist) Key(k string) error { f.keys = append(f.keys, k); return nil }
func (f *fakeTypist) Screen() string {
	if len(f.screens) == 0 {
		return ""
	}
	s := f.screens[0]
	f.screens = f.screens[1:]
	return s
}

func TestClaudeAnswerTypesWhatTheScreenShows(t *testing.T) {
	q := func(text string, opts ...string) claude.Question {
		x := claude.Question{Question: text}
		for _, o := range opts {
			x.Options = append(x.Options, struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			}{Label: o})
		}
		return x
	}
	single, multi := "❯ 1. Red", "❯ 1. [ ] Small"
	cases := []struct {
		qs      []claude.Question
		screens []string
		ans     [][]string
		want    string
	}{
		{[]claude.Question{q("Fruit?", "Apple", "Pear")}, []string{single}, [][]string{{"Pear"}}, `["2"]`},
		{[]claude.Question{q("Fruit?", "Apple", "Pear")}, []string{single}, [][]string{{"banana"}}, `["3","banana","\r"]`},
		{[]claude.Question{q("Sizes?", "S", "M", "L"), q("Colour?", "Red", "Blue")}, []string{multi, single}, [][]string{{"S", "xl"}, {"Blue"}}, `["1","\u001b[B\u001b[B\u001b[B","xl","\u001b[B","\r","2","1"]`},
		{[]claude.Question{q("Sizes?", "S", "M")}, []string{multi}, [][]string{{"M"}}, `["2","\u001b[B\u001b[B\u001b[B","\r","1"]`},
	}
	for _, c := range cases {
		f := &fakeTypist{screens: c.screens}
		err := claudeAnswer(f, c.qs, c.ans)
		got, _ := json.Marshal(f.keys)
		if err != nil || string(got) != c.want {
			t.Errorf("%v: got %s %v, want %s", c.ans, got, err, c.want)
		}
	}
}

func TestClaudeApprovePicksYesFromTheScreen(t *testing.T) {
	for screen, want := range map[string]string{
		"Do you want to proceed?   ❯   1.   Yes    2.   No    Esc to cancel":                                `["1"]`,
		"1. Yes earlier  Do you want to proceed? ❯ 1. Yes  2. Yes, and don't ask again for git push  3. No": `["1"]`,
		"nothing asked": `null`,
	} {
		f := &fakeTypist{screens: []string{screen}}
		err := claudeApprove(f, false)
		got, _ := json.Marshal(f.keys)
		if string(got) != want || (err != nil) != (want == "null") {
			t.Errorf("%q: got %s %v, want %s", screen, got, err, want)
		}
	}
}
