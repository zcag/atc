package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/settings"
)

func TestCallVoicesWithoutAServiceNameOnlyTheUsersLanguage(t *testing.T) {
	t.Setenv(settings.LanguageKey, "TR ")
	rec := httptest.NewRecorder()
	(&Server{}).callVoices(rec, httptest.NewRequest("GET", "/api/call/voices", nil))
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"tr":{}}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestCallVoiceSamplePassesThrough(t *testing.T) {
	var asked string
	shell := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.RequestURI()
		w.Header().Set("Content-Type", "audio/wav")
		w.Write([]byte("RIFF"))
	}))
	defer shell.Close()
	s := &Server{CallVoices: shell.URL}
	rec := httptest.NewRecorder()
	s.callVoiceSample(rec, httptest.NewRequest("GET", "/api/call/voices/sample?lang=tr&voice=podcast_m&text=Merhaba", nil))
	if asked != "/api/voices/sample?lang=tr&voice=podcast_m&text=Merhaba" || rec.Header().Get("Content-Type") != "audio/wav" || rec.Body.String() != "RIFF" {
		t.Fatalf("asked %q, got %s %q", asked, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}
