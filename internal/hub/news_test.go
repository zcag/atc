package hub

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

type fakeNews struct {
	mu    sync.Mutex
	asked []bool
	n     int
}

func (f *fakeNews) news(full bool) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, full)
	f.n++
	if full {
		return "[atc now] all"
	}
	return fmt.Sprintf("[atc since] change%d", f.n)
}

func (f *fakeNews) fulls() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bool{}, f.asked...)
}

func TestNewsInFrontOfEachMessage(t *testing.T) {
	r := newRig(t, CallConfig{})
	f := &fakeNews{}
	var mu sync.Mutex
	var written []string
	in := r.h.in
	r.h.mu.Lock()
	r.h.cfg.News = f.news
	r.h.in = writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		written = append(written, string(b))
		mu.Unlock()
		return in.Write(b)
	})
	r.h.mu.Unlock()
	atc, phone := r.dial("atc"), r.dial("phone")
	atc.send("message", "one")
	atc.until("done")
	atc.send("message", "two")
	atc.until("done")
	phone.send("message", "three")
	phone.until("done")
	if got := fmt.Sprint(f.fulls()); got != "[true false true]" {
		t.Fatalf("full asked %s, want the whole state first and when the call starts", got)
	}
	mu.Lock()
	defer mu.Unlock()
	for i, w := range []string{`[atc now] all\n\none`, `[atc since] change2\n\ntwo`, `[atc now] all\n\nthree`} {
		if !strings.Contains(written[i], w) {
			t.Errorf("message %d: %s, want %s", i, written[i], w)
		}
	}
}

func TestNoticeJoinsARunningPhoneTool(t *testing.T) {
	r := newRig(t, CallConfig{})
	f := &fakeNews{}
	r.h.mu.Lock()
	r.h.cfg.News = f.news
	r.h.mu.Unlock()
	if joined, _ := r.h.Notice(); joined {
		t.Fatal("joined with no turn running")
	}
	phone := r.dial("phone")
	phone.send("message", "TOOL check")
	phone.until("tool")
	joined, err := r.h.Notice()
	if !joined || err != nil {
		t.Fatalf("notice during a phone tool: %v %v", joined, err)
	}
	r.finishTool()
	es := phone.until("done")
	if got := said(es); !strings.Contains(got, "change") {
		t.Fatalf("the turn did not take the change in: %q", got)
	}
	if joined, _ := r.h.Notice(); joined {
		t.Fatal("joined after the turn ended")
	}
}
