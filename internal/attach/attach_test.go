package attach

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type tviewer struct {
	c   *websocket.Conn
	ctl chan Control
	out chan string
}

func connect(t *testing.T, url string, cols, rows int) *tviewer {
	t.Helper()
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	c, _, err := websocket.Dial(context.Background(), url+sep+"cols="+itoa(cols)+"&rows="+itoa(rows), nil)
	if err != nil {
		t.Fatal(err)
	}
	v := &tviewer{c: c, ctl: make(chan Control, 16), out: make(chan string, 64)}
	go func() {
		for {
			typ, b, err := c.Read(context.Background())
			if err != nil {
				close(v.ctl)
				return
			}
			if typ == websocket.MessageText {
				var m Control
				json.Unmarshal(b, &m)
				v.ctl <- m
			} else {
				v.out <- string(b)
			}
		}
	}()
	return v
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func (v *tviewer) next(t *testing.T) Control {
	t.Helper()
	select {
	case m, ok := <-v.ctl:
		if !ok {
			t.Fatal("connection closed")
		}
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("no control message")
	}
	return Control{}
}

func (v *tviewer) until(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	var got strings.Builder
	for {
		select {
		case s := <-v.out:
			got.WriteString(s)
			if strings.Contains(got.String(), want) {
				return
			}
		case <-deadline:
			t.Fatalf("never saw %q in %q", want, got.String())
		}
	}
}

func TestOwnershipInputAndExit(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte("#!/bin/sh\nstty -echo\nwhile read l; do echo \"got:$l\"; [ \"$l\" = quit ] && exit 3; done\n"), 0o755)
	h := &Hub{Bin: bin}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Serve(w, r, "s1") }))
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http")

	a := connect(t, url, 100, 30)
	if m := a.next(t); !m.Owner || m.Cols != 100 || m.Viewers != 1 {
		t.Fatalf("first viewer: %+v", m)
	}
	b := connect(t, url, 60, 20)
	if m := b.next(t); !m.Owner || m.Cols != 60 || m.Viewers != 2 {
		t.Fatalf("newest viewer should own the size: %+v", m)
	}
	if m := a.next(t); m.Owner || m.Cols != 60 {
		t.Fatalf("older viewer should follow: %+v", m)
	}
	if !h.Viewing("s1") || h.Viewing("other") {
		t.Fatal("Viewing is wrong")
	}

	a.c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"claim"}`))
	if m := a.next(t); !m.Owner || m.Cols != 100 {
		t.Fatalf("claim: %+v", m)
	}
	b.next(t)

	b.c.Write(context.Background(), websocket.MessageBinary, []byte("hello\n"))
	if m := b.next(t); !m.Owner {
		t.Fatalf("typing should take ownership: %+v", m)
	}
	b.until(t, "got:hello")

	a.c.Write(context.Background(), websocket.MessageBinary, []byte("quit\n"))
	for {
		m := a.next(t)
		if m.Type == "exit" {
			if m.Code != 3 {
				t.Fatalf("exit code: %+v", m)
			}
			break
		}
	}
}

func TestHiddenViewers(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte("#!/bin/sh\nstty -echo\nwhile read l; do echo \"got:$l\"; done\n"), 0o755)
	h := &Hub{Bin: bin}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Serve(w, r, "s1") }))
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http")

	a := connect(t, url, 100, 30)
	a.next(t)
	b := connect(t, url+"?hidden=1", 60, 20)
	if m := b.next(t); m.Owner || m.Cols != 100 {
		t.Fatalf("a hidden viewer must not take the size: %+v", m)
	}
	a.next(t)
	a.c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"hidden"}`))
	time.Sleep(100 * time.Millisecond)
	if h.Viewing("s1") {
		t.Fatal("only hidden viewers left, so nobody is looking")
	}
	b.c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"visible"}`))
	for {
		if m := b.next(t); m.Owner && m.Cols == 60 {
			break
		}
	}
	if !h.Viewing("s1") {
		t.Fatal("a visible viewer is looking")
	}
}

func TestReconnectKeepsTheOwner(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte("#!/bin/sh\nstty -echo\nwhile read l; do echo \"got:$l\"; done\n"), 0o755)
	h := &Hub{Bin: bin}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Serve(w, r, "s1") }))
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http")

	desk := connect(t, url, 160, 50)
	desk.next(t)
	phone := connect(t, url+"?reconnect=1", 40, 30)
	if m := phone.next(t); m.Owner || m.Cols != 160 {
		t.Fatalf("a reconnecting screen must not take the size: %+v", m)
	}
	if m := desk.next(t); !m.Owner || m.Cols != 160 {
		t.Fatalf("the desk keeps the size: %+v", m)
	}
}
