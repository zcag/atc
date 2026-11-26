package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestOfflinePeerIsSkipped(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	f := newFleet([]Peer{{Name: "gone", URL: "http://" + addr}})
	var v any
	if err := f.get(context.Background(), f.peers[0], "/api/me", &v); err == nil {
		t.Fatal("reached a closed port")
	}
	start := time.Now()
	err = f.get(context.Background(), f.peers[0], "/api/me", &v)
	if !errors.As(err, new(offline)) || time.Since(start) > 50*time.Millisecond {
		t.Fatalf("second call: %v after %v, want offline at once", err, time.Since(start))
	}
	if st := f.statuses()[0].Error; st == "" {
		t.Fatal("status does not say it is offline")
	}
	w := httptest.NewRecorder()
	f.proxy(w, httptest.NewRequest("GET", "/api/sessions/x/transcript", nil), &f.peers[0], "")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("proxy to an offline peer: %d", w.Code)
	}
}

func TestPeerErrorStatusKeepsItUp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", 500) }))
	defer srv.Close()
	f := newFleet([]Peer{{Name: "up", URL: srv.URL}})
	var v any
	f.get(context.Background(), f.peers[0], "/api/me", &v)
	if f.isDown("up") {
		t.Fatal("an answering peer was marked offline")
	}
}

func TestDownPeerKeepsItsLastSessions(t *testing.T) {
	var up atomic.Bool
	up.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			panic(http.ErrAbortHandler)
		}
		w.Write([]byte(`[{"sessionId":"s1","title":"Backfill","state":"working"}]`))
	}))
	defer srv.Close()
	f := newFleet([]Peer{{Name: "laptop", URL: srv.URL}})
	if got := f.gather(context.Background(), sessionsPath); len(got) != 1 || got[0].Host != "laptop" {
		t.Fatalf("first gather: %+v", got)
	}
	if st := f.statuses()[0]; !st.Since.IsZero() {
		t.Fatalf("an answering peer has a since: %+v", st)
	}
	up.Store(false)
	got := f.gather(context.Background(), sessionsPath)
	if len(got) != 1 || got[0].SessionID != "s1" || got[0].Host != "laptop" {
		t.Fatalf("down peer: want its last list, got %+v", got)
	}
	st := f.statuses()[0]
	if st.Error == "" || st.Since.IsZero() || time.Since(st.Since) > time.Minute {
		t.Fatalf("down peer status: %+v", st)
	}
	if other := f.gather(context.Background(), "/api/history?local=1"); len(other) != 0 {
		t.Fatalf("only the session list is kept: %+v", other)
	}
	up.Store(true)
	if err := f.retry(context.Background(), "laptop"); err != nil || f.isDown("laptop") {
		t.Fatalf("retry: %v, down=%v", err, f.isDown("laptop"))
	}
}
