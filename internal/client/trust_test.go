package client

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zcag/atc/internal/claude"
)

func TestStartReportsTheUntrustedFolder(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(claude.UntrustedHeader, "/a%20b")
		http.Error(w, "not trusted", http.StatusConflict)
	}))
	defer ts.Close()
	c := &Client{URL: ts.URL, http: ts.Client()}
	_, err := c.StartOn("other", "/a b", "", "", false)
	var u *Untrusted
	if !errors.As(err, &u) || u.Dir != "/a b" || u.Host != "other" || u.Msg != "not trusted" {
		t.Fatalf("got %#v", err)
	}
}
