package server

import (
	"bytes"
	"cmp"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

type Server struct {
	M     *sessions.Manager
	Term  *attach.Hub
	Web   fs.FS
	Token string
	Roots []string
	Host  string
	Push  *push.Pusher

	mu   sync.Mutex
	subs map[chan []byte]bool
	last []byte
	kick chan struct{}
	seen map[string]string
}

func (s *Server) Handler() http.Handler {
	s.subs = map[chan []byte]bool{}
	s.kick = make(chan struct{}, 1)
	go s.poll()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /api/sessions", s.live)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("GET /api/dirs", s.dirs)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("POST /api/sessions", s.start)
	mux.HandleFunc("POST /api/sessions/{sid}/resume", s.resume)
	mux.HandleFunc("POST /api/sessions/{id}/stop", s.act(s.M.CLI.Stop))
	mux.HandleFunc("DELETE /api/sessions/{id}", s.act(s.M.CLI.Remove))
	mux.HandleFunc("PATCH /api/sessions/{sid}", s.patch)
	mux.HandleFunc("GET /api/sessions/{sid}/transcript", s.transcript)
	mux.HandleFunc("POST /api/sessions/{sid}/upload", s.upload)
	mux.HandleFunc("GET /api/sessions/{id}/attach", func(w http.ResponseWriter, r *http.Request) { s.Term.Serve(w, r, r.PathValue("id")) })
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) { reply(w, s.me()) })
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("GET /api/push/key", s.pushKey)
	mux.HandleFunc("POST /api/push/subscribe", s.pushSubscribe)
	mux.HandleFunc("POST /api/push/unsubscribe", s.pushUnsubscribe)
	mux.Handle("GET /", s.static())
	return s.auth(mux)
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Token == "" || r.URL.Path == "/api/login" || r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if q := r.URL.Query().Get("token"); q != "" && r.URL.Path == "/" && s.valid(q) {
			s.setCookie(w, q)
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if c, err := r.Cookie("atc"); err == nil && tok == "" {
			tok = c.Value
		}
		if !s.valid(tok) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) valid(tok string) bool {
	return tok != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.Token)) == 1
}

func (s *Server) setCookie(w http.ResponseWriter, tok string) {
	http.SetCookie(w, &http.Cookie{Name: "atc", Value: tok, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, MaxAge: 400 * 24 * 3600})
}

func (s *Server) me() map[string]string {
	home, _ := os.UserHomeDir()
	var cfg struct{ Theme string }
	if b, err := os.ReadFile(filepath.Join(home, ".claude.json")); err == nil {
		json.Unmarshal(b, &cfg)
	}
	theme := "dark"
	if strings.HasPrefix(cfg.Theme, "light") {
		theme = "light"
	}
	return map[string]string{"host": s.Host, "home": home, "claudeTheme": theme}
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct{ Token string }
	json.NewDecoder(r.Body).Decode(&req)
	if s.Token != "" && !s.valid(strings.TrimSpace(req.Token)) {
		time.Sleep(time.Second)
		http.Error(w, "wrong token", http.StatusUnauthorized)
		return
	}
	s.setCookie(w, strings.TrimSpace(req.Token))
	reply(w, s.me())
}

func (s *Server) static() http.Handler {
	files := http.FileServerFS(s.Web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" || r.URL.Path == "/sw.js" || r.URL.Path == "/manifest.webmanifest" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		files.ServeHTTP(w, r)
	})
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer f.Close()
	cache, _ := os.UserCacheDir()
	dir := filepath.Join(cache, "atc", "uploads", filepath.Base(r.PathValue("sid")))
	name := strings.Map(func(c rune) rune {
		if c == '/' || c == '\\' || c < ' ' {
			return '_'
		}
		return c
	}, filepath.Base(hdr.Filename))
	if name == "" || name == "." {
		name = "upload"
	}
	path := filepath.Join(dir, time.Now().Format("150405")+"-"+name)
	os.MkdirAll(dir, 0o755)
	out, err := os.Create(path)
	if err == nil {
		_, err = io.Copy(out, f)
		out.Close()
	}
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"path": path})
}

func (s *Server) transcript(w http.ResponseWriter, r *http.Request) {
	t, ok := s.M.Index.Find(r.PathValue("sid"))
	if !ok {
		http.Error(w, "no transcript", http.StatusNotFound)
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	p, err := history.ReadPage(t.Path, before, 2<<20)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, p)
}

func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	list, err := s.M.Live(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, list)
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 100
	}
	reply(w, s.M.History(q.Get("q"), q.Get("dir"), limit))
}

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir, Name, Prompt string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	dir, err := expand(req.Dir)
	if err == nil {
		var st os.FileInfo
		if st, err = os.Stat(dir); err == nil && !st.IsDir() {
			err = fmt.Errorf("%s is not a directory", dir)
		}
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	id, err := s.M.CLI.Start(r.Context(), dir, req.Name, req.Prompt)
	s.done(w, id, err)
}

