package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func lineRig(t *testing.T, open OpenLine) (*Hub, *httptest.Server) {
	exe, _ := os.Executable()
	t.Setenv("HUB_FAKE_CLAUDE", "1")
	h := New(Config{Bin: exe, Dir: t.TempDir(), State: t.TempDir(), OpenLine: open,
		Mode: func(ch string) string { return "MODE " + ch }, LineMode: func(ch string) string { return "LINE MODE " + ch }})
	if err := h.Start(); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h.Handler())
	t.Cleanup(func() { srv.Close(); h.Stop() })
	return h, srv
}

func dialAt(t *testing.T, srv *httptest.Server, path string) *conn {
	ws, _, err := websocket.Dial(context.Background(), strings.Replace(srv.URL, "http", "ws", 1)+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &conn{t, ws, make(chan Event, 256)}
	go func() {
		for {
			var e Event
			if wsjson.Read(context.Background(), ws, &e) != nil {
				close(c.ev)
				return
			}
			c.ev <- e
		}
	}()
	t.Cleanup(func() { ws.CloseNow() })
	return c
}

func lines(t *testing.T, srv *httptest.Server) []Line {
	resp, err := http.Get(srv.URL + "/lines")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []Line
	json.NewDecoder(resp.Body).Decode(&out)
	return out
}

func TestLineTalksThenClosesWhenTheCallLeaves(t *testing.T) {
	sid := NewID()
	_, srv := lineRig(t, func(name string) (int, []byte, error) {
		b, _ := json.Marshal(map[string]any{"session": sid, "dir": t.TempDir(), "title": "Focus"})
		return 200, b, nil
	})
	resp, err := http.Post(srv.URL+"/lines/focus", "application/json", nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("open: %v %v", resp.Status, err)
	}
	if got := lines(t, srv); len(got) != 1 || got[0].Name != "focus" || got[0].Session != sid {
		t.Fatalf("lines = %+v", got)
	}
	c := dialAt(t, srv, "/lines/focus/ws?channel=phone")
	c.send("message", "hello")
	if got := said(c.until("done")); !strings.Contains(got, "echo: hello") {
		t.Fatalf("said %q", got)
	}
	c.ws.Close(websocket.StatusNormalClosure, "")
	deadline := time.Now().Add(10 * time.Second)
	for len(lines(t, srv)) > 0 {
		if time.Now().After(deadline) {
			t.Fatal("the line stayed open after the call left")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestLineRefusedIsPassedOn(t *testing.T) {
	_, srv := lineRig(t, func(string) (int, []byte, error) {
		return http.StatusConflict, []byte(`{"why":"busy","title":"Focus","activity":"running tests"}`), nil
	})
	resp, err := http.Post(srv.URL+"/lines/focus", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]string
	json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode != http.StatusConflict || body["activity"] != "running tests" {
		t.Fatalf("%v %v", resp.Status, body)
	}
	if got := lines(t, srv); len(got) != 0 {
		t.Fatalf("lines = %+v", got)
	}
}

func TestCallKnocksWhileOnALine(t *testing.T) {
	h, srv := lineRig(t, nil)
	h.cfg.Call = CallConfig{URL: "http://127.0.0.1:1", Number: "1"}
	c := dialAt(t, srv, "/ws?channel=phone")
	c.send("line", "focus")
	for h.Status().OnLine != "focus" {
		time.Sleep(10 * time.Millisecond)
	}
	out, err := h.Call(context.Background(), CallReq{Reason: "the build broke"})
	if err != nil || out != Knocked {
		t.Fatalf("call = %v %v", out, err)
	}
	got := c.until("knock")
	if got[len(got)-1].Text != "the build broke" {
		t.Fatalf("knock = %+v", got)
	}
	c.send("line", "")
	for h.Status().OnLine != "" {
		time.Sleep(10 * time.Millisecond)
	}
	c.send("message", "back")
	c.until("done")
	if h.Status().Call != "" {
		t.Fatalf("the knock's reason was not delivered: %+v", h.Status())
	}
}
