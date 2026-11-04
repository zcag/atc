package whatsapp

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsOwner(t *testing.T) {
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/contacts/111@lid/phone"):
			w.Write([]byte(`{"phone":"12025550100"}`))
		case strings.Contains(r.URL.Path, "/contacts/222@lid/phone"):
			w.Write([]byte(`{"phone":"12025550150"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gw.Close()
	c := &Client{URL: gw.URL, Session: "s", Owner: "12025550100", OwnerIDs: []string{"12025550100", "10000000000011@lid"}, http: gw.Client()}
	ctx := context.Background()
	for from, want := range map[string]bool{
		"12025550100@c.us":   true,
		"10000000000011@lid": true,
		"111@lid":            true,
		"222@lid":            false,
		"333@lid":            false,
		"12025550150@c.us":   false,
		"12025550100@g.us":   false,
		"12025550100-1@g.us": false,
	} {
		if got := c.IsOwner(ctx, from, ""); got != want {
			t.Errorf("IsOwner(%s) = %v, want %v", from, got, want)
		}
	}
	if c.IsOwner(ctx, "444@lid", "12025550150") || !c.IsOwner(ctx, "444@lid", "+12025550100") {
		t.Error("senderPhone is not what decides an @lid sender")
	}
}

func TestVerify(t *testing.T) {
	c := &Client{Secret: "0123456789abcdef0123"}
	body := []byte(`{"event":"message.received"}`)
	m := hmac.New(sha256.New, []byte(c.Secret))
	m.Write(body)
	good := "sha256=" + hex.EncodeToString(m.Sum(nil))
	if !c.Verify(body, good) || c.Verify(body, "") || c.Verify(append(body, ' '), good) || c.Verify(body, strings.TrimPrefix(good, "sha256=")) {
		t.Error("Verify accepts a wrong signature or refuses the right one")
	}
}
