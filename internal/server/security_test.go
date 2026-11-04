package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLinkScopeNeverOpensHome(t *testing.T) {
	t.Setenv("HOME", "/home/u")
	for path, want := range map[string]string{
		"/home/u/report.html":      "/home/u/report.html",
		"/x.html":                  "/x.html",
		"/home/x.html":             "/home/x.html",
		"/home/u/proj/report.html": "/home/u/proj",
		"/tmp/out/a.png":           "/tmp/out",
	} {
		if got := linkScope(path); got != want {
			t.Errorf("%s: %s, want %s", path, got, want)
		}
	}
	for path, want := range map[string]bool{
		"/home/u/proj/a.png": false, "/home/u/proj/img/a.png": false, "/home/u/proj/.env": true, "/home/u/proj/.git/config": true,
	} {
		if got := hiddenBelow("/home/u/proj", path); got != want {
			t.Errorf("%s: %v", path, got)
		}
	}
	if hiddenBelow("/home/u/.local/page.html", "/home/u/.local/page.html") {
		t.Error("a file shown by its exact link is not hidden")
	}
}

func TestAddressDoesNotVouchForAnotherSite(t *testing.T) {
	for _, c := range []struct {
		fetch, origin string
		want          bool
	}{
		{"", "", false}, {"same-origin", "", false}, {"none", "", false}, {"", "http://atc.test", false},
		{"cross-site", "", true}, {"same-site", "", true}, {"", "https://evil.example", true}, {"", "null", true},
	} {
		r := httptest.NewRequest("GET", "http://atc.test/api/browser/x/cdp", nil)
		r.Header.Set("Sec-Fetch-Site", c.fetch)
		r.Header.Set("Origin", c.origin)
		if got := fromAnotherSite(r); got != c.want {
			t.Errorf("%+v: %v", c, got)
		}
	}
}

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
