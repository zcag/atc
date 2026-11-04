package pair

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTokenIsStoredOnlyAsAHash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "paired.json")
	s, _ := Open(path)
	code, _ := s.NewCode()
	token, d, err := s.Claim(code, "phone")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), token) || strings.Contains(string(b), code) || !strings.Contains(string(b), hash(token)) {
		t.Fatalf("token or code at rest: %s", b)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if id, ok := again.Check(token); !ok || id != d.ID {
		t.Fatalf("reopened store: %v %v", id, ok)
	}
	view, _ := json.Marshal(again.List())
	if strings.Contains(string(view), "hash") || strings.Contains(string(view), hash(token)) {
		t.Fatalf("list shows the hash: %s", view)
	}
}

func TestCodeIsSingleUse(t *testing.T) {
	s, _ := Open("")
	code, _ := s.NewCode()
	if _, _, err := s.Claim(code, "a"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Claim(code, "b"); !errors.Is(err, ErrCode) {
		t.Fatalf("second claim: %v", err)
	}
	if _, _, err := s.Claim("never-issued", "c"); !errors.Is(err, ErrCode) {
		t.Fatalf("unknown code: %v", err)
	}
	if len(s.List()) != 1 {
		t.Fatal(s.List())
	}
}

func TestCodeExpires(t *testing.T) {
	s, _ := Open("")
	at := time.Now()
	s.now = func() time.Time { return at }
	code, expires := s.NewCode()
	if expires.Sub(at) != 10*time.Minute {
		t.Fatal(expires)
	}
	at = at.Add(CodeLife)
	if _, _, err := s.Claim(code, "late"); !errors.Is(err, ErrCode) {
		t.Fatalf("expired: %v", err)
	}
}

func TestPendingCodesAreBounded(t *testing.T) {
	s, _ := Open("")
	first, _ := s.NewCode()
	for range maxCodes {
		s.NewCode()
	}
	if len(s.codes) != maxCodes {
		t.Fatal(len(s.codes))
	}
	if _, _, err := s.Claim(first, "x"); !errors.Is(err, ErrCode) {
		t.Fatal(err)
	}
}

func TestRevoke(t *testing.T) {
	path := filepath.Join(t.TempDir(), "paired.json")
	s, _ := Open(path)
	code, _ := s.NewCode()
	token, d, _ := s.Claim(code, "phone")
	stopped := 0
	s.Watch(d.ID, func() { stopped++ })
	finished := s.Watch(d.ID, func() { stopped += 10 })
	finished()
	if ok, err := s.Revoke("nobody"); ok || err != nil {
		t.Fatal(ok, err)
	}
	if ok, err := s.Revoke(d.ID); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if stopped != 1 {
		t.Fatalf("live connections stopped %d", stopped)
	}
	if _, ok := s.Check(token); ok {
		t.Fatal("revoked token still valid")
	}
	again, _ := Open(path)
	if _, ok := again.Check(token); ok {
		t.Fatal("revocation did not persist")
	}
}

func TestLastSeenIsThrottledOnDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "paired.json")
	s, _ := Open(path)
	at := time.Now()
	s.now = func() time.Time { return at }
	code, _ := s.NewCode()
	token, _, _ := s.Claim(code, "phone")
	at = at.Add(time.Second)
	s.Check(token)
	if !s.List()[0].LastSeen.Equal(at) {
		t.Fatal("not seen in memory")
	}
	if again, _ := Open(path); !again.List()[0].LastSeen.IsZero() {
		t.Fatal("wrote within the minute")
	}
	at = at.Add(seenEvery)
	s.Check(token)
	if again, _ := Open(path); again.List()[0].LastSeen.IsZero() {
		t.Fatal("not written after the minute")
	}
}

