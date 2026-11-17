package server

import (
	"cmp"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// inbound is a message from outside atc that waits on the user: who wrote, on what, the gist and where to read it.
type inbound struct {
	ID, Sender, Network, Where, Text, Link string
}

const inboundSecretKey = "ATC_INBOUND_SECRET"

func inboundSecret() string { return os.Getenv(inboundSecretKey) }

// inboundHook takes a message waiting on the user from another app: flat fields or an event envelope with them under
// "data". It only feeds the assistant's news (no push: the app that sent it notifies the user itself).
func (s *Server) inboundHook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if secret := inboundSecret(); secret != "" && !signed(secret, body, r.Header) {
		log.Printf("inbound: refused a delivery with a bad signature from %s", s.clientIP(r))
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	m, ok, err := parseInbound(body, os.Getenv("ATC_INBOUND_LINK"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !ok {
		reply(w, map[string]bool{"taken": false})
		return
	}
	fresh := s.feed.message(m, time.Now())
	if fresh && s.hubUp() {
		go s.Hub.Notice(context.Background())
	}
	reply(w, map[string]bool{"taken": fresh})
}

// signed checks an HMAC-SHA256 of the raw body in any *-Signature header, as "sha256=<hex>" or bare hex.
func signed(secret string, body []byte, h http.Header) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	for k, vs := range h {
		if k = strings.ToLower(k); !strings.HasSuffix(k, "-signature") && !strings.HasSuffix(k, "-signature-256") {
			continue
		}
		for _, v := range vs {
			if hmac.Equal([]byte(want), []byte(strings.TrimPrefix(strings.TrimSpace(v), "sha256="))) {
				return true
			}
		}
	}
	return false
}

// parseInbound reads a delivery; ok is false for what isn't a message waiting on the user (another event type, a
// test ping, waitsOnYou false, a screened sender). link is a template filled from the fields: "https://x/{conversationId}".
func parseInbound(body []byte, link string) (m inbound, ok bool, err error) {
	var top map[string]any
	if err := json.Unmarshal(body, &top); err != nil {
		return m, false, err
	}
	d := top
	if data, isMap := top["data"].(map[string]any); isMap {
		d = data
	}
	if t, _ := top["type"].(string); t != "" && !strings.HasPrefix(t, "message") {
		return m, false, nil
	}
	if v, set := d["waitsOnYou"].(bool); set && !v {
		return m, false, nil
	}
	if v, _ := d["screener"].(bool); v {
		return m, false, nil
	}
	str := func(keys ...string) string {
		for _, k := range keys {
			if v := field(d, k); v != "" {
				return v
			}
		}
		return ""
	}
	m = inbound{
		Sender:  str("sender", "from", "conversationTitle"),
		Network: str("network", "channel", "account"),
		Text:    str("text", "body", "preview"),
		Link:    cmp.Or(str("link", "url"), fill(link, d)),
	}
	if sub := str("subject"); sub != "" {
		m.Text = strings.TrimSpace(sub + ": " + m.Text)
	}
	if t := str("conversationTitle", "conversation"); t != "" && t != m.Sender {
		m.Where = t
	}
	m.ID = cmp.Or(str("messageId"), field(top, "id"), m.Network+"|"+m.Sender+"|"+m.Text)
	if m.Sender == "" {
		return m, false, fmt.Errorf("sender is required")
	}
	return m, true, nil
}

func field(d map[string]any, k string) string {
	switch v := d[k].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return fmt.Sprint(int64(v))
	}
	return ""
}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

func fill(tmpl string, d map[string]any) string {
	if tmpl == "" {
		return ""
	}
	missing := false
	out := placeholder.ReplaceAllStringFunc(tmpl, func(p string) string {
		v := field(d, p[1:len(p)-1])
		missing = missing || v == ""
		return v
	})
	if missing {
		return ""
	}
	return out
}
