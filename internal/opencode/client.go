package opencode

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const prefix = "ses_"

func IsID(id string) bool { return strings.HasPrefix(id, prefix) }

var ErrNotFound = errors.New("not found")

type Session struct {
	ID        string `json:"id"`
	ParentID  string `json:"parentID,omitempty"`
	Directory string `json:"directory"`
	Title     string `json:"title"`
	Model     struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
	} `json:"model"`
	Time struct {
		Created  int64  `json:"created"`
		Updated  int64  `json:"updated"`
		Archived *int64 `json:"archived,omitempty"`
	} `json:"time"`
}

type Message struct {
	Info struct {
		ID         string `json:"id"`
		Role       string `json:"role"`
		ModelID    string `json:"modelID"`
		ProviderID string `json:"providerID"`
		Model      struct {
			ProviderID string `json:"providerID"`
			ModelID    string `json:"modelID"`
		} `json:"model"`
		Time struct {
			Created   int64 `json:"created"`
			Completed int64 `json:"completed"`
		} `json:"time"`
		Tokens struct {
			Input  int `json:"input"`
			Output int `json:"output"`
			Cache  struct {
				Read  int `json:"read"`
				Write int `json:"write"`
			} `json:"cache"`
		} `json:"tokens"`
	} `json:"info"`
	Parts []Part `json:"parts"`
}

type Part struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Text      string `json:"text"`
	Synthetic bool   `json:"synthetic"`
	Ignored   bool   `json:"ignored"`
	Tool      string `json:"tool"`
	State     struct {
		Status string          `json:"status"`
		Input  json.RawMessage `json:"input"`
		Output string          `json:"output"`
		Time   struct {
			Start int64 `json:"start"`
		} `json:"time"`
	} `json:"state"`
}

type Client struct {
	URL string
	hc  http.Client
}

func (c *Client) do(ctx context.Context, method, path string, q url.Values, body, out any) (http.Header, error) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	u := strings.TrimRight(c.URL, "/") + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, r)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("opencode %s %s: %w", method, path, ErrNotFound)
	}
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 4<<10))
		return nil, fmt.Errorf("opencode %s %s: %s %s", method, path, res.Status, bytes.TrimSpace(msg))
	}
	if out == nil || res.StatusCode == http.StatusNoContent {
		return res.Header, nil
	}
	return res.Header, json.NewDecoder(res.Body).Decode(out)
}

func in(dir string) url.Values {
	if dir == "" {
		return nil
	}
	return url.Values{"directory": {dir}}
}

func (c *Client) Sessions(ctx context.Context, max int) ([]Session, error) {
	var all []Session
	q := url.Values{"roots": {"true"}, "limit": {"200"}}
	for len(all) < max {
		var page []Session
		h, err := c.do(ctx, "GET", "/experimental/session", q, nil, &page)
		if err != nil {
			return all, err
		}
		all = append(all, page...)
		next := h.Get("x-next-cursor")
		if next == "" || len(page) == 0 {
			break
		}
		q.Set("cursor", next)
	}
	return all, nil
}

func (c *Client) Session(ctx context.Context, sid string) (Session, error) {
	var s Session
	_, err := c.do(ctx, "GET", "/session/"+sid, nil, nil, &s)
	return s, err
}

func (c *Client) Messages(ctx context.Context, sid string, limit int) ([]Message, error) {
	var q url.Values
	if limit > 0 {
		q = url.Values{"limit": {strconv.Itoa(limit)}}
	}
	var ms []Message
	_, err := c.do(ctx, "GET", "/session/"+sid+"/message", q, nil, &ms)
	return ms, err
}

func (c *Client) Create(ctx context.Context, dir, title string) (Session, error) {
	body := map[string]any{}
	if title != "" {
		body["title"] = title
	}
	var s Session
	_, err := c.do(ctx, "POST", "/session", in(dir), body, &s)
	return s, err
}

type Prompt struct {
	Text  string
	Model string
	Brief string
}

func (c *Client) Prompt(ctx context.Context, sid, dir string, p Prompt) error {
	var parts []map[string]any
	if p.Brief != "" {
		parts = append(parts, map[string]any{"type": "text", "text": p.Brief, "synthetic": true})
	}
	if p.Text != "" {
		parts = append(parts, map[string]any{"type": "text", "text": p.Text})
	}
	body := map[string]any{"parts": parts, "noReply": p.Text == ""}
	if provider, model, ok := strings.Cut(p.Model, "/"); ok {
		body["model"] = map[string]string{"providerID": provider, "modelID": model}
	}
	_, err := c.do(ctx, "POST", "/session/"+sid+"/prompt_async", in(dir), body, nil)
	return err
}

