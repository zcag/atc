package server

import (
	"testing"
	"time"
)

func TestTicksCountOnce(t *testing.T) {
	var k ticks
	now := time.Now()
	slot := now.Unix() / tickSecs
	if !k.claim(slot, now) || k.claim(slot, now) {
		t.Fatal("a tick counts once, whichever device sends it")
	}
	if k.claim(now.Add(-ticksBack-time.Minute).Unix()/tickSecs, now) {
		t.Fatal("a tick older than the window is refused")
	}
	if k.claim(now.Add(time.Minute).Unix()/tickSecs, now) {
		t.Fatal("a tick from the future is refused")
	}
}

func TestTimeSince(t *testing.T) {
	log := timeLog{Sessions: map[string]*timeRow{
		"a": {Title: "a", Days: map[string]int{"2026-11-01": 60, "2026-11-20": 30}},
		"b": {Title: "b", Days: map[string]int{"2026-11-02": 600}},
	}}
	out := timeSince(log, "2026-11-10")
	if len(out.Sessions) != 1 || out.Sessions[0].Secs != 30 || out.Days["2026-11-20"] != 30 {
		t.Fatalf("only days in range: %+v", out)
	}
	if out = timeSince(log, ""); out.Sessions[0].ID != "b" || out.Sessions[1].Secs != 90 {
		t.Fatalf("all time, most first: %+v", out)
	}
}
