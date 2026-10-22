package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

const DefaultAddr = "127.0.0.1:7272"

type Client struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	http  *http.Client
}

func ConfigDir() string {
	if d := os.Getenv("ATC_CONFIG_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "atc")
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".config", "atc")
}

func loginPath() string { return filepath.Join(ConfigDir(), "client.json") }

func ServerTokenPath() string { return filepath.Join(ConfigDir(), "token") }

func Load() *Client {
	c := &Client{}
	if b, err := os.ReadFile(loginPath()); err == nil {
		json.Unmarshal(b, c)
	}
	if v := os.Getenv("ATC_URL"); v != "" {
		c.URL = v
	}
	if v := os.Getenv("ATC_TOKEN"); v != "" {
		c.Token = v
	}
	if c.URL == "" {
		c.URL = "http://" + DefaultAddr
	}
	if c.Token == "" {
		if b, err := os.ReadFile(ServerTokenPath()); err == nil {
			c.Token = strings.TrimSpace(string(b))
		}
	}
	c.URL = strings.TrimRight(c.URL, "/")
	c.http = &http.Client{Timeout: 60 * time.Second}
	return c
}

func SaveLogin(u, token string) error {
	os.MkdirAll(ConfigDir(), 0o700)
	b, _ := json.MarshalIndent(Client{URL: strings.TrimRight(u, "/"), Token: token}, "", "  ")
	return os.WriteFile(loginPath(), b, 0o600)
}

func (c *Client) do(method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.URL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach atc at %s: %w", c.URL, err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(res.Body)
		return fmt.Errorf("%s: %s", res.Status, strings.TrimSpace(string(msg)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *Client) ServerHome() string {
	var me struct{ Home string }
	if c.do("GET", "/api/me", nil, &me) != nil || me.Home == "" {
		h, _ := os.UserHomeDir()
		return h
	}
	return me.Home
}

func (c *Client) Live() (list []sessions.Session, err error) {
	return list, c.do("GET", "/api/sessions", nil, &list)
}

func (c *Client) History(q, dir string, limit int) (list []sessions.Session, err error) {
	v := url.Values{"q": {q}, "dir": {dir}, "limit": {fmt.Sprint(limit)}}
	return list, c.do("GET", "/api/history?"+v.Encode(), nil, &list)
}

type Dir struct {
	Path   string `json:"path"`
	Recent bool   `json:"recent"`
}

func (c *Client) Dirs() (list []Dir, err error) { return list, c.do("GET", "/api/dirs", nil, &list) }

type idReply struct {
	ID string `json:"id"`
}

func (c *Client) Start(dir, name, prompt string) (string, error) {
	var r idReply
	err := c.do("POST", "/api/sessions", map[string]string{"dir": dir, "name": name, "prompt": prompt}, &r)
	return r.ID, err
}

func (c *Client) Resume(sid string) (string, error) {
	var r idReply
	err := c.do("POST", "/api/sessions/"+sid+"/resume", nil, &r)
	return r.ID, err
}

func (c *Client) Stop(id string) error   { return c.do("POST", "/api/sessions/"+id+"/stop", nil, nil) }
func (c *Client) Remove(id string) error { return c.do("DELETE", "/api/sessions/"+id, nil, nil) }

func (c *Client) Patch(sid string, fields map[string]any) error {
	return c.do("PATCH", "/api/sessions/"+sid, fields, nil)
}

func (c *Client) Events(ctx context.Context, fn func([]sessions.Session)) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.URL+"/api/events", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach atc at %s: %w", c.URL, err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("events: %s", res.Status)
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(nil, 16<<20)
	event, data := "", ""
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			var list []sessions.Session
			if event == "sessions" && json.Unmarshal([]byte(data), &list) == nil {
				fn(list)
			}
			event, data = "", ""
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data += strings.TrimPrefix(line[5:], " ")
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}
