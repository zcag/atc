package pair

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const ClaimPath = "/api/pair/claim"

// Payload is what a QR code or a pasted line carries: atc://pair?url=&code=&ca=
type Payload struct {
	URL, Code, CA string
}

func (p Payload) String() string {
	q := url.Values{"url": {p.URL}, "code": {p.Code}}
	if p.CA != "" {
		q.Set("ca", p.CA)
	}
	return "atc://pair?" + q.Encode()
}

var (
	codeForm = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	caForm   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// CheckURL accepts only a plain http(s) server address and returns it without a trailing slash.
func CheckURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("not a server address: %q", raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

func Parse(text string) (Payload, error) {
	u, err := url.Parse(strings.TrimSpace(text))
	if err != nil || u.Scheme != "atc" || u.Host != "pair" {
		return Payload{}, errors.New("not an atc pairing: expected atc://pair?...")
	}
	q := u.Query()
	base, err := CheckURL(q.Get("url"))
	if err != nil {
		return Payload{}, err
	}
	p := Payload{URL: base, Code: q.Get("code"), CA: strings.ToLower(q.Get("ca"))}
	if !codeForm.MatchString(p.Code) {
		return Payload{}, errors.New("pairing has no valid code")
	}
	if p.CA != "" && !caForm.MatchString(p.CA) {
		return Payload{}, errors.New("pairing has a malformed certificate fingerprint")
	}
	return p, nil
}

func Fingerprint(c *x509.Certificate) string {
	h := sha256.Sum256(c.Raw)
	return hex.EncodeToString(h[:])
}

// ParseCerts reads every certificate in PEM data.
func ParseCerts(b []byte) []*x509.Certificate {
	var out []*x509.Certificate
	for {
		var block *pem.Block
		if block, b = pem.Decode(b); block == nil {
			return out
		}
		if c, err := x509.ParseCertificate(block.Bytes); err == nil && block.Type == "CERTIFICATE" {
			out = append(out, c)
		}
	}
}

// Served returns the certificates an https server presents, unchecked: callers only compare them.
func Served(base string) []*x509.Certificate {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" {
		return nil
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "443")
	}
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 3 * time.Second}, "tcp", host, &tls.Config{InsecureSkipVerify: true, ServerName: u.Hostname()})
	if err != nil {
		return nil
	}
	defer conn.Close()
	return conn.ConnectionState().PeerCertificates
}

// Signs says whether anchor is, or signs, the served chain. The host name is checked when connecting.
func Signs(anchor *x509.Certificate, chain []*x509.Certificate) bool {
	if len(chain) == 0 {
		return false
	}
	roots, mid := x509.NewCertPool(), x509.NewCertPool()
	roots.AddCert(anchor)
	for _, c := range chain[1:] {
		mid.AddCert(c)
	}
	_, err := chain[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: mid, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}})
	return err == nil
}

// Trusted says whether the system's own authorities accept the served chain.
func Trusted(chain []*x509.Certificate) bool {
	if len(chain) == 0 {
		return false
	}
	mid := x509.NewCertPool()
	for _, c := range chain[1:] {
		mid.AddCert(c)
	}
	_, err := chain[0].Verify(x509.VerifyOptions{Intermediates: mid, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}})
	return err == nil
}

// TLS trusts the system's authorities and the given PEM ones; nil when there are none to add.
func TLS(pems ...string) *tls.Config {
	var pool *x509.CertPool
	for _, p := range pems {
		if p == "" {
			continue
		}
		if pool == nil {
			if pool, _ = x509.SystemCertPool(); pool == nil {
				pool = x509.NewCertPool()
			}
		}
		pool.AppendCertsFromPEM([]byte(p))
	}
	if pool == nil {
		return nil
	}
	return &tls.Config{RootCAs: pool}
}

// Transport is the default one with TLS(pems...) when that adds anything, otherwise nil, which an
// http.Client reads as the default.
func Transport(pems ...string) http.RoundTripper {
	cfg := TLS(pems...)
	if cfg == nil {
		return nil
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = cfg
	return tr
}

// Mismatch is a server whose certificate is not the one the pairing names.
type Mismatch struct{ URL, Want, Got string }

func (e Mismatch) Error() string {
	return fmt.Sprintf("%s presented a certificate that does not match the pairing: expected %s, got %s; the code was not sent to it", e.URL, e.Want, e.Got)
}

// anchorFor finds the certificate the pairing pins: one the server presents, or its /app/ca.crt,
// which is safe to fetch unverified because only the fingerprint decides.
func anchorFor(p Payload) (*x509.Certificate, error) {
	chain := Served(p.URL)
	if len(chain) == 0 {
		return nil, fmt.Errorf("cannot read the certificate of %s", p.URL)
	}
	candidates := chain
	insecure := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	if res, err := insecure.Get(p.URL + "/app/ca.crt"); err == nil {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			candidates = append(candidates[:len(chain):len(chain)], ParseCerts(b)...)
		}
	}
	for _, c := range candidates {
		if Fingerprint(c) == p.CA && Signs(c, chain) {
			return c, nil
		}
	}
	return nil, Mismatch{p.URL, p.CA, Fingerprint(chain[len(chain)-1])}
}

// Redeemed is what claiming a pairing brings back. CA is the pinned certificate as PEM, for the
// caller to keep trusting; empty when the pairing pins none.
type Redeemed struct {
	Token string `json:"token"`
	ID    string `json:"id"`
	Host  string `json:"host"`
	CA    string `json:"-"`
}

func Redeem(p Payload, name string) (*Redeemed, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	var out Redeemed
	if p.CA != "" && strings.HasPrefix(p.URL, "https://") {
		anchor, err := anchorFor(p)
		if err != nil {
			return nil, err
		}
		out.CA = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: anchor.Raw}))
		roots := x509.NewCertPool()
		roots.AddCert(anchor)
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}
	}
	body, _ := json.Marshal(map[string]string{"code": p.Code, "name": name})
	res, err := client.Post(p.URL+ClaimPath, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s: %w", p.URL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return nil, fmt.Errorf("%s refused the pairing: %s", p.URL, strings.TrimSpace(string(msg)))
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Token == "" {
		return nil, errors.New("server gave no token")
	}
	return &out, nil
}