func TestNamesAreCleaned(t *testing.T) {
	for in, want := range map[string]string{"": "unnamed device", " a\x1b[31mb\n ": "a[31mb", strings.Repeat("é", 100): strings.Repeat("é", maxNameRunes)} {
		if got := cleanName(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}

func TestLimiter(t *testing.T) {
	at := time.Now()
	l := &Limiter{Window: time.Minute, PerAddr: 2, All: 3, now: func() time.Time { return at }}
	if !l.Allow("a") || !l.Allow("a") || l.Allow("a") {
		t.Fatal("per address")
	}
	if !l.Allow("b") || l.Allow("c") {
		t.Fatal("overall")
	}
	at = at.Add(time.Minute)
	if !l.Allow("a") {
		t.Fatal("window did not reset")
	}
}

func TestPayloadRoundTrip(t *testing.T) {
	fp := strings.Repeat("ab", 32)
	p := Payload{URL: "https://atc.example:8443/base", Code: "abcdefgh234567", CA: fp}
	got, err := Parse("  " + p.String() + "\n")
	if err != nil || got != p {
		t.Fatalf("%+v %v", got, err)
	}
	if got, err := Parse("atc://pair?url=http%3A%2F%2Fhost%3A7272&code=abcdefgh&ca=" + strings.ToUpper(fp)); err != nil || got.CA != fp {
		t.Fatalf("upper case ca: %+v %v", got, err)
	}
	for _, bad := range []string{
		"", "https://atc.example", "atc://open?path=/", "atc://pair?code=abcdefgh",
		"atc://pair?url=javascript:alert(1)&code=abcdefgh",
		"atc://pair?url=https%3A%2F%2Fu%40evil&code=abcdefgh",
		"atc://pair?url=https%3A%2F%2Fok",
		"atc://pair?url=https%3A%2F%2Fok&code=short",
		"atc://pair?url=https%3A%2F%2Fok&code=abcdefgh&ca=nothex",
	} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func modulesOf(term string) map[[2]int]bool {
	black := map[[2]int]bool{}
	for y, line := range strings.Split(strings.TrimRight(term, "\n"), "\n") {
		line = strings.TrimSuffix(line[strings.Index(line, "m")+1:], "\x1b[0m")
		for x, r := range []rune(line) {
			black[[2]int{x, 2 * y}] = r == '█' || r == '▀'
			black[[2]int{x, 2*y + 1}] = r == '█' || r == '▄'
		}
	}
	return black
}

func TestTerminalAndSVGDrawTheSameCode(t *testing.T) {
	text := Payload{URL: "https://atc.example", Code: "abcdefgh234567", CA: strings.Repeat("0", 64)}.String()
	c, err := code(text)
	if err != nil {
		t.Fatal(err)
	}
	term, err := Terminal(text)
	if err != nil {
		t.Fatal(err)
	}
	drawn := modulesOf(term)
	svg, _ := SVG(text)
	for y := range c.Size {
		for x := range c.Size {
			if drawn[[2]int{x + quiet, y + quiet}] != c.Black(x, y) {
				t.Fatalf("terminal differs at %d,%d", x, y)
			}
			if c.Black(x, y) != strings.Contains(svg, fmt.Sprintf("M%d %dh", x+quiet, y+quiet)) {
				t.Fatalf("svg differs at %d,%d", x, y)
			}
		}
	}
	for i := range quiet {
		if drawn[[2]int{i, i}] {
			t.Fatal("no quiet zone")
		}
	}
}

func authority(t *testing.T, name string) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return c, key
}

func signedServer(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, h http.Handler) *httptest.Server {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "leaf"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(h)
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return ts
}

func TestRedeemPinsAndFailsLoudly(t *testing.T) {
	ca, key := authority(t, "home ca")
	claimed := 0
	mux := http.NewServeMux()
	mux.HandleFunc("GET /app/ca.crt", func(w http.ResponseWriter, r *http.Request) {
		pem.Encode(w, &pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})
	})
	mux.HandleFunc("POST "+ClaimPath, func(w http.ResponseWriter, r *http.Request) {
		claimed++
		json.NewEncoder(w).Encode(map[string]string{"token": "tok", "id": "d1", "host": "there"})
	})
	ts := signedServer(t, ca, key, mux)

	r, err := Redeem(Payload{URL: ts.URL, Code: "abcdefgh", CA: Fingerprint(ca)}, "me")
	if err != nil {
		t.Fatal(err)
	}
	if r.Token != "tok" || r.Host != "there" || len(ParseCerts([]byte(r.CA))) != 1 {
		t.Fatalf("%+v", r)
	}
	res, err := (&http.Client{Transport: Transport(r.CA)}).Post(ts.URL+ClaimPath, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("kept certificate is not trusted: %v", err)
	}
	res.Body.Close()

	claimed = 0
	other, _ := authority(t, "someone else")
	_, err = Redeem(Payload{URL: ts.URL, Code: "abcdefgh", CA: Fingerprint(other)}, "me")
	var m Mismatch
	if !errors.As(err, &m) || m.Want != Fingerprint(other) {
		t.Fatalf("wrong pin: %v", err)
	}
	if claimed != 0 {
		t.Fatal("the code was sent to a server that failed the pin")
	}
}

func TestSignsAcceptsAuthorityAndLeaf(t *testing.T) {
	ca, key := authority(t, "ca")
	ts := signedServer(t, ca, key, http.NotFoundHandler())
	chain := Served(ts.URL)
	if len(chain) != 1 || !Signs(ca, chain) || !Signs(chain[0], chain) {
		t.Fatalf("chain %d", len(chain))
	}
	other, _ := authority(t, "other")
	if Signs(other, chain) {
		t.Fatal("foreign authority accepted")
	}
	if Trusted(chain) {
		t.Fatal("a private authority counted as the system's")
	}
}
