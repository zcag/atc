package server

import (
	"os"
	"testing"
	"time"
)

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestNextRun(t *testing.T) {
	at := func(s string) time.Time { v, _ := time.ParseInLocation("2006-01-02T15:04", s, time.Local); return v }
	from := at("2026-10-16T07:00")
	for _, c := range []struct {
		every, now, want string
	}{
		{"2w", "2026-10-28T12:00", "2026-10-30T07:00"},
		{"2w", "2026-10-30T07:00", "2026-11-13T07:00"},
		{"2w", "2026-10-01T09:00", "2026-10-16T07:00"},
		{"1d", "2026-10-28T06:59", "2026-10-28T07:00"},
		{"15m", "2026-10-28T07:12", "2026-10-28T07:15"},
	} {
		d, err := parseEvery(c.every)
		if err != nil {
			t.Fatal(err)
		}
		if got := nextRun(from, d, at(c.now)); !got.Equal(at(c.want)) {
			t.Errorf("%s at %s: got %s, want %s", c.every, c.now, got, c.want)
		}
	}
	if _, err := parseEvery("1.5w"); err == nil {
		t.Error("1.5w should not parse")
	}
	if _, err := (Agent{Name: "x", Every: "1d", From: "tomorrow", Prompt: "p"}).interval(); err == nil {
		t.Error("a bad from should not load")
	}
}
