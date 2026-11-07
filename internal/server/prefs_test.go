package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func listen(s *Server) chan []byte {
	ch := make(chan []byte, 64)
	s.mu.Lock()
	s.subs[ch] = true
	s.mu.Unlock()
	return ch
}

func next(t *testing.T, ch chan []byte, event string) string {
	t.Helper()
	for end := time.After(2 * time.Second); ; {
		select {
		case b := <-ch:
			if rest, ok := strings.CutPrefix(string(b), "event: "+event+"\ndata: "); ok {
				return strings.TrimSpace(rest)
			}
		case <-end:
			t.Fatalf("no %s event", event)
		}
	}
}

func TestSeenKeepsTheLaterMark(t *testing.T) {
	s, ts, _, _ := agentServer(t)
	old, _ := json.Marshal(map[string]time.Time{"gone": time.Now().Add(-40 * 24 * time.Hour)})
	os.WriteFile(filepath.Join(s.StateDir, "seen.json"), old, 0o644)

	if res, _ := do(t, "PUT", ts.URL+"/api/seen", "tok", `{"at":"2026-11-01T10:00:00Z"}`); res.StatusCode != 400 {
		t.Fatalf("no session: %d", res.StatusCode)
	}
	do(t, "PUT", ts.URL+"/api/seen", "tok", `{"sessionId":"a","at":"2026-11-01T10:00:00Z"}`)
	do(t, "PUT", ts.URL+"/api/seen", "tok", `{"sessionId":"a","at":"2026-10-30T10:00:00Z"}`)
	_, body := do(t, "GET", ts.URL+"/api/seen", "tok", "")
	var m map[string]time.Time
	json.Unmarshal([]byte(body), &m)
	if len(m) != 1 || !m["a"].Equal(time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("want only a's later mark, the 40 day old one dropped: %s", body)
	}
	do(t, "PUT", ts.URL+"/api/seen", "tok", `{"sessionId":"a","at":"2999-01-01T00:00:00Z"}`)
	_, body = do(t, "GET", ts.URL+"/api/seen", "tok", "")
	json.Unmarshal([]byte(body), &m)
	if m["a"].After(time.Now()) {
		t.Errorf("a mark in the future is clamped to now: %s", body)
	}
}

func TestDraftsFollowAcrossDevices(t *testing.T) {
	s, ts, _, _ := agentServer(t)
	ch := listen(s)
	if res, body := do(t, "PUT", ts.URL+"/api/drafts/a", "tok", `{"text":"half a thought","from":"desk"}`); res.StatusCode != 200 {
		t.Fatalf("put: %d %s", res.StatusCode, body)
	}
	if ev := next(t, ch, "drafts"); !strings.Contains(ev, `"sessionId":"a","text":"half a thought"`) || !strings.Contains(ev, `"from":"desk"`) {
		t.Errorf("event: %s", ev)
	}
	do(t, "PUT", ts.URL+"/api/drafts/b", "tok", `{"text":"other"}`)
	do(t, "PUT", ts.URL+"/api/drafts/b", "tok", `{"text":""}`)
	if ev := next(t, ch, "drafts"); !strings.Contains(ev, `"sessionId":"b","text":"other"`) {
		t.Errorf("first b event: %s", ev)
	}
	if ev := next(t, ch, "drafts"); !strings.Contains(ev, `"sessionId":"b","text":""`) {
		t.Errorf("an empty draft is announced as deleted: %s", ev)
	}
	_, body := do(t, "GET", ts.URL+"/api/drafts", "tok", "")
	var m map[string]draft
	json.Unmarshal([]byte(body), &m)
	if len(m) != 1 || m["a"].Text != "half a thought" || m["a"].At.IsZero() {
		t.Errorf("drafts: %s", body)
	}
}

func TestBaysOrderAndMemory(t *testing.T) {
	s, ts, _, _ := agentServer(t)
	ch := listen(s)
	if res, _ := do(t, "PUT", ts.URL+"/api/bays", "tok", `{}`); res.StatusCode != 400 {
		t.Fatalf("no order: %d", res.StatusCode)
	}
	do(t, "PUT", ts.URL+"/api/bays", "tok", `{"order":["atc","notes"]}`)
	do(t, "PATCH", ts.URL+"/api/bays/atc", "tok", `{"sid":"s1","panes":["transcript","page"]}`)
	do(t, "PATCH", ts.URL+"/api/bays/atc", "tok", `{"view":"board"}`)
	if ev := next(t, ch, "bays"); !strings.Contains(ev, `"order":["atc","notes"]`) {
		t.Errorf("order event: %s", ev)
	}
	next(t, ch, "bays")
	if ev := next(t, ch, "bays"); !strings.Contains(ev, `"view":"board"`) || !strings.Contains(ev, `"sid":"s1"`) {
		t.Errorf("a patch merges: %s", ev)
	}
	do(t, "PATCH", ts.URL+"/api/bays/atc", "tok", `{"panes":null,"parked":["s1","s2"]}`)
	b := s.bays()
	if m := b.Memory["atc"]; len(b.Order) != 2 || m.Sid != "s1" || m.View != "board" || m.Panes != nil || len(m.Parked) != 2 {
		t.Errorf("bays: %+v", b)
	}
	do(t, "PATCH", ts.URL+"/api/bays/atc", "tok", `{"parked":[]}`)
	if m := s.bays().Memory["atc"]; len(m.Parked) != 0 || m.Sid != "s1" {
		t.Errorf("clearing parked: %+v", m)
	}
}
