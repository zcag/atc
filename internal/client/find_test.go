package client

import (
	"testing"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

func TestResolveApp(t *testing.T) {
	now := time.Now()
	pool := []sessions.Session{
		{SessionID: "old", App: "email", Updated: now.Add(-time.Hour)},
		{SessionID: "new", App: "email", Updated: now},
		{SessionID: "other", Title: "email"},
	}
	if s, err := Resolve("app:email", pool); err != nil || s.SessionID != "new" {
		t.Fatalf("app:email = %v %v", s.SessionID, err)
	}
	if _, err := Resolve("app:invoice", pool); err == nil {
		t.Fatal("an app with no run should fail")
	}
}
