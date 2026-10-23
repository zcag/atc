package server

import (
	"testing"
	"time"
)

func TestPresence(t *testing.T) {
	var p presence
	p.at, p.idle = time.Now(), -1
	if ok, _ := p.here(); ok {
		t.Fatal("nobody here yet")
	}
	p.seen("laptop, Chrome")
	if ok, where := p.here(); !ok || where != "laptop, Chrome" {
		t.Fatalf("a focused page counts: %v %q", ok, where)
	}
	p.pages["laptop, Chrome"] = time.Now().Add(-2 * pageActive)
	p.idle = 30 * time.Second
	if ok, where := p.here(); !ok || where != "this machine" {
		t.Fatalf("recent keyboard or mouse use counts: %v %q", ok, where)
	}
	p.idle = 10 * time.Minute
	if ok, _ := p.here(); ok {
		t.Fatal("away")
	}
}
