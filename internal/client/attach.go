package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"

	"github.com/coder/websocket"
	"github.com/muesli/cancelreader"
	"golang.org/x/term"
)

type control struct {
	Type string `json:"type"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

func (c *Client) Attach(id string) error {
	in, out := int(os.Stdin.Fd()), int(os.Stdout.Fd())
	cols, rows, err := term.GetSize(out)
	if err != nil {
		cols, rows = 120, 40
	}
	ctx := context.Background()
	conn, _, err := websocket.Dial(ctx, fmt.Sprintf("%s/api/sessions/%s/attach?cols=%d&rows=%d", c.URL, id, cols, rows),
		&websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + c.Token}}})
	if err != nil {
		return fmt.Errorf("cannot attach to %s: %w", id, err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)

	old, err := term.MakeRaw(in)
	if err != nil {
		return err
	}
	defer term.Restore(in, old)
	stdin, err := cancelreader.NewReader(os.Stdin)
	if err != nil {
		return err
	}
	done, typed := make(chan struct{}), make(chan struct{})
	defer func() {
		stdin.Cancel()
		<-typed
		stdin.Close()
	}()
	go func() {
		defer close(done)
		for {
			typ, b, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				os.Stdout.Write(b)
				continue
			}
			var m control
			if json.Unmarshal(b, &m) == nil && m.Type == "exit" {
				return
			}
		}
	}()
	go func() {
		defer close(typed)
		buf := make([]byte, 4096)
		for {
			n, err := stdin.Read(buf)
			if n > 0 && conn.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
				return
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
		select {
		case <-done:
			return nil
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
