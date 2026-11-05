package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

// trustingClaude behaves as the real one was measured to: --bg refuses until the config records a
// yes, and plain claude writes that yes on the answer, then stays up as a session until stopped.
func trustingClaude(t *testing.T) (bin, home string) {
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	dir := t.TempDir()
	bin = filepath.Join(dir, "claude")
	os.WriteFile(bin, []byte(`#!/bin/sh
case "$1" in
agents)
  if [ -f "`+dir+`/started" ]; then echo '[{"id":"abcd1234","sessionId":"m1","kind":"background","pid":1,"state":"done","startedAt":1000}]'; else echo '[]'; fi ;;
--bg)
  echo tried >> "`+dir+`/tried"
  if grep -q hasTrustDialogAccepted "$HOME/.claude.json" 2>/dev/null; then echo "$@" > "`+dir+`/started"; echo "backgrounded · abcd1234"
  elif [ "$PWD" = "$HOME" ]; then echo "Workspace not trusted. The home directory is trusted one session at a time"; exit 1
  else echo "Workspace not trusted. Run claude once"; exit 1; fi ;;
"")
  stty -echo; echo "Is this a project you trust?"; read -r answer
  [ "$answer" = yes ] || exit 0
  printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}' "$(pwd -P)" > "$HOME/.claude.json"
  exec sleep 100 ;;
esac
`), 0o755)
	return bin, home
}

func dialTrust(t *testing.T, base, dir string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(base, "http", "ws", 1)+"/api/trust/term?id=t&dir="+url.QueryEscape(dir),
		&websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer tok"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func readUntil(t *testing.T, conn *websocket.Conn, want string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var seen string
	for {
		typ, b, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for %q, saw %q: %v", want, seen, err)
		}
		if typ == websocket.MessageBinary {
			seen += string(b)
		} else {
			var c attach.Control
			if json.Unmarshal(b, &c) == nil && c.Type == "exit" {
				seen += "<exit>"
			}
		}
		if strings.Contains(seen, want) {
			return
		}
	}
}

func startIn(t *testing.T, base, dir string) (*http.Response, string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"dir": dir, "prompt": "the first message"})
	return do(t, "POST", base+"/api/sessions", "tok", string(b))
}

func TestAcceptingTheTrustPromptLetsTheSessionStart(t *testing.T) {
	bin, _ := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	dir := t.TempDir()

	res, body := startIn(t, ts.URL, dir)
	if res.StatusCode != http.StatusConflict || !strings.Contains(body, "does not trust") {
		t.Fatalf("start in an untrusted folder: %d %s", res.StatusCode, body)
	}
	if q, _ := url.ParseQuery(res.Header.Get(claude.UntrustedHeader)); q.Get("dir") != dir {
		t.Errorf("the refusal names %q, want %q", q.Get("dir"), dir)
	}
	if _, body := get(t, ts.URL+"/api/trust?dir="+url.QueryEscape(dir), "tok"); !strings.Contains(body, `"untrusted"`) {
		t.Errorf("state: %s", body)
	}

	conn := dialTrust(t, ts.URL, dir)
	readUntil(t, conn, "you trust?")
	conn.Write(context.Background(), websocket.MessageBinary, []byte("yes\n"))
	readUntil(t, conn, "<exit>")

	if res, body := startIn(t, ts.URL, dir); res.StatusCode != 200 {
		t.Fatalf("start after the yes: %d %s", res.StatusCode, body)
	}
	if args, _ := os.ReadFile(filepath.Join(filepath.Dir(bin), "started")); !strings.Contains(string(args), "the first message") {
		t.Errorf("start args: %s", args)
	}
	if _, body := get(t, ts.URL+"/api/trust?dir="+url.QueryEscape(filepath.Join(dir)), "tok"); !strings.Contains(body, `"trusted"`) {
		t.Errorf("state: %s", body)
	}
}

func TestSayingNoToTheTrustPromptStartsNothing(t *testing.T) {
	bin, home := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	dir := t.TempDir()
	conn := dialTrust(t, ts.URL, dir)
	readUntil(t, conn, "you trust?")
	conn.Write(context.Background(), websocket.MessageBinary, []byte("no\n"))
	readUntil(t, conn, "<exit>")
	if res, body := startIn(t, ts.URL, dir); res.StatusCode != http.StatusConflict {
		t.Fatalf("start after the no: %d %s", res.StatusCode, body)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude.json")); err == nil {
		t.Error("a no wrote Claude's config")
	}
}

