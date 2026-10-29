package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/zcag/atc/internal/backlog"
)

func TestBacklog(t *testing.T) {
	ts := newTestServer(t, nil, Voice{})
	repo := t.TempDir()
	wt := filepath.Join(repo, ".claude", "worktrees", "x")
	os.MkdirAll(wt, 0o755)

	res, body := do(t, "POST", ts.URL+"/api/backlog", "tok", `{"dir":"`+wt+`","title":"  try   it ","prompt":" Try it, then report. ","by":"helper","from":"s1","status":"blocked","why":"the release"}`)
	var it backlog.Item
	json.Unmarshal([]byte(body), &it)
	if res.StatusCode != 200 || it.Dir != repo || it.Title != "try it" || it.Prompt != "Try it, then report." || !it.Suggested() || it.Status != backlog.Blocked || it.Why != "the release" {
		t.Fatalf("add: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/backlog", "tok", `{"dir":"`+repo+`/nope","title":"x"}`); res.StatusCode != 400 {
		t.Fatalf("a missing folder is refused: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/backlog", "tok", `{"dir":"`+repo+`","title":" ","prompt":""}`); res.StatusCode != 400 {
		t.Fatalf("an item needs a title or a prompt: %d", res.StatusCode)
	}
	if res, _ := do(t, "PATCH", ts.URL+"/api/backlog/"+it.ID, "tok", `{"status":"someday"}`); res.StatusCode != 400 {
		t.Fatalf("unknown status: %d", res.StatusCode)
	}

	_, body = do(t, "PATCH", ts.URL+"/api/backlog/"+it.ID, "tok", `{"status":"ready","accepted":true}`)
	it = backlog.Item{ID: it.ID}
	json.Unmarshal([]byte(body), &it)
	if it.Status != backlog.Ready || it.Why != "" || it.Suggested() {
		t.Fatalf("unblocked and taken: %s", body)
	}

	if res, _ := do(t, "DELETE", ts.URL+"/api/backlog/"+it.ID, "tok", ""); res.StatusCode != 200 {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	if res, _ := do(t, "DELETE", ts.URL+"/api/backlog/"+it.ID, "tok", ""); res.StatusCode != 404 {
		t.Fatalf("delete twice: %d", res.StatusCode)
	}
	if _, body := get(t, ts.URL+"/api/backlog", "tok"); body != "[]\n" && body != "[]" {
		t.Fatalf("empty list: %q", body)
	}
}

func TestPutAside(t *testing.T) {
	ts := newTestServer(t, nil, Voice{})
	for range 2 {
		if res, body := do(t, "POST", ts.URL+"/api/sessions/l1/aside", "tok", `{}`); res.StatusCode != 200 {
			t.Fatalf("aside: %d %s", res.StatusCode, body)
		}
	}
	var items []backlog.Item
	_, body := get(t, ts.URL+"/api/backlog", "tok")
	json.Unmarshal([]byte(body), &items)
	if len(items) != 1 || !items[0].Aside || items[0].SID != "l1" || items[0].Session != "loc00001" || items[0].Title != "local one" || items[0].Dir != "/tmp" {
		t.Fatalf("one item that remembers the session: %s", body)
	}
}
