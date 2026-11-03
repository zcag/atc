package server

import (
	"encoding/json"
	"testing"
	"time"
)

func TestLookIsSharedWithPeers(t *testing.T) {
	far, farTS, _, _ := agentServer(t)
	here, ts, _, _ := agentServer(t)
	here.fleet.peers = []Peer{{Name: "far", URL: farTS.URL, Token: "tok"}}

	if res, _ := do(t, "PUT", ts.URL+"/api/look", "tok", `{"scheme":"dark","theme":"../etc"}`); res.StatusCode != 400 {
		t.Fatalf("a theme name that is not a file name: %d", res.StatusCode)
	}
	if res, body := do(t, "PUT", ts.URL+"/api/look", "tok", `{"scheme":"sepia","theme":"frappe"}`); res.StatusCode != 200 || here.look() != (Look{"auto", "frappe"}) {
		t.Fatalf("an unknown scheme falls back to auto: %d %s", res.StatusCode, body)
	}

	_, body := do(t, "GET", ts.URL+"/api/me", "tok", "")
	var me struct{ Look Look }
	json.Unmarshal([]byte(body), &me)
	if me.Look != (Look{"auto", "frappe"}) {
		t.Errorf("me: %+v", me.Look)
	}
	for end := time.Now().Add(2 * time.Second); far.look() != here.look() && time.Now().Before(end); {
		time.Sleep(20 * time.Millisecond)
	}
	if far.look() != here.look() {
		t.Errorf("peer did not follow: %+v", far.look())
	}
}
