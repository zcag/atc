package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/zcag/atc/internal/backlog"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/pair"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/summary"
)

const DefaultAddr = "127.0.0.1:7272"

type Client struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	CA    string `json:"ca,omitempty"`
	http  *http.Client
	tr    http.RoundTripper
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
	c.tr = pair.Transport(c.CA)
	c.http = &http.Client{Timeout: 60 * time.Second, Transport: c.tr}
	return c
}

func SaveLogin(u, token, ca string) error {
	os.MkdirAll(ConfigDir(), 0o700)
	b, _ := json.MarshalIndent(Client{URL: strings.TrimRight(u, "/"), Token: token, CA: ca}, "", "  ")
	return os.WriteFile(loginPath(), b, 0o600)
}

// Caps asks the server for the feature list, briefly: `atc doctor` does the checks itself when no server answers.
func (c *Client) Caps(out any) error {
	short := *c
	short.http = &http.Client{Timeout: 10 * time.Second}
	return short.do("GET", "/api/caps", nil, out)
}

// Pairing is a one-time code to let a new device in, as text. url overrides the address it carries.
func (c *Client) Pairing(url string) (text string, err error) {
	var out struct{ Payload string }
	err = c.do("POST", "/api/pair", map[string]string{"url": url}, &out)
	return out.Payload, err
}

