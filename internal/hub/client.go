package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Client is how atc talks to the hub.
type Client struct {
	URL  string
	HTTP *http.Client
}

func NewClient(url string) *Client {
	return &Client{URL: strings.TrimRight(url, "/"), HTTP: &http.Client{Timeout: 10 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	hc := c.HTTP
	if path == "/call" {
		hc = &http.Client{}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("hub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("hub: %s", strings.TrimSpace(string(b)))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (c *Client) Status(ctx context.Context) (st Status, err error) {
	return st, c.do(ctx, "GET", "/status", nil, &st)
}

// Send is "sent", or "held" until the turn the phone is part of ends.
func (c *Client) Send(ctx context.Context, channel, text string) (string, error) {
	var r struct{ Status string }
	return r.Status, c.do(ctx, "POST", "/message", map[string]string{"channel": channel, "text": text}, &r)
}

func (c *Client) Interrupt(ctx context.Context, channel string) (bool, error) {
	var r struct{ Interrupted bool }
	return r.Interrupted, c.do(ctx, "POST", "/interrupt", map[string]string{"channel": channel}, &r)
}

func (c *Client) Reset(ctx context.Context) error { return c.do(ctx, "POST", "/reset", nil, nil) }

func (c *Client) Call(ctx context.Context, r CallReq) (string, error) {
	var out struct{ Outcome string }
	return out.Outcome, c.do(ctx, "POST", "/call", r, &out)
}

// Watch calls fn with every event of every channel until the connection drops.
func (c *Client) Watch(ctx context.Context, fn func(Event)) error {
	ws, _, err := websocket.Dial(ctx, strings.Replace(c.URL, "http", "ws", 1)+"/events", nil)
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	ws.SetReadLimit(4 << 20)
	for {
		var e Event
		if err := wsjson.Read(ctx, ws, &e); err != nil {
			return err
		}
		fn(e)
	}
}
