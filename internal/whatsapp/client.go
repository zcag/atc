// Package whatsapp talks to an OpenWA gateway (github.com/rmyndharis/OpenWA) on behalf of
// one WhatsApp account that only ever converses with its owner.
package whatsapp

import (
	"bytes"
	"cmp"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Client struct {
	URL, Key, Session string
	Owner             string
	OwnerIDs          []string
	Secret            string
	Hook              string
	http              *http.Client
}

func FromEnv() *Client {
	c := &Client{
		URL: strings.TrimRight(os.Getenv("ATC_WHATSAPP_URL"), "/"), Key: os.Getenv("ATC_WHATSAPP_KEY"),
		Session: os.Getenv("ATC_WHATSAPP_SESSION"),
		Secret:  os.Getenv("ATC_WHATSAPP_SECRET"), Hook: os.Getenv("ATC_WHATSAPP_HOOK"),
		http: &http.Client{Timeout: 60 * time.Second},
	}
	for _, id := range strings.Split(os.Getenv("ATC_WHATSAPP_OWNER"), ",") {
		if id = strings.TrimPrefix(strings.TrimSpace(id), "+"); id != "" {
			c.OwnerIDs = append(c.OwnerIDs, id)
		}
	}
	if len(c.OwnerIDs) > 0 {
		c.Owner = strings.TrimSuffix(c.OwnerIDs[0], "@c.us")
	}
	if c.URL == "" || c.Key == "" || c.Session == "" || c.Owner == "" || len(c.Secret) < 16 {
		return nil
	}
	return c
}

func (c *Client) OwnerChat() string { return c.Owner + "@c.us" }

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+"/api/sessions/"+c.Session+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("x-api-key", c.Key)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("openwa: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2000))
		return fmt.Errorf("openwa %s %s: %s %s", method, path, res.Status, strings.TrimSpace(string(msg)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

type Sent struct {
	MessageID string `json:"messageId"`
}

func (c *Client) Text(ctx context.Context, text, quoted string) (string, error) {
	var s Sent
	body := map[string]any{"chatId": c.OwnerChat(), "text": text}
	if quoted != "" {
		body["quotedMessageId"] = quoted
	}
	return s.MessageID, c.do(ctx, "POST", "/messages/send-text", body, &s)
}

func (c *Client) Edit(ctx context.Context, id, text string) error {
	return c.do(ctx, "POST", "/messages/edit", map[string]any{"chatId": c.OwnerChat(), "messageId": id, "body": text}, nil)
}

func (c *Client) React(ctx context.Context, chat, id, emoji string) error {
	return c.do(ctx, "POST", "/messages/react", map[string]any{"chatId": chat, "messageId": id, "emoji": emoji}, nil)
}

func (c *Client) Typing(ctx context.Context, state string) error {
	return c.do(ctx, "POST", "/chats/typing", map[string]any{"chatId": c.OwnerChat(), "state": state}, nil)
}

func (c *Client) Read(ctx context.Context, chat string) error {
	return c.do(ctx, "POST", "/chats/read", map[string]any{"chatId": chat}, nil)
}

// IsOwner says whether a sender id is the owner's: one of the configured ids, or an @lid
// that WhatsApp resolves to the owner's number.
func (c *Client) IsOwner(ctx context.Context, from, senderPhone string) bool {
	for _, id := range c.OwnerIDs {
		if from == id || from == id+"@c.us" {
			return true
		}
	}
	if !strings.HasSuffix(from, "@lid") {
		return false
	}
	if senderPhone != "" {
		return strings.TrimPrefix(senderPhone, "+") == c.Owner
	}
	p, err := c.Phone(ctx, from)
	return err == nil && p == c.Owner
}

// Media sends a file as the kind WhatsApp shows best for it: image, video, a voice note
// (ptt, already Ogg/Opus) or audio, and anything else as a document.
func (c *Client) Media(ctx context.Context, data []byte, mime, filename, caption string, ptt bool) (string, error) {
	kind := "document"
	switch {
	case ptt:
		kind = "audio"
	case strings.HasPrefix(mime, "image/") && mime != "image/svg+xml" && len(data) < 5<<20:
		kind = "image"
	case strings.HasPrefix(mime, "video/") && len(data) < 16<<20:
		kind = "video"
	case strings.HasPrefix(mime, "audio/"):
		kind = "audio"
	}
	body := map[string]any{"chatId": c.OwnerChat(), "base64": base64.StdEncoding.EncodeToString(data), "mimetype": mime}
	if kind == "document" {
		body["filename"] = cmp.Or(filename, "file")
	}
	if caption != "" && kind != "audio" {
		body["caption"] = caption
	}
	if ptt {
		body["ptt"] = true
	}
	var s Sent
	return s.MessageID, c.do(ctx, "POST", "/messages/send-"+kind, body, &s)
}

// Voice turns any audio into a WhatsApp voice note (Ogg/Opus).
func (c *Client) Voice(ctx context.Context, audio []byte) ([]byte, error) {
	var out struct{ Base64 string }
	if err := c.do(ctx, "POST", "/media/convert/voice", map[string]string{"base64": base64.StdEncoding.EncodeToString(audio)}, &out); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(out.Base64)
}

func (c *Client) Download(ctx context.Context, chat, id string) ([]byte, string, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", c.URL+"/api/sessions/"+c.Session+"/messages/"+url.PathEscape(chat)+"/"+url.PathEscape(id)+"/media", nil)
	req.Header.Set("x-api-key", c.Key)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return nil, "", fmt.Errorf("openwa media: %s", res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	return b, res.Header.Get("Content-Type"), err
}

// Phone is the number behind a contact id, which for an @lid only WhatsApp can say.
func (c *Client) Phone(ctx context.Context, contact string) (string, error) {
	var out struct{ Phone string }
	err := c.do(ctx, "GET", "/contacts/"+url.PathEscape(contact)+"/phone", nil, &out)
	return strings.TrimPrefix(out.Phone, "+"), err
}

// Verify checks OpenWA's X-OpenWA-Signature (sha256=<hex HMAC of the raw body>).
func (c *Client) Verify(body []byte, sig string) bool {
	m := hmac.New(sha256.New, []byte(c.Secret))
	m.Write(body)
	want := "sha256=" + hex.EncodeToString(m.Sum(nil))
	return hmac.Equal([]byte(want), []byte(strings.TrimSpace(sig)))
}

// EnsureHook registers the two webhooks that bring the owner's side of the chat to atc, or
// brings the ones already registered at the same URLs up to date: messages, filtered by
// sender, and reactions, edits and poll votes, filtered by chat (a sender condition drops
// reactions, which carry no sender field). The secret is write-only in OpenWA, so it is set
// on every start rather than compared.
func (c *Client) EnsureHook(ctx context.Context) error {
	if c.Hook == "" {
		return nil
	}
	var hooks []struct{ ID, URL string }
	if err := c.do(ctx, "GET", "/webhooks", nil, &hooks); err != nil {
		return err
	}
	sep := "?"
	if strings.Contains(c.Hook, "?") {
		sep = "&"
	}
	want := []struct {
		url    string
		events []string
		match  map[string]any
	}{
		{c.Hook, []string{"message.received"}, map[string]any{"field": "sender", "operator": "is", "value": c.OwnerIDs}},
		{c.Hook + sep + "changes=1", []string{"message.reaction", "message.edited", "poll.vote"}, map[string]any{"field": "chatId", "operator": "is", "value": c.OwnerIDs}},
	}
	for _, w := range want {
		body := map[string]any{
			"url": w.url, "events": w.events, "secret": c.Secret, "retryCount": 3,
			"filters": map[string]any{"conditions": []map[string]any{
				w.match,
				{"field": "isGroup", "operator": "is", "value": false},
				{"field": "fromMe", "operator": "is", "value": false},
			}},
		}
		method, path := "POST", "/webhooks"
		for _, h := range hooks {
			if h.URL == w.url {
				method, path = "PUT", "/webhooks/"+h.ID
			}
		}
		if err := c.do(ctx, method, path, body, nil); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) Poll(ctx context.Context, question string, options []string, multi bool) (string, error) {
	var s Sent
	body := map[string]any{"chatId": c.OwnerChat(), "name": question, "options": options, "allowMultipleAnswers": multi}
	return s.MessageID, c.do(ctx, "POST", "/messages/send-poll", body, &s)
}

type Event struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

type Message struct {
	ID          string `json:"id"`
	From        string `json:"from"`
	ChatID      string `json:"chatId"`
	Body        string `json:"body"`
	Type        string `json:"type"`
	Kind        string `json:"kind"`
	IsGroup     bool   `json:"isGroup"`
	FromMe      bool   `json:"fromMe"`
	SenderPhone string `json:"senderPhone"`
	Media       *struct {
		Mimetype string `json:"mimetype"`
		Filename string `json:"filename"`
		Data     string `json:"data"`
		Omitted  bool   `json:"omitted"`
	} `json:"media"`
	Quoted *struct {
		ID   string `json:"id"`
		Body string `json:"body"`
	} `json:"quotedMessage"`
	Location *struct {
		Latitude    float64 `json:"latitude"`
		Longitude   float64 `json:"longitude"`
		Description string  `json:"description"`
		Address     string  `json:"address"`
	} `json:"location"`
}

type Reaction struct {
	MessageID string `json:"messageId"`
	ChatID    string `json:"chatId"`
	Reaction  string `json:"reaction"`
	SenderID  string `json:"senderId"`
}

type Edit struct {
	MessageID string `json:"messageId"`
	ChatID    string `json:"chatId"`
	Body      string `json:"body"`
	SenderID  string `json:"senderId"`
	From      string `json:"from"`
	FromMe    bool   `json:"fromMe"`
	IsGroup   bool   `json:"isGroup"`
}

type Vote struct {
	PollMessageID   string   `json:"pollMessageId"`
	ChatID          string   `json:"chatId"`
	VoterID         string   `json:"voterId"`
	SelectedOptions []string `json:"selectedOptions"`
	PollName        string   `json:"pollName"`
	TimestampMs     int64    `json:"timestampMs"`
}
