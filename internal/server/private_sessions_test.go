package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/summary"
)

func TestPrivatePushSaysNothing(t *testing.T) {
	list := []sessions.Session{{SessionID: "p", Title: "my secret", State: sessions.YourTurn, Private: true, LastReply: "the secret answer",
		Activity: "x", Summary: &summary.Summary{Status: "secret status", Replies: []string{"yes"}}, Attachable: true, ID: "p0000001"}}
	got, later := alerts(map[string]string{"p": sessions.Working}, list, func(sessions.Session) bool { return false })
	if len(got) != 1 || len(later) != 0 {
		t.Fatalf("got %+v, later %+v", got, later)
	}
	if m := got[0]; m.Title != sessions.PrivateTitle || m.Body != "Your turn" || len(m.Replies) > 0 || m.Ask != nil {
		t.Errorf("push %+v", m)
	}
}

func TestAgentsDontSeePrivate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("XDG_RUNTIME_DIR", home)
	claude.SetProfiles([]claude.Profile{{Name: "private", Dir: filepath.Join(home, "keep"), Ephemeral: true}})
	t.Cleanup(func() { claude.SetProfiles(nil) })
	p, _ := claude.ProfileNamed("private")
	os.MkdirAll(filepath.Join(p.Projects(), "-x"), 0o700)
	os.WriteFile(filepath.Join(p.Projects(), "-x", "s1.jsonl"), []byte("{}\n"), 0o600)

	for path, hidden := range map[string]bool{"/api/sessions/s1/transcript": true, "/api/sessions/s1/send": true, "/api/sessions/s2/transcript": false, "/api/history": false} {
		r := httptest.NewRequest("GET", path, nil)
		if hiddenFromAgent(r, strings.Split(path, "/")) {
			t.Errorf("%s is hidden from the user", path)
		}
		r.Header.Set(client.CallerHeader, "caller")
		if got := hiddenFromAgent(r, strings.Split(path, "/")); got != hidden {
			t.Errorf("%s from an agent: hidden %v, want %v", path, got, hidden)
		}
	}
	if dir := uploadDir("s1", ""); !strings.HasPrefix(dir, p.Home()) {
		t.Errorf("a private session's upload goes to %s", dir)
	}
	if dir := uploadDir("", "private"); !strings.HasPrefix(dir, p.Home()) {
		t.Errorf("a new private session's upload goes to %s", dir)
	}
	if dir := uploadDir("s2", ""); strings.HasPrefix(dir, p.Home()) {
		t.Errorf("another session's upload goes to %s", dir)
	}
}
