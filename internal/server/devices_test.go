package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/pair"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func pairedServer(t *testing.T, configure func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	bin := fakeClaude(t)
	s := &Server{
		M:    &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Web: fstest.MapFS{"index.html": {Data: []byte("atc")}}, Token: "tok", Host: "here",
	}
	if configure != nil {
		configure(s)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts
}

func decode[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return v
}

type pairing struct {
	Payload, URL, SVG string
	Expires           time.Time
}

func claimDevice(t *testing.T, ts *httptest.Server, name string) (token, id string) {
	t.Helper()
	res, body := do(t, "POST", ts.URL+"/api/pair", "tok", "")
	if res.StatusCode != 200 {
		t.Fatalf("pair: %d %s", res.StatusCode, body)
	}
	got := decode[pairing](t, body)
	p, err := pair.Parse(got.Payload)
	if err != nil {
		t.Fatalf("%v: %s", err, got.Payload)
	}
	res, body = do(t, "POST", ts.URL+pair.ClaimPath, "", `{"code":"`+p.Code+`","name":"`+name+`"}`)
	if res.StatusCode != 200 {
		t.Fatalf("claim: %d %s", res.StatusCode, body)
	}
	c := decode[struct{ Token, ID, Host string }](t, body)
	if c.Token == "" || c.Host != "here" {
		t.Fatalf("claim reply: %s", body)
	}
	return c.Token, c.ID
}

