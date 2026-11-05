package server

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestPrivateOnly(t *testing.T) {
	h := PrivateOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	for addr, want := range map[string]int{
		"127.0.0.1:1":           200,
		"[::1]:1":               200,
		"192.168.1.20:1":        200,
		"10.0.0.2:1":            200,
		"172.16.0.2:1":          200,
		"100.100.1.2:1":         200,
		"[fd7a:115c:a1e0::1]:1": 200,
		"[::ffff:10.0.0.2]:1":   200,
		"203.0.113.9:1":         403,
		"8.8.8.8:1":             403,
		"172.32.0.1:1":          403,
		"100.128.0.1:1":         403,
		"[2001:db8::1]:1":       403,
		"[::ffff:8.8.8.8]:1":    403,
		"not an address":        403,
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = addr
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Errorf("%s: %d", addr, w.Code)
		}
	}
}

func TestReachRank(t *testing.T) {
	for _, c := range []struct {
		name, ip string
		want     int
	}{
		{"tailscale0", "100.90.1.2", 2},
		{"eth0", "192.168.1.5", 1},
		{"docker0", "172.17.0.1", 0},
		{"br-abc", "172.18.0.1", 0},
		{"lo", "127.0.0.1", 0},
		{"eth0", "203.0.113.9", 0},
	} {
		if got := reachRank(c.name, netip.MustParseAddr(c.ip)); got != c.want {
			t.Errorf("%s %s: %d", c.name, c.ip, got)
		}
	}
}

func TestPairURLPrefersAnAddressOthersReach(t *testing.T) {
	s := &Server{Host: "desktop", Reachable: func() string { return "192.168.1.5" }}
	r := httptest.NewRequest("POST", "http://127.0.0.1:7272/api/pair", nil)
	r.RemoteAddr = "127.0.0.1:1"
	if got := s.pairURL(r); got != "http://192.168.1.5:7272" {
		t.Error(got)
	}
	s.Reachable = func() string { return "" }
	if got := s.pairURL(r); got != "http://desktop:7272" {
		t.Error(got)
	}
}