func (c *Client) do(method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	var res *http.Response
	for try := 0; ; try++ {
		if s, ok := rd.(*bytes.Reader); ok {
			s.Seek(0, io.SeekStart)
		}
		req, err := http.NewRequest(method, c.URL+path, rd)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.Token)
		req.Header.Set("Content-Type", "application/json")
		if res, err = c.http.Do(req); err == nil {
			break
		}
		if try == 5 || !(method == "GET" || errors.Is(err, syscall.ECONNREFUSED)) {
			return fmt.Errorf("cannot reach atc at %s: %w", c.URL, err)
		}
		time.Sleep(1500 * time.Millisecond)
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

type Me struct {
	Host  string   `json:"host"`
	Home  string   `json:"home"`
	Hosts []string `json:"hosts"`
	Peers []struct {
		Name  string `json:"name"`
		Error string `json:"error"`
	} `json:"peers"`
}

func (c *Client) Me() Me {
	var me Me
	if c.do("GET", "/api/me", nil, &me) != nil || me.Home == "" {
		me.Home, _ = os.UserHomeDir()
	}
	return me
}

func (c *Client) ServerHome() string { return c.Me().Home }

func (c *Client) Live() (list []sessions.Session, err error) {
	return list, c.do("GET", "/api/sessions", nil, &list)
}

// Recent is Live as of the server's last poll when that is a few seconds old at most: for looking, not acting.
func (c *Client) Recent() (list []sessions.Session, err error) {
	return list, c.do("GET", "/api/sessions?recent=1", nil, &list)
}

func (c *Client) History(q, dir string, limit int) (list []sessions.Session, err error) {
	v := url.Values{"q": {q}, "dir": {dir}, "limit": {fmt.Sprint(limit)}}
	return list, c.do("GET", "/api/history?"+v.Encode(), nil, &list)
}

type Dir struct {
	Path   string `json:"path"`
	Recent bool   `json:"recent"`
}

func (c *Client) Dirs(host string) (list []Dir, err error) {
	path := "/api/dirs"
	if host != "" {
		path += "?host=" + url.QueryEscape(host)
	}
	return list, c.do("GET", path, nil, &list)
}

type idReply struct {
	ID string `json:"id"`
}

func (c *Client) Start(dir, name, prompt string) (string, error) {
	return c.StartOn("", dir, name, prompt, false)
}

func (c *Client) StartOn(host, dir, name, prompt string, worktree bool) (string, error) {
	return c.Begin(host, map[string]any{"dir": dir, "name": name, "prompt": prompt, "worktree": worktree})
}

func (c *Client) Begin(host string, req map[string]any) (string, error) {
	var r idReply
	path := "/api/sessions"
	if host != "" {
		path += "?host=" + url.QueryEscape(host)
	}
	err := c.do("POST", path, req, &r)
	return r.ID, err
}

func (c *Client) Backlog() (items []backlog.Item, err error) {
	return items, c.do("GET", "/api/backlog", nil, &items)
}

// Shelve sends a session to the backlog: stopped and off the list, its item resuming it.
func (c *Client) Shelve(sid, title string) (it backlog.Item, err error) {
	return it, c.do("POST", "/api/sessions/"+sid+"/aside", map[string]string{"title": title}, &it)
}

func (c *Client) AddBacklog(host string, req map[string]any) (it backlog.Item, err error) {
	path := "/api/backlog"
	if host != "" {
		path += "?host=" + url.QueryEscape(host)
	}
	return it, c.do("POST", path, req, &it)
}

func (c *Client) PatchBacklog(host, id string, fields map[string]any) (it backlog.Item, err error) {
	path := "/api/backlog/" + id
	if host != "" {
		path += "?host=" + url.QueryEscape(host)
	}
	return it, c.do("PATCH", path, fields, &it)
}

type Preset struct {
	Name  string `json:"name"`
	Dir   string `json:"dir"`
	Brief string `json:"brief,omitempty"`
	Host  string `json:"host,omitempty"`
}

type Agent struct {
	Name  string `json:"name"`
	Title string `json:"title,omitempty"`
	Host  string `json:"host"`
	Share *struct {
		Page  string `json:"page"`
		About string `json:"about,omitempty"`
	} `json:"share,omitempty"`
	Badge    any    `json:"badge,omitempty"`
	Headline string `json:"headline,omitempty"`
}

func (c *Client) Agents() (list []Agent, err error) {
	return list, c.do("GET", "/api/agents", nil, &list)
}

func (c *Client) Presets() (ps []Preset, err error) {
	return ps, c.do("GET", "/api/presets", nil, &ps)
}

func (c *Client) StartPreset(name, prompt string) (string, string, error) {
	ps, err := c.Presets()
	if err != nil {
		return "", "", err
	}
	for _, p := range ps {
		if p.Name == name {
			id, err := c.Begin(p.Host, map[string]any{"preset": name, "prompt": prompt})
			return id, p.Dir, err
		}
	}
	var names []string
	for _, p := range ps {
		names = append(names, p.Name)
	}
	if len(names) == 0 {
		return "", "", fmt.Errorf("no presets defined; add them to presets.json in the server's config folder")
	}
	return "", "", fmt.Errorf("no preset named %q (have: %s)", name, strings.Join(names, ", "))
}

func (c *Client) Resume(sid string) (string, error) {
	var r idReply
	err := c.do("POST", "/api/sessions/"+sid+"/resume", nil, &r)
	return r.ID, err
}

// Message wakes an agent with text: its conversation, resumed or started as needed.
func (c *Client) Message(agent, text string) (string, error) {
	var r struct{ ID string }
	return r.ID, c.do("POST", "/api/agents/"+url.PathEscape(agent)+"/message", map[string]string{"text": text}, &r)
}

// Send types text into a session. From inside a Claude session it says which one sent it,
// so the hub hears it as another session rather than the user typing.
func (c *Client) Send(id, text string) error {
	return c.do("POST", "/api/sessions/"+id+"/send", map[string]string{"text": text, "from": os.Getenv("CLAUDE_CODE_SESSION_ID")}, nil)
}

func (c *Client) Call(req map[string]any) (string, error) {
	var r struct{ Outcome string }
	waits := *c
	waits.http = &http.Client{}
	return r.Outcome, waits.do("POST", "/api/call", req, &r)
}

func (c *Client) Show(sid string, req map[string]any) (r struct {
	Page    pages.Page `json:"page"`
	Created bool       `json:"created"`
	Link    string     `json:"link"`
}, err error) {
	return r, c.do("POST", "/api/sessions/"+url.PathEscape(sid)+"/pages", req, &r)
}

func (c *Client) Notify(sid string, req map[string]any) (string, error) {
	var r struct{ OK string }
	return r.OK, c.do("POST", "/api/sessions/"+url.PathEscape(sid)+"/notify", req, &r)
}

func (c *Client) OpenPage(sid string, req map[string]any) (r struct{ OK, Link string }, err error) {
	return r, c.do("POST", "/api/sessions/"+url.PathEscape(sid)+"/open", req, &r)
}

func (c *Client) Pages(sid string) (list []pages.Page, err error) {
	return list, c.do("GET", "/api/sessions/"+url.PathEscape(sid)+"/pages", nil, &list)
}

func (c *Client) HidePage(sid, name string) error {
	return c.do("DELETE", "/api/sessions/"+url.PathEscape(sid)+"/pages/"+url.PathEscape(name), nil, nil)
}

func (c *Client) PageState(sid, name string) (st json.RawMessage, err error) {
	return st, c.do("GET", "/api/sessions/"+url.PathEscape(sid)+"/pages/"+url.PathEscape(name)+"/state", nil, &st)
}

func (c *Client) SetPageState(sid, name string, st json.RawMessage) error {
	return c.do("PUT", "/api/sessions/"+url.PathEscape(sid)+"/pages/"+url.PathEscape(name)+"/state", st, nil)
}

func (c *Client) Transcript(sid string) (p history.Page, err error) {
	return p, c.do("GET", "/api/sessions/"+sid+"/transcript", nil, &p)
}

func (c *Client) Turns(sid string) (turns []history.Turn, err error) {
	var r struct {
		Turns []history.Turn `json:"turns"`
	}
	err = c.do("GET", "/api/sessions/"+url.PathEscape(sid)+"/turns", nil, &r)
	return r.Turns, err
}

type Summary struct {
	Summary     *summary.Summary `json:"summary"`
	Summarizing bool             `json:"summarizing"`
}

func (c *Client) Summary(sid string, wait int, again bool) (s Summary, err error) {
	method := "GET"
	if again {
		method = "POST"
	}
	return s, c.do(method, fmt.Sprintf("/api/sessions/%s/summary?wait=%d", sid, min(wait, 50)), nil, &s)
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
	res, err := (&http.Client{Transport: c.tr}).Do(req)
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

func (c *Client) Guests() (map[string]string, error) {
	var r map[string]string
	return r, c.do("GET", "/api/whatsapp/guests", nil, &r)
}

func (c *Client) GuestEdit(op, name, number string) error {
	return c.do("POST", "/api/whatsapp/guests", map[string]string{"op": op, "name": name, "number": number}, nil)
}

func (c *Client) WhatsApp(req map[string]any) ([]string, error) {
	var r struct{ Sent []string }
	return r.Sent, c.do("POST", "/api/whatsapp/send", req, &r)
}

// Feed is what changed in atc after seq since, or with full how things stand now: one short try,
// since the assistant's message waits on it.
func (c *Client) Feed(since int64, full bool) (text string, seq int64, err error) {
	u := fmt.Sprintf("%s/api/feed?since=%d", c.URL, since)
	if full {
		u += "&full=1"
	}
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", since, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := (&http.Client{Timeout: 700 * time.Millisecond, Transport: c.tr}).Do(req)
	if err != nil {
		return "", since, err
	}
	defer res.Body.Close()
	var r struct {
		Seq  int64  `json:"seq"`
		Text string `json:"text"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(res.Body).Decode(&r) != nil {
		return "", since, fmt.Errorf("feed: %s", res.Status)
	}
	return r.Text, r.Seq, nil
}
