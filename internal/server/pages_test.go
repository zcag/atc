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
	_, body = do(t, "POST", ts.URL+"/api/sessions/l1/pages", "tok", `{"path":"`+dir+`","name":"handover","at":"#towel"}`)
	json.Unmarshal([]byte(body), &shown)
	if shown.Page.At != "towel" || shown.Page.Ref() != "handover#towel" {
		t.Fatalf("shown at a section: %+v", shown.Page)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/sessions/l1/pages", "tok", `{"path":"`+dir+`","name":"handover","at":"a b"}`); res.StatusCode != 400 {
		t.Fatalf("an id with a space: %d", res.StatusCode)
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
	if res, _ := do(t, "POST", ts.URL+"/api/sessions/l1/pages", "tok", `{"path":"`+dir+`","open":true}`); res.StatusCode != 403 {
		t.Fatalf("a session other than the assistant opened a page on the phone: %d", res.StatusCode)
	}
}

type ran struct {
	Code           int
	Stdout, Stderr string
}

func TestPageActions(t *testing.T) {
	ts := newTestServer(t, nil, Voice{})
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "mail.html"), []byte(`<title>Mail</title>`), 0o644)
	show := func(actions string) int {
		res, _ := do(t, "POST", ts.URL+"/api/sessions/l1/pages", "tok", `{"path":"`+dir+`/mail.html","actions":`+actions+`}`)
		return res.StatusCode
	}
	run := func(body string) (int, ran) {
		res, out := do(t, "POST", ts.URL+"/api/sessions/l1/pages/mail/run", "tok", body)
		var r ran
		json.Unmarshal([]byte(out), &r)
		return res.StatusCode, r
	}
	if st := show(`{"echo":["printf","%s|"],"where":["pwd"],"fail":["sh","-c","exit 3"]}`); st != 200 {
		t.Fatalf("show: %d", st)
	}

	st, r := run(`{"action":"echo","args":["a b","; touch x","$(touch y)","*"]}`)
	if st != 200 || r.Code != 0 || r.Stdout != "a b|; touch x|$(touch y)|*|" {
		t.Fatalf("args go in order, literally: %d %+v", st, r)
	}
	for _, f := range []string{"x", "y"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			t.Fatalf("an arg reached a shell and made %s", f)
		}
	}
	if _, r := run(`{"action":"where"}`); strings.TrimSpace(r.Stdout) != dir {
		t.Fatalf("runs in the page's folder: %+v", r)
	}
	if _, r := run(`{"action":"fail"}`); r.Code != 3 {
		t.Fatalf("exit code: %+v", r)
	}
	if st, _ := run(`{"action":"rm","args":["-rf","/"]}`); st != 404 {
		t.Fatalf("undeclared action: %d", st)
	}
	show(`{}`)
	if st, _ := run(`{"action":"echo"}`); st != 404 {
		t.Fatalf("showing again replaces the actions: %d", st)
	}
	if st := show(`{"x":[]}`); st != 400 {
		t.Fatalf("an empty command: %d", st)
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
	towel := list(at.Add(2 * time.Minute))
	towel[0].Shown[0].At = "towel"
	if _, ms = pageAlerts(seen, towel, never); len(ms) != 1 || ms[0].URL != "/#/s/s1/p/handover#towel" {
		t.Fatalf("shown at a section: %+v", ms)
	}
}

func TestAssistantOpensAnotherSessionsPage(t *testing.T) {
	s, ts := hubServer(t, newFakeHub(t, "hub-sid"), nil)
	eventually(t, "hub sid", func() bool { return s.hubSID() == "hub-sid" })
	f := filepath.Join(t.TempDir(), "picks.html")
	os.WriteFile(f, []byte("<title>Picks</title>"), 0o644)
	s.Pages.Show(pages.Page{Session: "@shopping", Name: "picks", Path: f})
	open := func(sid, body string) int {
		res, _ := do(t, "POST", ts.URL+"/api/sessions/"+sid+"/open", "tok", body)
		return res.StatusCode
	}
	if st := open("l1", `{"session":"@shopping","name":"picks"}`); st != 403 {
		t.Fatalf("a session other than the assistant: %d", st)
	}
	if st := open("hub-sid", `{"session":"@shopping","name":"nope"}`); st != 404 {
		t.Fatalf("a page nobody shows: %d", st)
	}
	if st := open("hub-sid", `{"session":"@shopping","name":"picks","at":"a b"}`); st != 400 {
		t.Fatalf("a bad id: %d", st)
	}
	if st := open("hub-sid", `{"session":"@shopping","name":"picks","at":"towel"}`); st != 503 {
		t.Fatalf("an existing page, with no phone to push to: %d", st)
	}
}
