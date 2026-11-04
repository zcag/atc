package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEncodedSlashIsNotAnOutputLink(t *testing.T) {
	ts := newTestServer(t, nil, Voice{})
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/sessions/aaa%2Fo%2Fbbb/pages"},
		{"POST", "/api/sessions/aaa%2Fo%2Fbbb/pages/x/run"},
		{"POST", "/api/sessions/aaa%2fo%2fbbb/send"},
		{"POST", "/api/sessions/aaa%2Fo%2Fbbb/stop"},
		{"GET", "/api/sessions/aaa%2Fo%2Fbbb/transcript"},
		{"GET", "/api/sessions/aaa%2Fo%2Fbbb/usage"},
		{"POST", "/api/sessions/aaa/o/bbb/pages"},
		{"POST", "/api/sessions/aaa/o/%2e%2e/%2e%2e/aaa/pages"},
	} {
		if res, _ := do(t, c.method, ts.URL+c.path, "", `{}`); res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s answered %d without a login", c.method, c.path, res.StatusCode)
		}
	}
	if res, _ := do(t, "GET", ts.URL+"/api/sessions/real/o/bad/f.txt", "", ""); res.StatusCode == http.StatusUnauthorized {
		t.Error("a signed link must not need a login")
	}
}

func TestTrustByAddressNeedsOurOwnName(t *testing.T) {
	s := &Server{PublicURL: "https://atc.example.org"}
	t.Setenv("ATC_ALLOWED_HOSTS", "other.example.org")
	for host, want := range map[string]bool{
		"desktop:7272": true, "100.64.1.2:7272": true, "[fd7a::1]:7272": true, "desktop.tail1234.ts.net": true,
		"atc.example.org": true, "ATC.example.org:443": true, "other.example.org": true,
		"evil.example": false, "atc.example.org.evil.example": false,
	} {
		r := httptest.NewRequest("GET", "/api/sessions", strings.NewReader(""))
		r.Host = host
		if got := s.namedForUs(r); got != want {
			t.Errorf("%s: %v", host, got)
		}
	}
}
