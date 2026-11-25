package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zcag/atc/internal/browser"
)

func noRuns() []timeRun { return nil }

func TestTicksCountOnce(t *testing.T) {
	var k ticks
	now := time.Now()
	slot := now.Unix() / tickSecs
	if !k.claim(slot, now, noRuns) || k.claim(slot, now, noRuns) {
		t.Fatal("a tick counts once, whichever device sends it")
	}
	if k.claim(now.Add(-ticksBack-time.Minute).Unix()/tickSecs, now, noRuns) {
		t.Fatal("a tick older than the window is refused")
	}
	if k.claim(now.Add(time.Minute).Unix()/tickSecs, now, noRuns) {
		t.Fatal("a tick from the future is refused")
	}
	var after ticks
	if after.claim(slot, now, func() []timeRun { return []timeRun{{"a", "", slot - 1, 2}} }) {
		t.Fatal("a tick counted before a restart is not counted again")
	}
}

func TestRunsRoundTrip(t *testing.T) {
	s := &Server{StateDir: t.TempDir()}
	base := time.Date(2026, 11, 20, 10, 0, 0, 0, time.Local).Unix() / tickSecs
	if err := s.saveRuns(runsOf("a", "desk", []int64{base + 2, base, base + 1, base + 9})); err != nil {
		t.Fatal(err)
	}
	if err := s.saveRuns(runsOf("a", "desk", []int64{base + 3})); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(filepath.Join(s.StateDir, "time", "2026-11-20.jsonl"), os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(`{"s":"cut`)
	f.Close()
	runs := s.dayRuns("2026-11-20")
	if len(runs) != 2 || runs[0] != (timeRun{"a", "desk", base, 4}) || runs[1].N != 1 {
		t.Fatalf("runs join across saves and a torn line is skipped: %+v", runs)
	}
	midnight := time.Date(2026, 11, 21, 0, 0, 0, 0, time.Local).Unix() / tickSecs
	if r := runsOf("a", "", []int64{midnight - 1, midnight}); len(r) != 2 {
		t.Fatalf("a run ends at midnight: %+v", r)
	}
}

func TestTimeSince(t *testing.T) {
	now := time.Date(2026, 11, 20, 15, 0, 0, 0, time.Local)
	log := timeLog{Sessions: map[string]*timeRow{
		"a":            {Title: "a", Cwd: "/p", Days: map[string]int{"2026-11-01": 60, "2026-11-12": 5, "2026-11-20": 30}},
		"b":            {Title: "b", Profile: "kept", Days: map[string]int{"2026-11-02": 600}},
		"screen:board": {Days: map[string]int{"2026-11-19": 10}},
	}}
	prof := func(cwd string) string { return "of " + cwd }
	out := timeSince(log, now, 7, prof)
	if len(out.Days) != 7 || out.Days[0] != "2026-11-14" || out.Days[6] != "2026-11-20" || out.First != "2026-11-01" {
		t.Fatalf("every day of the range: %+v", out)
	}
	if len(out.Sessions) != 2 || out.Sessions[0].Days["2026-11-20"] != 30 || out.Sessions[0].Before != 5 || out.Sessions[0].Profile != "of /p" {
		t.Fatalf("only days in range, and the range before it: %+v", out)
	}
	if x := out.Sessions[1]; !x.Screen || x.Profile != "" {
		t.Fatalf("a screen is on no account: %+v", x)
	}
	if out = timeSince(log, now, 0, prof); len(out.Sessions) != 3 || len(out.Days) != 20 || out.Sessions[1].Profile != "kept" {
		t.Fatalf("all time: %+v", out)
	}
	if out = timeSince(timeLog{}, now, 0, prof); len(out.Days) != 0 {
		t.Fatalf("nothing yet: %+v", out)
	}
}

func TestAgentsPageIsNobody(t *testing.T) {
	chrome := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"id":"t1","type":"page","url":"http://atc.test/#/"},{"id":"t2","type":"page","url":"http://other.test/"}]`)
	}))
	defer chrome.Close()
	owners := filepath.Join(t.TempDir(), "browser.json")
	os.WriteFile(owners, []byte(`{"t1":{"session":"s1"}}`), 0o600)
	b, err := browser.Open(chrome.URL, owners)
	if err != nil {
		t.Fatal(err)
	}
	from := func(host, addr string) bool {
		r := httptest.NewRequest("POST", "http://"+host+"/api/time", nil)
		r.RemoteAddr = addr
		return (&Server{Browser: b}).agentsPage(r)
	}
	if !from("atc.test", "127.0.0.1:5000") {
		t.Fatal("a session's tab on atc, from this machine, is nobody")
	}
	if from("atc.test", "192.0.2.7:5000") || from("other.test", "127.0.0.1:5000") {
		t.Fatal("another machine, or a tab no session opened, is someone")
	}
}
