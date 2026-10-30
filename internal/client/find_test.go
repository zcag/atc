package client

import (
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