func TestPairNeedsAuthButClaimDoesNot(t *testing.T) {
	_, ts := pairedServer(t, nil)
	if res, _ := do(t, "POST", ts.URL+"/api/pair", "", ""); res.StatusCode != 401 {
		t.Fatalf("pair without a token: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+"/api/devices", ""); res.StatusCode != 401 {
		t.Fatalf("devices without a token: %d", res.StatusCode)
	}
	if res, _ := do(t, "DELETE", ts.URL+"/api/devices/x", "", ""); res.StatusCode != 401 {
		t.Fatalf("revoke without a token: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", ts.URL+pair.ClaimPath, "", `{"code":"nope"}`); res.StatusCode != 401 {
		t.Fatalf("claim with a bad code: %d", res.StatusCode)
	}
	for _, near := range []string{pair.ClaimPath + "/", pair.ClaimPath + "x"} {
		if res, _ := do(t, "POST", ts.URL+near, "", "{}"); res.StatusCode != 401 {
			t.Fatalf("%s is not exempt: %d", near, res.StatusCode)
		}
	}
}

func TestDeviceTokenWorksAndMasterStillDoes(t *testing.T) {
	_, ts := pairedServer(t, nil)
	token, id := claimDevice(t, ts, "phone")
	if token == "tok" || id == "" {
		t.Fatal(token, id)
	}
	if res, _ := get(t, ts.URL+"/api/sessions", token); res.StatusCode != 200 {
		t.Fatalf("device bearer: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+"/api/sessions", "tok"); res.StatusCode != 200 {
		t.Fatalf("master bearer: %d", res.StatusCode)
	}
	res, _ := do(t, "POST", ts.URL+"/api/login", "", `{"token":"`+token+`"}`)
	if res.StatusCode != 200 || len(res.Cookies()) == 0 || res.Cookies()[0].Value != token {
		t.Fatalf("cookie login with a device token: %d %v", res.StatusCode, res.Cookies())
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/sessions", nil)
	req.AddCookie(res.Cookies()[0])
	if r, err := http.DefaultClient.Do(req); err != nil || r.StatusCode != 200 {
		t.Fatalf("device cookie: %v %v", err, r)
	}
	res, _ = do(t, "POST", ts.URL+"/api/login", "", `{"token":"tok"}`)
	if res.StatusCode != 200 || res.Cookies()[0].Value != "tok" {
		t.Fatalf("cookie login with the master token: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/login", "", `{"token":"wrong"}`); res.StatusCode != 401 {
		t.Fatalf("wrong login: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+"/?token="+token, ""); res.StatusCode != http.StatusFound {
		t.Fatalf("login link with a device token: %d", res.StatusCode)
	}
}

func TestDeviceListShowsNoSecrets(t *testing.T) {
	_, ts := pairedServer(t, nil)
	token, id := claimDevice(t, ts, "phone")
	res, body := get(t, ts.URL+"/api/devices", token)
	if res.StatusCode != 200 || strings.Contains(body, token) || strings.Contains(body, "hash") {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	got := decode[struct {
		Devices []pair.Device
		This    string
	}](t, body)
	if len(got.Devices) != 1 || got.Devices[0].Name != "phone" || got.This != id || got.Devices[0].LastSeen.IsZero() {
		t.Fatalf("%+v", got)
	}
	if res, body := get(t, ts.URL+"/api/devices", "tok"); res.StatusCode != 200 || strings.Contains(body, `"this"`) {
		t.Fatalf("master is no device: %s", body)
	}
}

func TestRevokeEndsAccessAtOnce(t *testing.T) {
	_, ts := pairedServer(t, nil)
	token, id := claimDevice(t, ts, "phone")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	stream, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	bufio.NewReader(stream.Body).ReadString('\n')

	conn, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/sessions/s1/attach",
		&websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	if res, _ := do(t, "DELETE", ts.URL+"/api/devices/"+id, "tok", ""); res.StatusCode != 200 {
		t.Fatalf("revoke: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+"/api/sessions", token); res.StatusCode != 401 {
		t.Fatalf("revoked token: %d", res.StatusCode)
	}
	if _, err := io.ReadAll(stream.Body); ctx.Err() != nil {
		t.Fatalf("the stream stayed open after revoke: %v", err)
	}
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			break
		}
	}
	if ctx.Err() != nil {
		t.Fatal("the terminal stayed open after revoke")
	}
	if res, _ := do(t, "DELETE", ts.URL+"/api/devices/"+id, "tok", ""); res.StatusCode != 404 {
		t.Fatalf("second revoke: %d", res.StatusCode)
	}
}

func TestClaimIsRateLimited(t *testing.T) {
	_, ts := pairedServer(t, nil)
	got := map[int]int{}
	for range 15 {
		res, _ := do(t, "POST", ts.URL+pair.ClaimPath, "", `{"code":"wrong-code"}`)
		got[res.StatusCode]++
		if res.StatusCode == 429 && res.Header.Get("Retry-After") == "" {
			t.Fatal("no Retry-After")
		}
	}
	if got[401] != 10 || got[429] != 5 {
		t.Fatalf("%v", got)
	}
	res, body := do(t, "POST", ts.URL+"/api/pair", "tok", "")
	if res.StatusCode != 200 {
		t.Fatal(body)
	}
	p, _ := pair.Parse(decode[pairing](t, body).Payload)
	if res, _ := do(t, "POST", ts.URL+pair.ClaimPath, "", `{"code":"`+p.Code+`"}`); res.StatusCode != 429 {
		t.Fatalf("a good code during the limit: %d", res.StatusCode)
	}
}

func TestClaimIsNotForwardedToAPeer(t *testing.T) {
	var hits int
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	t.Cleanup(peer.Close)
	_, ts := pairedServer(t, func(s *Server) { s.Peers = []Peer{{Name: "other", URL: peer.URL, Token: "peer-secret"}} })
	if res, _ := do(t, "POST", ts.URL+pair.ClaimPath+"?host=other", "", `{"code":"wrong-code"}`); res.StatusCode != 401 || hits != 0 {
		t.Fatalf("%d, peer hit %d times", res.StatusCode, hits)
	}
}

func TestPayloadAddress(t *testing.T) {
	_, ts := pairedServer(t, func(s *Server) { s.PublicURL = "http://atc.example" })
	res, body := do(t, "POST", ts.URL+"/api/pair", "tok", "")
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("%d %v", res.StatusCode, res.Header)
	}
	got := decode[pairing](t, body)
	if p, err := pair.Parse(got.Payload); err != nil || p.URL != "http://atc.example" || p.CA != "" {
		t.Fatalf("%+v %v", p, err)
	}
	if !strings.HasPrefix(got.SVG, "<svg") || got.Expires.Before(time.Now().Add(9*time.Minute)) {
		t.Fatalf("%+v", got)
	}
	_, body = do(t, "POST", ts.URL+"/api/pair", "tok", `{"url":"https://other.example/"}`)
	if p, _ := pair.Parse(decode[pairing](t, body).Payload); p.URL != "https://other.example" {
		t.Fatal(p)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/pair", "tok", `{"url":"javascript:alert(1)"}`); res.StatusCode != 400 {
		t.Fatal(res.StatusCode)
	}

	s := &Server{Host: "desktop"}
	for host, want := range map[string]string{"127.0.0.1:7272": "http://desktop:7272", "localhost:7272": "http://desktop:7272", "[::1]:7272": "http://desktop:7272", "atc.example.com:8080": "http://atc.example.com:8080", "atc.example.com": "http://atc.example.com"} {
		r := httptest.NewRequest("POST", "http://"+host+"/api/pair", nil)
		r.RemoteAddr = "203.0.113.9:1"
		if got := s.pairURL(r); got != want {
			t.Errorf("%s: %s", host, got)
		}
	}
	r := httptest.NewRequest("POST", "http://atc.example.com/api/pair", nil)
	r.RemoteAddr = "10.0.0.1:1"
	r.Header.Set("X-Forwarded-Proto", "https")
	if got := s.pairURL(r); got != "http://atc.example.com" {
		t.Errorf("an untrusted client chose https: %s", got)
	}
	s.TrustedProxies = ParseProxies("10.0.0.0/8")
	if got := s.pairURL(r); got != "https://atc.example.com" {
		t.Errorf("behind a trusted proxy: %s", got)
	}
}

func TestSavePeerKeepsTheOthers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	SavePeer(path, Peer{Name: "a", URL: "http://a", Token: "1"})
	SavePeer(path, Peer{Name: "b", URL: "http://b", Token: "2", CA: "pem"})
	SavePeer(path, Peer{Name: "a", URL: "http://a2", Token: "3"})
	ps, err := LoadPeers(path)
	if err != nil || len(ps) != 2 || ps[0].Name != "b" || ps[0].CA != "pem" || ps[1].URL != "http://a2" {
		t.Fatalf("%+v %v", ps, err)
	}
}

func TestClaimAddrKeepsZonedClientsApart(t *testing.T) {
	s := &Server{}
	r := httptest.NewRequest("POST", pair.ClaimPath, nil)
	r.RemoteAddr = "[fe80::1%eth0]:5000"
	if got := s.claimAddr(r); got != "fe80::1%eth0" {
		t.Fatal(got)
	}
	r.RemoteAddr = "192.0.2.1:5000"
	if got := s.claimAddr(r); got != "192.0.2.1" {
		t.Fatal(got)
	}
}