func (s *Server) resume(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	dir := ""
	for _, h := range s.M.History("", "", 0) {
		if h.SessionID == sid {
			dir = h.StartCwd
			break
		}
	}
	if dir == "" {
		http.Error(w, "unknown session "+sid, http.StatusNotFound)
		return
	}
	id, err := s.M.CLI.Resume(r.Context(), dir, sid)
	s.done(w, id, err)
}

func (s *Server) act(f func(context.Context, string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.done(w, r.PathValue("id"), f(r.Context(), r.PathValue("id")))
	}
}

func (s *Server) patch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   *string `json:"name"`
		Pinned *bool   `json:"pinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	err := s.M.Store.Update(r.PathValue("sid"), func(m *store.Meta) {
		if req.Name != nil {
			m.Name = strings.TrimSpace(*req.Name)
		}
		if req.Pinned != nil {
			m.Pinned = *req.Pinned
		}
	})
	s.done(w, r.PathValue("sid"), err)
}

func (s *Server) done(w http.ResponseWriter, id string, err error) {
	if err != nil {
		fail(w, err)
		return
	}
	s.refresh()
	reply(w, map[string]string{"id": id})
}

type dir struct {
	Path   string `json:"path"`
	Recent bool   `json:"recent,omitempty"`
}

func (s *Server) dirs(w http.ResponseWriter, r *http.Request) {
	seen := map[string]bool{}
	var out []dir
	add := func(p string, recent bool) {
		if p == "" || seen[p] {
			return
		}
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			return
		}
		seen[p] = true
		out = append(out, dir{p, recent})
	}
	for _, h := range s.M.History("", "", 0) {
		if len(out) >= 30 {
			break
		}
		add(h.StartCwd, true)
	}
	for _, root := range s.Roots {
		add(root, false)
		ents, _ := os.ReadDir(root)
		var kids []string
		for _, e := range ents {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				kids = append(kids, filepath.Join(root, e.Name()))
			}
		}
		sort.Strings(kids)
		for _, k := range kids {
			add(k, false)
		}
	}
	reply(w, out)
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch := make(chan []byte, 4)
	s.mu.Lock()
	s.subs[ch] = true
	last := s.last
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.subs, ch); s.mu.Unlock() }()
	s.refresh()
	send := func(b []byte) bool {
		_, err := fmt.Fprintf(w, "event: sessions\ndata: %s\n\n", b)
		fl.Flush()
		return err == nil
	}
	if last != nil && !send(last) {
		return
	}
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case b := <-ch:
			if !send(b) {
				return
			}
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func (s *Server) refresh() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *Server) poll() {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-s.kick:
		}
		s.mu.Lock()
		n := len(s.subs)
		s.mu.Unlock()
		if n == 0 && (s.Push == nil || s.Push.Count() == 0) {
			s.seen = nil
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		list, err := s.M.Live(ctx)
		cancel()
		if err != nil {
			log.Printf("poll: %v", err)
			continue
		}
		s.notify(list)
		b, _ := json.Marshal(list)
		s.mu.Lock()
		if !bytes.Equal(b, s.last) {
			s.last = b
			for ch := range s.subs {
				select {
				case ch <- b:
				default:
				}
			}
		}
		s.mu.Unlock()
	}
}

func (s *Server) notify(list []sessions.Session) {
	now := map[string]string{}
	for _, x := range list {
		now[x.SessionID] = x.State
	}
	prev := s.seen
	s.seen = now
	if prev == nil || s.Push == nil {
		return
	}
	for _, x := range list {
		was, ok := prev[x.SessionID]
		if !ok || was == x.State || s.Term.Viewing(x.ID) {
			continue
		}
		m := push.Message{Title: x.Title, Tag: x.SessionID, URL: "/#/s/" + x.SessionID}
		switch {
		case x.State == sessions.NeedsYou:
			m.Body = "Needs you"
			if x.Activity != "" {
				m.Body += ": " + x.Activity
			}
		case x.State == sessions.YourTurn && was == sessions.Working:
			m.Body = cmp.Or(x.LastReply, "Finished. Your turn.")
		default:
			continue
		}
		go s.Push.Send(m)
	}
}

func (s *Server) pushKey(w http.ResponseWriter, r *http.Request) {
	reply(w, map[string]string{"key": s.Push.Key()})
}

func (s *Server) pushSubscribe(w http.ResponseWriter, r *http.Request) {
	var sub webpush.Subscription
	if err := json.NewDecoder(r.Body).Decode(&sub); err != nil || sub.Endpoint == "" {
		http.Error(w, "bad subscription", http.StatusBadRequest)
		return
	}
	if err := s.Push.Add(sub); err != nil {
		fail(w, err)
		return
	}
	s.refresh()
	reply(w, map[string]string{"ok": "subscribed"})
}

func (s *Server) pushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var req struct{ Endpoint string }
	json.NewDecoder(r.Body).Decode(&req)
	if err := s.Push.Remove(req.Endpoint); err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"ok": "unsubscribed"})
}

func expand(p string) (string, error) {
	if p == "" {
		return "", errors.New("dir is required")
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("dir must be absolute: %s", p)
	}
	return filepath.Clean(p), nil
}

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	if errors.Is(err, claude.ErrUntrusted) {
		code = http.StatusConflict
	}
	http.Error(w, err.Error(), code)
}
