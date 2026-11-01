package hub

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGuestReachesNoOneAndKeepsHisChannel(t *testing.T) {
	r := newRig(t, CallConfig{})
	var mu sync.Mutex
	var written []string
	in := r.h.in
	r.h.mu.Lock()
	r.h.in = writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		written = append(written, string(b))
		mu.Unlock()
		return in.Write(b)
	})
	r.h.mu.Unlock()
	wa, all := r.dial("whatsapp"), r.dial("")
	wa.send("message", "hi")
	wa.until("done")
	all.until("done")

	r.h.Say(Guest, "[guest sam on WhatsApp]\nsite açılmıyor")
	if es := all.until("done"); es[len(es)-1].Channel != Guest {
		t.Fatalf("guest turn %v", es)
	}
	select {
	case e := <-wa.ev:
		t.Fatalf("whatsapp got %v", e)
	case <-time.After(200 * time.Millisecond):
	}
	mu.Lock()
	note := written[len(written)-1]
	mu.Unlock()
	if !strings.Contains(note, "[talk-mode: guest, for this message only]") || !strings.Contains(note, "MODE guest") || !strings.Contains(note, "they last wrote from whatsapp") {
		t.Fatalf("guest note %s", note)
	}

	wa.send("message", "again")
	wa.until("done")
	mu.Lock()
	defer mu.Unlock()
	if last := written[len(written)-1]; strings.Contains(last, "talk-mode") {
		t.Fatalf("whatsapp mode resent after a guest: %s", last)
	}
}
