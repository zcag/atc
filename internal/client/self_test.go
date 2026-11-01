package client

import (
	"strings"
	"testing"

	"github.com/zcag/atc/internal/sessions"
)

func TestRelayedApproval(t *testing.T) {
	t.Setenv("CLAUDE_CODE_SESSION_ID", "me")
	hub := []sessions.Session{{SessionID: "me", ID: "me", Kind: "hub", Agent: "assistant", Title: "assistant", Attachable: true}}
	text, err := Signed(hub, Sign{Approved: true}, "merge it")
	if err != nil || !strings.Contains(text, relayedApproval) {
		t.Fatalf("assistant: %q %v", text, err)
	}
	if text, _ = Signed(hub, Sign{}, "merge it"); strings.Contains(text, relayedApproval) {
		t.Fatalf("not approved but marked: %q", text)
	}
	other := []sessions.Session{{SessionID: "me", ID: "me", Kind: "background", Title: "x", Attachable: true}}
	if _, err = Signed(other, Sign{Approved: true}, "merge it"); err == nil {
		t.Fatal("a non-assistant session relayed an approval")
	}
	guests := []sessions.Session{{SessionID: "me", ID: "me", Kind: "hub", Agent: "guests", Title: "guests", Attachable: true}}
	if _, err = Signed(guests, Sign{Approved: true}, "deploy it"); err == nil {
		t.Fatal("the guests' conversation relayed an approval")
	}
	if text, _ = Signed(guests, Sign{Report: true}, "check it"); !strings.Contains(text, "send tool to me") {
		t.Fatalf("a session the guests start must report to them, not the assistant: %q", text)
	}
}