func TestTrustedFolderGetsNoClaude(t *testing.T) {
	bin, home := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	dir := t.TempDir()
	real, _ := filepath.EvalSymlinks(dir)
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"projects":{"`+real+`":{"hasTrustDialogAccepted":true}}}`), 0o644)
	readUntil(t, dialTrust(t, ts.URL, dir), "<exit>")
}

func TestAssistantWithoutAHubStartsInItsOwnFolder(t *testing.T) {
	bin, home := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	res, body := do(t, "POST", ts.URL+"/api/assist", "tok", "")
	q, _ := url.ParseQuery(res.Header.Get(claude.UntrustedHeader))
	want := filepath.Join(home, ".local/share/atc/assistant")
	if res.StatusCode != http.StatusConflict || q.Get("dir") != want {
		t.Fatalf("it should ask for %s: %d %v %s", want, res.StatusCode, q, body)
	}
	if !exists(want) {
		t.Error("its folder was not made")
	}
}

func TestHomeFolderHasNoPromptToOffer(t *testing.T) {
	bin, home := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	res, body := startIn(t, ts.URL, home)
	if res.StatusCode != http.StatusBadRequest || !strings.Contains(body, "Pick a project folder") || res.Header.Get(claude.UntrustedHeader) != "" {
		t.Errorf("start in home: %d %s", res.StatusCode, body)
	}
	if res, _ := get(t, ts.URL+"/api/trust/term?dir="+url.QueryEscape(home), "tok"); res.StatusCode != http.StatusBadRequest {
		t.Errorf("a terminal for home: %d", res.StatusCode)
	}
	if _, body := get(t, ts.URL+"/api/trust?dir="+url.QueryEscape(home), "tok"); !strings.Contains(body, `"home"`) {
		t.Errorf("state: %s", body)
	}
	if _, body := get(t, ts.URL+"/api/trust?dir=/no/such/folder", "tok"); !strings.Contains(body, `""`) {
		t.Errorf("state of a missing folder: %s", body)
	}
}

func untrustedAgents(t *testing.T) (*Server, *httptest.Server, string, Agent) {
	t.Helper()
	bin, _ := trustingClaude(t)
	root, _ := filepath.EvalSymlinks(t.TempDir())
	writeAgent(t, root, "mail", `{"host":"here","prompt":"Check mail.","every":"5m"}`)
	writeAgent(t, root, "own", `{"host":"here","dir":"`+t.TempDir()+`"}`)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Web: fstest.MapFS{}, Token: "tok", Host: "here", AgentsDir: root, StateDir: t.TempDir()}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	a, _ := s.agentNamed("mail")
	return s, ts, filepath.Dir(bin), a
}

func TestAScheduledAgentInAnUntrustedFolderAsksOnceThenWaits(t *testing.T) {
	s, ts, dir, a := untrustedAgents(t)
	tries := func() int {
		b, _ := os.ReadFile(filepath.Join(dir, "tried"))
		return strings.Count(string(b), "tried")
	}
	s.tick(a)
	if tries() != 1 {
		t.Fatalf("the first wake-up asks Claude once, got %d", tries())
	}
	if !s.waitingOnTrust(a) {
		t.Fatal("it was not told")
	}
	s.tick(a)
	s.tick(a)
	if tries() != 1 {
		t.Errorf("the schedule kept retrying: %d", tries())
	}
	if !(&Server{StateDir: s.StateDir}).waitingOnTrust(a) {
		t.Error("a restart forgets it told you, so it would tell you again")
	}

	_, body := get(t, ts.URL+"/api/agents", "tok")
	var list []AgentView
	json.Unmarshal([]byte(body), &list)
	for _, v := range list {
		switch {
		case v.Name == "mail" && (v.Trust == nil || v.Trust.State != "untrusted" || v.Trust.Parent != s.AgentsDir || !v.Next.IsZero()):
			t.Errorf("mail's row: %+v", v.Trust)
		case v.Name == "own" && (v.Trust == nil || v.Trust.Parent != ""):
			t.Errorf("an agent with its own dir has no shared folder to offer: %+v", v.Trust)
		}
	}

	os.WriteFile(filepath.Join(os.Getenv("HOME"), ".claude.json"), []byte(`{"projects":{"`+s.AgentsDir+`":{"hasTrustDialogAccepted":true}}}`), 0o600)
	s.tick(a)
	if tries() != 2 || s.waitingOnTrust(a) {
		t.Errorf("a yes for the folder of all agents wakes it on its next round: %d tries", tries())
	}
	_, body = get(t, ts.URL+"/api/agents", "tok")
	list = nil
	json.Unmarshal([]byte(body), &list)
	for _, v := range list {
		if v.Name == "mail" && v.Trust != nil {
			t.Errorf("still asking: %+v", v.Trust)
		}
	}
}

func TestStartingAnUntrustedAgentSaysWhatToDo(t *testing.T) {
	s, ts, _, a := untrustedAgents(t)
	for _, url_ := range []string{"/api/agents/mail/message", "/api/agents/mail/message?from=grafana"} {
		res, body := do(t, "POST", ts.URL+url_, "tok", `{"text":"hello"}`)
		q, _ := url.ParseQuery(res.Header.Get(claude.UntrustedHeader))
		if res.StatusCode != http.StatusConflict || q.Get("dir") != a.dir() || q.Get("parent") != s.AgentsDir || q.Get("host") != "here" || !strings.Contains(body, "@mail can't start") {
			t.Errorf("%s: %d %v %s", url_, res.StatusCode, q, body)
		}
	}
	if !s.waitingOnTrust(a) {
		t.Error("a webhook with nobody at the screen did not count as telling")
	}
}
