package client

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

func TestResolveAgent(t *testing.T) {
	now := time.Now()
	pool := []sessions.Session{
		{SessionID: "old", Agent: "email", Updated: now.Add(-time.Hour)},
		{SessionID: "new", Agent: "email", Updated: now},
		{SessionID: "other", Title: "email"},
	}
	if s, err := Resolve("@email", pool); err != nil || s.SessionID != "new" {
		t.Fatalf("@email = %v %v", s.SessionID, err)
	}
	if _, err := Resolve("@invoice", pool); err == nil {
		t.Fatal("an agent with no conversation should fail")
	}
}

func TestFindOldPast(t *testing.T) {
	var past []sessions.Session
	for i := range 150 {
		past = append(past, sessions.Session{SessionID: fmt.Sprintf("%08d-past", i), Title: fmt.Sprintf("past %d", i)})
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out := []sessions.Session{}
		if r.URL.Path == "/api/history" {
			q := r.URL.Query().Get("q")
			for _, s := range past {
				if strings.Contains(s.SessionID+" "+s.Title, q) && len(out) < 100 {
					out = append(out, s)
				}
			}
		}
		json.NewEncoder(w).Encode(out)
	}))
	defer srv.Close()
	c := &Client{URL: srv.URL, http: srv.Client()}
	for _, q := range []string{"00000149", "00000149-past", "past 149"} {
		if s, err := c.Find(q, true); err != nil || s.SessionID != "00000149-past" {
			t.Fatalf("%q = %q %v", q, s.SessionID, err)
		}
	}
	if s, err := c.Find("2", true); err != nil || s.SessionID != "00000001-past" {
		t.Fatalf("index 2 = %q %v", s.SessionID, err)
	}
}
