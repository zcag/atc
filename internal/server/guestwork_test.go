package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGuestWorkStartsOnlyInTheGuestsFolder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.MkdirAll(filepath.Join(home, "guests", "sam"), 0o755)
	s := &Server{}
	for _, req := range []startReq{
		{Dir: home, guest: true},
		{Dir: filepath.Join(home, "guests", "sam"), Worktree: true, guest: true},
	} {
		if _, err := s.startSession(t.Context(), req); err == nil || !strings.Contains(err.Error(), "guests") {
			t.Errorf("%+v: %v", req, err)
		}
	}
	r := httptest.NewRequest("POST", "/api/sessions", nil)
	if s.guestCaller(r) {
		t.Error("a request with no caller counts as the guests'")
	}
	if !strings.Contains(strings.Join(guestWorkerArgs, " "), "mcp__openwa") {
		t.Error("a guest worker keeps the WhatsApp tools")
	}
}
