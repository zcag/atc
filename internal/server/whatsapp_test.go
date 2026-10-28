package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/whatsapp"
)

func TestWhatsAppHook(t *testing.T) {
	var mu sync.Mutex
	var calls []string
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, r.Method+" "+r.URL.Path)
		mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/phone") {
			w.Write([]byte(`{"phone":"905550000000"}`))
			return
		}
		w.Write([]byte(`[]`))
	}))
	defer gw.Close()
	const secret = "0123456789abcdef0123"
	for k, v := range map[string]string{"URL": gw.URL, "KEY": "k", "SESSION": "bot", "OWNER": "15550100", "SECRET": secret} {
		t.Setenv("ATC_WHATSAPP_"+k, v)
	}
	bin := fakeClaude(t)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{
		M:    &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Token: "tok", Host: "here", WhatsApp: whatsapp.FromEnv(), Web: fstest.MapFS{},
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	post := func(body, sig string) int {
		req, _ := http.NewRequest("POST", ts.URL+"/api/whatsapp/hook", strings.NewReader(body))
		req.Header.Set("X-OpenWA-Signature", sig)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	sign := func(body string) string {
		m := hmac.New(sha256.New, []byte(secret))
		m.Write([]byte(body))
		return "sha256=" + hex.EncodeToString(m.Sum(nil))
	}
	stranger := `{"event":"message.received","data":{"id":"m1","from":"777@lid","chatId":"777@lid","body":"hi","type":"text","kind":"individual"}}`
	if code := post(stranger, "sha256=00"); code != http.StatusUnauthorized {
		t.Fatalf("bad signature: %d, want 401", code)
	}
	if code := post(stranger, sign(stranger)); code != http.StatusOK {
		t.Fatalf("signed delivery: %d, want 200 without an atc token", code)
	}
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	for _, c := range calls {
		if !strings.HasSuffix(c, "/webhooks") && !strings.HasSuffix(c, "/contacts/777@lid/phone") {
			t.Errorf("a stranger's message reached %s", c)
		}
	}
}

func TestSplitSpoken(t *testing.T) {
	for in, want := range map[string][2]string{
		"Yes, they work.\n\n🔊 Evet, sesli mesajlar çalışıyor.": {"Yes, they work.", "Evet, sesli mesajlar çalışıyor."},
		"🔊 Tamam.":                        {"", "Tamam."},
		"No spoken line here.":            {"No spoken line here.", ""},
		"An emoji 🔊 mid-line stays text.": {"An emoji 🔊 mid-line stays text.", ""},
	} {
		text, say := splitSpoken(in)
		if text != want[0] || say != want[1] {
			t.Errorf("splitSpoken(%q) = %q, %q; want %q, %q", in, text, say, want[0], want[1])
		}
	}
}
