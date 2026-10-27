package outputs

import (
	"testing"
	"time"
)

func TestServing(t *testing.T) {
	p := &Ports{at: time.Now(),
		list:   []Listener{{Port: 3010, pid: 12}, {Port: 6379, pid: 22}},
		tree:   map[int]int{10: 1, 11: 10, 12: 11, 20: 1, 21: 20, 22: 21, 23: 20},
		shells: map[int]bool{11: true, 21: true, 23: true},
	}
	if got := p.Serving(10); len(got) != 1 || got[0].Port != 3010 {
		t.Fatalf("only shell serves: %v", got)
	}
	if got := p.Serving(20); got != nil {
		t.Fatalf("a shell that does not listen is still work: %v", got)
	}
	if got := p.Serving(30); got != nil {
		t.Fatalf("no shells: %v", got)
	}
}
