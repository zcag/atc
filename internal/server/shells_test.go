package server

import (
	"context"
	"encoding/json"
	"net/http"
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
	"github.com/zcag/atc/internal/shells"
	"github.com/zcag/atc/internal/store"
)

func TestShellSurvivesItsTab(t *testing.T) {
	if _, err := shells.Tmux(); err != nil {
		t.Skip(err)
	}
	dir, _ := os.MkdirTemp("/tmp", "atcsh")
	defer os.RemoveAll(dir)
	sh := &shells.Shells{Socket: filepath.Join(dir, "s.sock")}
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: fakeClaude(t)}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{}, Shells: sh, Web: fstest.MapFS{}, Token: "tok", Host: "here"}
	ts := serve(t, s)

	if res, _ := do(t, "POST", ts.URL+"/api/shells", "", `{"dir":"`+dir+`"}`); res.StatusCode != 401 {
		t.Fatalf("a shell without logging in: %d", res.StatusCode)
	}
	res, body := do(t, "POST", ts.URL+"/api/shells", "tok", `{"dir":"`+dir+`"}`)
	if res.StatusCode != 200 {
		t.Fatalf("start: %d %s", res.StatusCode, body)
	}
	var got shells.Shell
	json.Unmarshal([]byte(body), &got)
	defer sh.Kill(context.Background(), got.ID)

	attachTo := func() *websocket.Conn {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/shells/"+got.ID+"/attach?cols=80&rows=24",
			&websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer tok"}}})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	until := func(c *websocket.Conn, want string) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var seen strings.Builder
		for !strings.Contains(seen.String(), want) {
			typ, b, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("never saw %q: %v\n%s", want, err, seen.String())
			}
			if typ == websocket.MessageBinary {
				seen.Write(b)
			}
		}
	}
	c := attachTo()
	c.Write(context.Background(), websocket.MessageBinary, []byte("export MARK=kept; echo ok-$((40+2))\r"))
	until(c, "ok-42")
	c.Close(websocket.StatusNormalClosure, "")

	time.Sleep(300 * time.Millisecond)
	if _, body := get(t, ts.URL+"/api/shells", "tok"); !strings.Contains(body, got.ID) {
		t.Fatalf("gone after its tab closed: %s", body)
	}
	c = attachTo()
	c.Write(context.Background(), websocket.MessageBinary, []byte("echo again-$MARK\r"))
	until(c, "again-kept")
	c.Close(websocket.StatusNormalClosure, "")

	if res, _ := do(t, "DELETE", ts.URL+"/api/shells/"+got.ID, "tok", ""); res.StatusCode != 200 {
		t.Fatalf("close: %d", res.StatusCode)
	}
	if _, body := get(t, ts.URL+"/api/shells", "tok"); strings.Contains(body, got.ID) {
		t.Fatalf("still listed after closing: %s", body)
	}
	if res, _ := get(t, ts.URL+"/api/shells/"+got.ID+"/attach", "tok"); res.StatusCode != http.StatusGone {
		t.Fatalf("attach to a closed shell: %d", res.StatusCode)
	}
	if res, _ := do(t, "DELETE", ts.URL+"/api/shells/nothex!!", "tok", ""); res.StatusCode != 404 {
		t.Fatalf("a bad id: %d", res.StatusCode)
	}
}
