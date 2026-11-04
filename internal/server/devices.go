package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/pair"
)

func requestToken(r *http.Request) string {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if c, err := r.Cookie("atc"); err == nil && tok == "" {
		tok = c.Value
	}
	return tok
}

// asDevice serves a device's request so that revoking the device ends it, however long it runs: a
// stream through its context, a terminal through the connection it took over.
func (s *Server) asDevice(id string, next http.Handler, w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	lw := &liveWriter{ResponseWriter: w}
	defer s.Paired.Watch(id, func() { cancel(); lw.cut() })()
	next.ServeHTTP(lw, r.WithContext(ctx))
}

type liveWriter struct {
	http.ResponseWriter
	mu   sync.Mutex
	conn net.Conn
}

func (w *liveWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *liveWriter) Flush() { http.NewResponseController(w.ResponseWriter).Flush() }

func (w *liveWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	w.mu.Lock()
	w.conn = c
	w.mu.Unlock()
	return c, rw, err
}

func (w *liveWriter) cut() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.conn != nil {
		w.conn.Close()
	}
}

// pairURL is the address a new device should use: the public one, else what this request came in
// on, except that a client on this machine came in on an address only this machine can use.
func (s *Server) pairURL(r *http.Request) string {
	if s.PublicURL != "" {
		return s.PublicURL
	}
	scheme := "http"
	if ip := s.remoteIP(r); r.TLS != nil || (s.TrustedProxies.Trusts(ip) && r.Header.Get("X-Forwarded-Proto") == "https") {
		scheme = "https"
	}
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		host, port = r.Host, ""
	}
	if ip := net.ParseIP(host); (host == "localhost" || (ip != nil && ip.IsLoopback())) && s.Host != "" {
		host = s.Host
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	}
	return scheme + "://" + host
}

func (s *Server) remoteIP(r *http.Request) net.IP {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return net.ParseIP(host)
}

// caPin is the fingerprint a new device should pin, when the server's certificate is not one every
// device already trusts: the app folder's ca.crt that signs what is served, else the top of what is served.
func (s *Server) caPin(base string) string {
	if !strings.HasPrefix(base, "https://") {
		return ""
	}
	served := pair.Served(base)
	var own []string
	if s.AppDir != "" {
		if b, err := os.ReadFile(filepath.Join(s.AppDir, "ca.crt")); err == nil {
			for _, c := range pair.ParseCerts(b) {
				if pair.Signs(c, served) {
					return pair.Fingerprint(c)
				}
				own = append(own, pair.Fingerprint(c))
			}
		}
	}
	if len(served) == 0 {
		if len(own) > 0 {
			return own[0]
		}
		return ""
	}
	if pair.Trusted(served) {
		return ""
	}
	return pair.Fingerprint(served[len(served)-1])
}

func (s *Server) pairStart(w http.ResponseWriter, r *http.Request) {
	var req struct{ URL string }
	json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	base := s.pairURL(r)
	if req.URL != "" {
		var err error
		if base, err = pair.CheckURL(req.URL); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	code, expires := s.Paired.NewCode()
	text := pair.Payload{URL: base, Code: code, CA: s.caPin(base)}.String()
	svg, err := pair.SVG(text)
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	reply(w, map[string]any{"payload": text, "url": base, "svg": svg, "expires": expires})
}

func (s *Server) pairClaim(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if !s.claims.Allow(ip.String()) {
		log.Printf("pair: too many claims from %s", ip)
		w.Header().Set("Retry-After", "60")
		http.Error(w, "too many attempts, try again in a minute", http.StatusTooManyRequests)
		return
	}
	var req struct{ Code, Name string }
	json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	token, d, err := s.Paired.Claim(strings.TrimSpace(req.Code), req.Name)
	if errors.Is(err, pair.ErrCode) {
		log.Printf("pair: refused a claim from %s", ip)
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	log.Printf("pair: paired %q as %s from %s", d.Name, d.ID, ip)
	w.Header().Set("Cache-Control", "no-store")
	reply(w, map[string]any{"token": token, "id": d.ID, "name": d.Name, "host": s.Host})
}

func (s *Server) devicesList(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"devices": s.Paired.List(), "tailnet": s.tailnet != nil}
	if id, ok := s.Paired.Check(requestToken(r)); ok {
		out["this"] = id
	}
	if s.AppDir != "" {
		if _, err := os.Stat(filepath.Join(s.AppDir, "atc.apk")); err == nil {
			link := s.pairURL(r) + "/app/atc.apk"
			if svg, err := pair.SVG(link); err == nil {
				out["app"] = map[string]string{"url": link, "svg": svg}
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	reply(w, out)
}

func (s *Server) deviceRevoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ok, err := s.Paired.Revoke(id)
	if err != nil {
		fail(w, err)
		return
	}
	if !ok {
		http.Error(w, "no such device", http.StatusNotFound)
		return
	}
	log.Printf("pair: revoked %s", id)
	reply(w, map[string]bool{"ok": true})
}

func newClaimLimiter() *pair.Limiter {
	return &pair.Limiter{Window: time.Minute, PerAddr: 10, All: 30}
}
