package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
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