func (c *Client) Abort(ctx context.Context, sid, dir string) error {
	_, err := c.do(ctx, "POST", "/session/"+sid+"/abort", in(dir), nil, nil)
	return err
}

func (c *Client) Busy(ctx context.Context, dir string) (map[string]bool, error) {
	var st map[string]struct {
		Type string `json:"type"`
	}
	if _, err := c.do(ctx, "GET", "/session/status", in(dir), nil, &st); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for sid, s := range st {
		out[sid] = s.Type != "idle"
	}
	return out, nil
}

func (c *Client) Branch(ctx context.Context, dir string) string {
	var v struct {
		Branch string `json:"branch"`
	}
	c.do(ctx, "GET", "/vcs", in(dir), nil, &v)
	return v.Branch
}

type Ask struct {
	ID         string     `json:"id"`
	SessionID  string     `json:"sessionID"`
	Questions  []Question `json:"questions,omitempty"`
	Permission string     `json:"permission,omitempty"`
	Patterns   []string   `json:"patterns,omitempty"`
	Key        string     `json:"key,omitempty"`
}

func (a Ask) Fingerprint() string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s", a.Permission, strings.Join(a.Patterns, "\x00"))
	for _, q := range a.Questions {
		fmt.Fprintf(h, "\x01%s", q.Question)
		for _, o := range q.Options {
			fmt.Fprintf(h, "\x02%s", o.Label)
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

type Question struct {
	Question string `json:"question"`
	Header   string `json:"header,omitempty"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description,omitempty"`
	} `json:"options"`
	Multiple bool `json:"multiple,omitempty"`
	Custom   bool `json:"custom,omitempty"`
}

func (a Ask) Activity() string {
	if a.Permission != "" {
		return strings.TrimSpace(toolName(a.Permission) + "  " + strings.Join(a.Patterns, " "))
	}
	b, _ := json.Marshal(map[string]any{"questions": a.Questions})
	return strings.TrimSpace("AskUserQuestion  " + detail(b))
}

func (c *Client) Asks(ctx context.Context, dir string) (map[string][]Ask, error) {
	var qs, ps []Ask
	if _, err := c.do(ctx, "GET", "/permission", in(dir), nil, &ps); err != nil {
		return nil, err
	}
	if _, err := c.do(ctx, "GET", "/question", in(dir), nil, &qs); err != nil {
		return nil, err
	}
	out := map[string][]Ask{}
	for _, a := range append(ps, qs...) {
		out[a.SessionID] = append(out[a.SessionID], a)
	}
	return out, nil
}

type Answer struct {
	Answers [][]string `json:"answers,omitempty"`
	Reply   string     `json:"reply,omitempty"`
	Reject  bool       `json:"reject,omitempty"`
}

func (c *Client) Answer(ctx context.Context, dir, id string, a Answer) error {
	var err error
	switch {
	case strings.HasPrefix(id, "per"):
		if a.Reject {
			a.Reply = "reject"
		}
		_, err = c.do(ctx, "POST", "/permission/"+id+"/reply", in(dir), map[string]string{"reply": a.Reply}, nil)
	case a.Reject:
		_, err = c.do(ctx, "POST", "/question/"+id+"/reject", in(dir), nil, nil)
	default:
		_, err = c.do(ctx, "POST", "/question/"+id+"/reply", in(dir), map[string]any{"answers": a.Answers}, nil)
	}
	return err
}

type Event struct {
	Directory string
	Type      string
	SessionID string
	Status    string
}

func (c *Client) Watch(ctx context.Context, on func(Event)) {
	for ctx.Err() == nil {
		c.watch(ctx, on)
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

func (c *Client) watch(ctx context.Context, on func(Event)) {
	req, _ := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(c.URL, "/")+"/global/event", nil)
	res, err := c.hc.Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	for sc.Scan() {
		data, ok := bytes.CutPrefix(sc.Bytes(), []byte("data: "))
		if !ok {
			continue
		}
		var e struct {
			Directory string `json:"directory"`
			Payload   struct {
				Type       string `json:"type"`
				Properties struct {
					SessionID string `json:"sessionID"`
					Status    struct {
						Type string `json:"type"`
					} `json:"status"`
				} `json:"properties"`
			} `json:"payload"`
		}
		if json.Unmarshal(data, &e) == nil {
			on(Event{e.Directory, e.Payload.Type, e.Payload.Properties.SessionID, e.Payload.Properties.Status.Type})
		}
	}
}
