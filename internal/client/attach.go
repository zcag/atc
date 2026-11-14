package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/coder/websocket"
	"github.com/muesli/cancelreader"
	"golang.org/x/term"
)

type control struct {
	Type string `json:"type"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

const detachKey = 0x1a

func (c *Client) dial(path string, out int) (*websocket.Conn, error) {
	cols, rows, err := term.GetSize(out)
	if err != nil {
		cols, rows = 120, 40
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, fmt.Sprintf("%s%scols=%d&rows=%d", c.URL, path, cols, rows),
		&websocket.DialOptions{HTTPClient: &http.Client{Transport: c.tr}, HTTPHeader: http.Header{"Authorization": {"Bearer " + c.Token}}})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	return conn, nil
}

func (c *Client) Attach(id string) error {
	if err := c.terminal("/api/sessions/" + id + "/attach?"); err != nil {
		return fmt.Errorf("cannot attach to %s: %w", id, err)
	}
	return nil
}

func (c *Client) terminal(path string) error {
	in, out := int(os.Stdin.Fd()), int(os.Stdout.Fd())
	conn, err := c.dial(path, out)
	if err != nil {
		return err
	}
	old, err := term.MakeRaw(in)
	if err != nil {
		conn.CloseNow()
		return err
	}
	defer term.Restore(in, old)
	stdin, err := cancelreader.NewReader(os.Stdin)
	if err != nil {
		conn.CloseNow()
		return err
	}
	keys, quit, typed := make(chan []byte), make(chan struct{}), make(chan struct{})
	defer func() {
		close(quit)
		stdin.Cancel()
		<-typed
		stdin.Close()
	}()
	go func() {
		defer close(typed)
		buf := make([]byte, 4096)
		for {
			n, err := stdin.Read(buf)
			if n > 0 {
				select {
				case keys <- bytes.Clone(buf[:n]):
				case <-quit:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	winch := make(chan os.Signal, 1)
	notifyResize(winch)
	defer signal.Stop(winch)

	for {
		if pump(conn, keys, winch, out) {
			return nil
		}
		os.Stdout.WriteString("\r\n\x1b[2m[atc] connection lost, reconnecting… (Ctrl+Z leaves; the session keeps running)\x1b[0m\r\n")
		if conn = c.redial(path, out, keys); conn == nil {
			return nil
		}
	}
}

func (c *Client) redial(path string, out int, keys <-chan []byte) *websocket.Conn {
	deadline := time.Now().Add(5 * time.Minute)
	for wait := time.Second; time.Now().Before(deadline); wait = min(wait*2, 10*time.Second) {
		select {
		case k := <-keys:
			if bytes.IndexByte(k, detachKey) >= 0 {
				return nil
			}
		case <-time.After(wait):
			if conn, err := c.dial(path, out); err == nil {
				return conn
			}
		}
	}
	os.Stdout.WriteString("\r\n\x1b[2m[atc] could not reconnect for 5 minutes, giving up\x1b[0m\r\n")
	return nil
}

func pump(conn *websocket.Conn, keys <-chan []byte, winch <-chan os.Signal, out int) (exited bool) {
	defer conn.CloseNow()
	ctx := context.Background()
	ended := make(chan bool, 1)
	go func() {
		for {
			typ, b, err := conn.Read(ctx)
			if err != nil {
				ended <- false
				return
			}
			if typ == websocket.MessageBinary {
				os.Stdout.Write(b)
				continue
			}
			var m control
			if json.Unmarshal(b, &m) == nil && m.Type == "exit" {
				ended <- true
				return
			}
		}
	}()
	for {
		select {
		case exited := <-ended:
			return exited
		case k := <-keys:
			if conn.Write(ctx, websocket.MessageBinary, k) != nil {
				return <-ended
			}
		case <-winch:
			if cols, rows, err := term.GetSize(out); err == nil {
				b, _ := json.Marshal(control{Type: "resize", Cols: cols, Rows: rows})
				conn.Write(ctx, websocket.MessageText, b)
			}
		}
	}
}

func (c *Client) Detached(id, title string) string {
	list, err := c.Live()
	if err != nil {
		return fmt.Sprintf("detached from %s (%v)", title, err)
	}
	for _, s := range list {
		if s.ID == id && s.Attachable {
			return fmt.Sprintf("detached from %s, it keeps running. atc attach %s to return", title, id)
		}
	}
	return fmt.Sprintf("detached from %s, it is no longer running", title)
}
