package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/pages"
)

var outputPath = regexp.MustCompile(`^/api/sessions/[^/]+/o/`)

type server struct {
	URL       string    `json:"url"`
	Port      int       `json:"port"`
	LocalOnly bool      `json:"localOnly,omitempty"`
	Running   bool      `json:"running"`
	Seen      time.Time `json:"seen,omitzero"`
}

type outputFile struct {
	outputs.File
	URL string `json:"url"`
}

func (s *Server) outputs(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	var files []outputs.File
	var links []outputs.Link
	var seen map[string]time.Time
	if s.M.OpenCode(sid) {
		var err error
		if files, links, seen, err = s.openCodeFound(r.Context(), sid); err != nil {
			fail(w, err)
			return
		}
	} else {
		t, ok := s.M.Index.Find(sid)
		if !ok {
			http.Error(w, "no transcript", http.StatusNotFound)
			return
		}
		home, _ := os.UserHomeDir()
		files, links, seen = s.scanner.Scan(t.Path, home)
	}
	pid := 0
	if live, err := s.M.Live(r.Context()); err == nil {
		for _, x := range live {
			if x.SessionID == sid {
				pid = x.PID
			}
		}
	}
	host := s.Host
	var servers []server
	have := map[int]bool{}
	for _, l := range s.M.Ports.Of(pid) {
		have[l.Port] = true
		servers = append(servers, server{fmt.Sprintf("http://%s:%d/", host, l.Port), l.Port, l.LocalOnly, true, seen[strconv.Itoa(l.Port)]})
	}
	for p, at := range seen {
		port, _ := strconv.Atoi(p)
		if have[port] {
			continue
		}
		if l, ok := s.M.Ports.Listening(port); ok && !l.Started.IsZero() && l.Started.Sub(at).Abs() < 10*time.Minute {
			servers = append(servers, server{fmt.Sprintf("http://%s:%d/", host, port), port, l.LocalOnly, true, at})
		}
	}
	out := struct {
		Pages   []pages.Page   `json:"pages"`
		Servers []server       `json:"servers"`
		Links   []outputs.Link `json:"links"`
		Files   []outputFile   `json:"files"`
	}{Pages: s.Pages.Of(sid), Servers: servers}
	for _, l := range links {
		dup := false
		for _, v := range servers {
			dup = dup || strings.HasPrefix(l.URL, strings.TrimSuffix(v.URL, "/"))
		}
		if !dup {
			out.Links = append(out.Links, l)
		}
	}
	exp := time.Now().Add(12 * time.Hour).Unix()
	for _, f := range files[:min(len(files), 300)] {
		out.Files = append(out.Files, outputFile{f, s.fileURL(sid, f.Path, exp)})
	}
	reply(w, out)
}

func (s *Server) outputKey() []byte {
	k := sha256.Sum256([]byte("atc outputs " + s.Token))
	return k[:]
}

func (s *Server) sign(sid, dir string, exp int64) string {
	m := hmac.New(sha256.New, s.outputKey())
	fmt.Fprintf(m, "%s|%s|%d", sid, dir, exp)
	return strconv.FormatInt(exp, 36) + "-" + hex.EncodeToString(m.Sum(nil))[:32]
}

func (s *Server) fileURL(sid, path string, exp int64) string {
	dir := filepath.Dir(path)
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, p := range segs {
		segs[i] = url.PathEscape(p)
	}
	return "/api/sessions/" + url.PathEscape(sid) + "/o/" + s.sign(sid, dir, exp) + "/" + strings.Join(segs, "/")
}

func (s *Server) outputFile(w http.ResponseWriter, r *http.Request) {
	sid, tok := r.PathValue("sid"), r.PathValue("tok")
	path := "/" + r.PathValue("path")
	parts := strings.SplitN(tok, "-", 2)
	exp, err := strconv.ParseInt(parts[0], 36, 64)
	if err != nil || len(parts) != 2 || time.Now().Unix() > exp {
		http.Error(w, "this link has expired; open the session's outputs again", http.StatusGone)
		return
	}
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if hmac.Equal([]byte(s.sign(sid, dir, exp)), []byte(tok)) {
			break
		}
		if dir == "/" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}
