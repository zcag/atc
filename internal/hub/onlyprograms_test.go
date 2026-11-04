package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOnlyProgramsReachTheHub(t *testing.T) {
	h := onlyPrograms(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	for _, c := range []struct {
		host, header, value string
		want                int
	}{
		{"127.0.0.1:8820", "", "", 200},
		{"desktop:8820", "", "", 200},
		{"[::1]:8820", "", "", 200},
		{"127.0.0.1:8820", "Origin", "https://evil.example", 403},
		{"127.0.0.1:8820", "Origin", "null", 403},
		{"127.0.0.1:8820", "Sec-Fetch-Site", "cross-site", 403},
		{"rebind.evil.example:8820", "", "", 403},
	} {
		r := httptest.NewRequest("POST", "/message", nil)
		r.Host = c.host
		if c.header != "" {
			r.Header.Set(c.header, c.value)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%+v: %d", c, w.Code)
		}
	}
}
