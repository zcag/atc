package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
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
agents) echo '[]' ;;
--bg)
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
	if got, _ := url.PathUnescape(res.Header.Get(claude.UntrustedHeader)); got != dir {
		t.Errorf("the refusal names %q, want %q", got, dir)
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
