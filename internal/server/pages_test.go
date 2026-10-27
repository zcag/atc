package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/sessions"
)

func TestShowPage(t *testing.T) {
	ts := newTestServer(t, nil, Voice{})
	dir := filepath.Join(t.TempDir(), "handover")
	os.MkdirAll(filepath.Join(dir, "img"), 0o755)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte(`<title>PR &amp; notes</title><img src="img/a.png">`), 0o644)
	os.WriteFile(filepath.Join(dir, "img", "a.png"), []byte("png"), 0o644)

	res, body := do(t, "POST", ts.URL+"/api/sessions/l1/pages", "tok", `{"path":"`+dir+`","note":"look"}`)
	if res.StatusCode != 200 {
		t.Fatalf("show: %d %s", res.StatusCode, body)
	}
	var shown struct {
		Page    pages.Page
		Created bool
	}
	json.Unmarshal([]byte(body), &shown)
	if !shown.Created || shown.Page.Name != "handover" || shown.Page.Title != "PR & notes" || shown.Page.Kind != "html" {
		t.Fatalf("shown %+v", shown)
	}

	if res, body := get(t, ts.URL+shown.Page.URL, ""); res.StatusCode != 200 || !strings.Contains(body, "<title>") {
		t.Fatalf("page file: %d %s", res.StatusCode, body)
	}
	img := strings.TrimSuffix(shown.Page.URL, "index.html") + "img/a.png"
	if res, body := get(t, ts.URL+img, ""); res.StatusCode != 200 || body != "png" {
		t.Fatalf("relative image: %d %s", res.StatusCode, body)
	}

	_, body = do(t, "POST", ts.URL+"/api/sessions/l1/pages", "tok", `{"path":"`+dir+`/index.html","name":"handover","title":"Handover"}`)
	json.Unmarshal([]byte(body), &shown)
	if shown.Created || shown.Page.Title != "Handover" || shown.Page.Note != "look" {
		t.Fatalf("showing again should replace, keeping the note: %+v", shown)
	}

	if res, _ := do(t, "PUT", ts.URL+"/api/sessions/l1/pages/handover/state", "tok", `{"ticks":2}`); res.StatusCode != 200 {
		t.Fatalf("set state: %d", res.StatusCode)
	}
	if _, body := get(t, ts.URL+"/api/sessions/l1/pages/handover/state", "tok"); body != `{"ticks":2}` {
		t.Fatalf("state %s", body)
	}

	var live []sessions.Session
	_, body = get(t, ts.URL+"/api/sessions", "tok")
	json.Unmarshal([]byte(body), &live)
	if len(live) != 1 || len(live[0].Shown) != 1 || live[0].Shown[0].URL == "" {
		t.Fatalf("session list carries its pages: %s", body)
	}

	if res, _ := do(t, "DELETE", ts.URL+"/api/sessions/l1/pages/handover", "tok", ""); res.StatusCode != 200 {
		t.Fatalf("take down: %d", res.StatusCode)
	}
	if _, body := get(t, ts.URL+"/api/pages", "tok"); strings.TrimSpace(body) != "[]" {
		t.Fatalf("all pages after take down: %s", body)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/sessions/l1/pages", "tok", `{"path":"`+t.TempDir()+`"}`); res.StatusCode != 400 {
		t.Fatalf("a folder without index.html: %d", res.StatusCode)
	}
}

func TestPageAlerts(t *testing.T) {
	at := time.Now()
	list := func(shown time.Time) []sessions.Session {
		return []sessions.Session{{SessionID: "s1", Title: "work", Shown: []pages.Page{{Name: "handover", Title: "PR", Note: "look", Shown: shown}}}}
	}
	never := func(sessions.Session) bool { return false }
	seen, ms := pageAlerts(nil, list(at), never)
	if len(ms) != 0 {
		t.Fatalf("first look sets the baseline, got %v", ms)
	}
	if _, ms = pageAlerts(seen, list(at), never); len(ms) != 0 {
		t.Fatalf("unchanged page pushed: %v", ms)
	}
	_, ms = pageAlerts(seen, list(at.Add(time.Minute)), never)
	if len(ms) != 1 || ms[0].Body != "Showing you PR: look" || ms[0].URL != "/#/s/s1/p/handover" {
		t.Fatalf("re-shown page: %+v", ms)
	}
	if _, ms = pageAlerts(seen, list(at.Add(time.Minute)), func(sessions.Session) bool { return true }); len(ms) != 0 {
		t.Fatalf("pushed while you watch the session: %v", ms)
	}
}
