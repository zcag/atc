package server

import (
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/browser"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/usage"
)

type Server struct {
	M       *sessions.Manager
	Term    *attach.Hub
	Web     fs.FS
	Token   string
	Roots   []string
	Host    string
	Push    *push.Pusher
	Pages   *pages.Store
	Browser *browser.Browser
	Peers   []Peer
	Presets []Preset
	Engines []Engine
	Voice   Voice

	AppDir    string
	AssistDir string
	StateDir  string

	TrustTailnet   string
	TrustedProxies *Proxies
	tailnet        *tailnet

	fleet   *fleet
	rv      *reviver
	here    presence
	scanner outputs.Scanner
	stats   usage.Scanner
	limits  usage.LimitsClient

	mu    sync.Mutex
	subs  map[chan []byte]bool
	last  []byte
	kick  chan struct{}
	seen  map[string]string
	shown map[string]time.Time
	noted map[string]time.Time
	held  map[string]held
	notes notes

	web        string
	widgetSent string
	widgetAt   time.Time
}

func (s *Server) Handler() http.Handler {
	s.subs = map[chan []byte]bool{}
	s.held = map[string]held{}
	if s.TrustTailnet != "" {
		s.tailnet = &tailnet{bin: s.TrustTailnet}
	}
	s.web = webVersion(s.Web)
	s.fleet = &fleet{peers: s.Peers, client: &http.Client{}, owner: map[string]string{}, status: map[string]string{}, views: map[string]int{}}
	s.kick = make(chan struct{}, 1)
	if s.Pages == nil {
		s.Pages, _ = pages.Open("")
	}
	if s.StateDir != "" {
		s.rv = &reviver{path: revivePath(s.StateDir)}
		if lost := s.rv.afterReboot(); len(lost) > 0 {
			go func() {
				time.Sleep(10 * time.Second)
				s.revive(lost, s.Host+" restarted")
			}()
		}
	}
	go s.poll()
	s.watchOpenCode()
	s.schedule()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /api/sessions", s.live)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("GET /api/dirs", s.dirs)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("POST /api/sessions", s.start)
	mux.HandleFunc("POST /api/sessions/{sid}/resume", s.resume)
	mux.HandleFunc("POST /api/sessions/{id}/stop", s.act(s.stop))
	mux.HandleFunc("DELETE /api/sessions/{id}", s.act(s.remove))
	mux.HandleFunc("PATCH /api/sessions/{sid}", s.patch)
	mux.HandleFunc("GET /api/sessions/{sid}/transcript", s.transcript)
	mux.HandleFunc("GET /api/sessions/{sid}/turns", s.turns)
	mux.HandleFunc("GET /api/sessions/{sid}/tasks/{task}", s.task)
	mux.HandleFunc("GET /api/sessions/{sid}/search", s.search)
	mux.HandleFunc("GET /api/sessions/{sid}/agents/{tool}", s.agent)
	mux.HandleFunc("GET /api/sessions/{sid}/summary", s.summary)
	mux.HandleFunc("POST /api/sessions/{sid}/summary", s.summary)
	mux.HandleFunc("POST /api/sessions/{sid}/upload", s.upload)
	mux.HandleFunc("POST /api/uploads", s.upload)
	mux.HandleFunc("POST /api/sessions/{id}/send", s.send)
	mux.HandleFunc("POST /api/sessions/{id}/keys", s.keys)
	mux.HandleFunc("POST /api/sessions/{sid}/asks/{ask}", s.answer)
	mux.HandleFunc("POST /api/guess", s.guess)
	mux.HandleFunc("GET /api/widget", s.widget)
	mux.HandleFunc("GET /api/presets", s.presets)
	mux.HandleFunc("GET /api/apps", s.apps)
	mux.HandleFunc("GET /api/engines", s.engines)
	mux.HandleFunc("POST /api/presence", s.presencePost)
	mux.HandleFunc("POST /api/termlog", s.termLog)
	mux.HandleFunc("GET /api/presence", s.presenceGet)
	mux.HandleFunc("GET /api/sessions/{sid}/outputs", s.outputs)
	mux.HandleFunc("GET /api/sessions/{sid}/usage", s.sessionUsage)
	mux.HandleFunc("GET /api/usage/limits", s.usageLimits)
	mux.HandleFunc("GET /api/usage/windows", s.usageWindows)
	mux.HandleFunc("GET /api/usage/spend", s.usageSpend)
	mux.HandleFunc("GET /api/usage/report", s.usageReport)
	mux.HandleFunc("GET /api/sessions/{sid}/o/{tok}/{path...}", s.outputFile)
	mux.HandleFunc("GET /api/sessions/{sid}/pages", s.sessionPages)
	mux.HandleFunc("POST /api/sessions/{sid}/pages", s.showPage)
	mux.HandleFunc("DELETE /api/sessions/{sid}/pages/{name}", s.hidePage)
	mux.HandleFunc("GET /api/sessions/{sid}/pages/{name}/state", s.pageState)
	mux.HandleFunc("PUT /api/sessions/{sid}/pages/{name}/state", s.pageState)
	mux.HandleFunc("POST /api/sessions/{sid}/pages/{name}/run", s.runAction)
	mux.HandleFunc("GET /api/pages", s.allPages)
	mux.HandleFunc("POST /api/sessions/{sid}/notify", s.postNote)
	mux.HandleFunc("GET /api/browser/{sid}/cdp", s.browserCDP)
	mux.HandleFunc("GET /api/sessions/{sid}/tabs/{tab}/view", s.browserView)
	mux.HandleFunc("GET /api/sessions/{id}/attach", func(w http.ResponseWriter, r *http.Request) {
		s.nameViewer(r)
		s.Term.Serve(w, r, r.PathValue("id"))
	})
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) { reply(w, s.me()) })
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/voice/stt", s.stt)
	mux.HandleFunc("POST /api/voice/condense", s.condense)
	mux.HandleFunc("POST /api/voice/finished", s.finished)
	mux.HandleFunc("POST /api/voice/tts", s.tts)
	mux.HandleFunc("POST /api/push/register", s.pushRegister)
	mux.HandleFunc("POST /api/push/unregister", s.pushUnregister)
	mux.HandleFunc("GET /api/push/devices", func(w http.ResponseWriter, r *http.Request) { reply(w, s.Push.Devices()) })
	mux.HandleFunc("POST /api/assist", s.assist)
	mux.Handle("GET /app/", s.app())
	mux.Handle("GET /", s.static())
	return s.auth(s.route(mux))
}

func crossSite(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return false
	}
	u, err := url.Parse(o)
	return err != nil || u.Host != r.Host
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && crossSite(r) {
			log.Printf("auth: refused cross-site %s %s from %s", r.Method, r.URL.Path, r.Header.Get("Origin"))
			http.Error(w, "cross-site request refused", http.StatusForbidden)
			return
		}
		if s.Token == "" || r.URL.Path == "/api/login" || r.URL.Path == "/healthz" || outputPath.MatchString(r.URL.Path) {
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
		if !s.valid(tok) && !s.fromMyTailnet(r) {
			if s.tailnet != nil {
				log.Printf("auth: refused %s (seen as %s)", r.URL.Path, s.clientIP(r))
			}
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

func (s *Server) me() map[string]any {
	home, _ := os.UserHomeDir()
	var cfg struct{ Theme string }
	if b, err := os.ReadFile(filepath.Join(home, ".claude.json")); err == nil {
		json.Unmarshal(b, &cfg)
	}
	theme := "dark"
	if strings.HasPrefix(cfg.Theme, "light") {
		theme = "light"
	}
	hosts := []string{s.Host}
	for _, p := range s.Peers {
		hosts = append(hosts, p.Name)
	}
	return map[string]any{"host": s.Host, "home": home, "claudeTheme": theme, "hosts": hosts, "peers": s.fleet.statuses(),
		"voice": map[string]bool{"stt": s.Voice.STT != "", "tts": s.Voice.TTS != "", "condense": s.Voice.LLM != ""}, "web": s.web}
}

func webVersion(web fs.FS) string {
	h := sha256.New()
	fs.WalkDir(web, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(web, p)
			fmt.Fprintf(h, "%s %d\n", p, len(b))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:12]
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
		if strings.HasPrefix(r.URL.Path, "/vendor/") {
			w.Header().Set("Cache-Control", "public, max-age=86400")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
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
	dir := filepath.Join(cache, "atc", "uploads", filepath.Base(cmp.Or(r.PathValue("sid"), "shared")))
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
	q := r.URL.Query()
	from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
	to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
	if sid := r.PathValue("sid"); s.M.OpenCode(sid) {
		p, err := s.M.OC.Page(r.Context(), sid)
		if err != nil {
			fail(w, err)
			return
		}
		if q.Has("from") {
			n := int64(len(p.Messages))
			if to <= 0 || to > n {
				to = n
			}
			p.Messages, p.Start = p.Messages[min(from, to):to], from
		}
		reply(w, p)
		return
	}
	t, ok := s.findTranscript(w, r)
	if !ok {
		return
	}
	var p history.Page
	var err error
	if q.Has("from") {
		p, err = history.ReadRange(t.Path, from, to)
	} else {
		before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
		p, err = history.ReadPage(t.Path, before, 2<<20)
	}
	if err != nil {
		fail(w, err)
		return
	}
	for i, m := range p.Messages {
		if u := m.Usage; u != nil {
			p.Messages[i].Cost = Priced(m.Model, *u)
		}
	}
	reply(w, p)
}

func Priced(model string, u history.Usage) float64 {
	c, _ := usage.Cost(model, usage.Tokens{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}, u.Write1h, false)
	return c
}

func (s *Server) findTranscript(w http.ResponseWriter, r *http.Request) (history.Transcript, bool) {
	t, ok := s.M.Index.Find(r.PathValue("sid"))
	if !ok {
		if s.running(r.Context(), r.PathValue("sid")) {
			reply(w, map[string]any{"messages": []history.Message{}, "turns": []history.Turn{}, "hits": []history.Hit{}})
		} else {
			http.Error(w, "no transcript", http.StatusNotFound)
		}
	}
	return t, ok
}

func (s *Server) task(w http.ResponseWriter, r *http.Request) {
	t, ok := s.M.Index.Find(r.PathValue("sid"))
	if !ok {
		http.Error(w, "no transcript", http.StatusNotFound)
		return
	}
	src, ok := history.FindTask(t.Path, r.PathValue("task"))
	if !ok {
		http.Error(w, "that task is not in the transcript", http.StatusNotFound)
		return
	}
	reply(w, src)
}

func (s *Server) turns(w http.ResponseWriter, r *http.Request) {
	if sid := r.PathValue("sid"); s.M.OpenCode(sid) {
		p, err := s.M.OC.Page(r.Context(), sid)
		if err != nil {
			fail(w, err)
			return
		}
		offs := make([]int64, len(p.Messages))
		for i := range offs {
			offs[i] = int64(i)
		}
		reply(w, map[string]any{"turns": history.BuildTurns(p.Messages, offs, int64(len(p.Messages)), Priced), "size": len(p.Messages)})
		return
	}
	t, ok := s.findTranscript(w, r)
	if !ok {
		return
	}
	turns, size, err := s.M.Index.Turns(t.Path)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]any{"turns": turns, "size": size})
}

func (s *Server) agent(w http.ResponseWriter, r *http.Request) {
	t, ok := s.M.Index.Find(r.PathValue("sid"))
	if !ok {
		http.Error(w, "no transcript", http.StatusNotFound)
		return
	}
	p, err := history.ReadAgent(t.Path, r.PathValue("tool"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	for i, m := range p.Messages {
		if u := m.Usage; u != nil {
			p.Messages[i].Cost = Priced(m.Model, *u)
		}
	}
	reply(w, p)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 || s.M.OpenCode(r.PathValue("sid")) {
		reply(w, map[string]any{"hits": []history.Hit{}})
		return
	}
	t, ok := s.findTranscript(w, r)
	if !ok {
		return
	}
	turns, _, err := s.M.Index.Turns(t.Path)
	if err != nil {
		fail(w, err)
		return
	}
	hits, err := history.Search(t.Path, q, turns, 60)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]any{"hits": hits})
}

func (s *Server) running(ctx context.Context, sid string) bool {
	agents, _ := s.M.CLI.Agents(ctx)
	return slices.ContainsFunc(agents, func(a claude.Agent) bool { return a.SessionID == sid })
}

func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	list, err := s.liveAll(r.Context(), r.URL.Query().Get("local") != "")
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, list)
}

func (s *Server) liveAll(ctx context.Context, localOnly bool) ([]sessions.Session, error) {
	list, err := s.M.Live(ctx)
	if err != nil {
		return nil, err
	}
	for i := range list {
		list[i].Host = s.Host
		if list[i].PID > 0 {
			for _, l := range s.M.Ports.Of(list[i].PID) {
				if !l.LocalOnly {
					list[i].Servers = append(list[i].Servers, l.Port)
				}
			}
		}
	}
	s.attachPages(list)
	s.notes.attach(list)
	s.attachTabs(list)
	if localOnly || len(s.Peers) == 0 {
		return list, nil
	}
	list = append(list, s.fleet.gather(ctx, "/api/sessions?local=1")...)
	sessions.Sort(list)
	return list, nil
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 100
	}
	local := s.M.History(q.Get("q"), q.Get("dir"), limit)
	for i := range local {
		local[i].Host = s.Host
	}
	if q.Get("local") != "" || len(s.Peers) == 0 {
		reply(w, local)
		return
	}
	q.Set("local", "1")
	q.Set("limit", strconv.Itoa(limit))
	reply(w, mergeHistory([][]sessions.Session{local, s.fleet.gather(r.Context(), "/api/history?"+q.Encode())}, limit))
}

func (s *Server) route(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(s.Peers) == 0 || !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		parts := strings.Split(r.URL.Path, "/")
		host := r.URL.Query().Get("host")
		if host == "" && len(parts) >= 4 && parts[2] == "sessions" && s.localApp(parts[3]) {
			host = s.Host
		} else if host == "" && len(parts) >= 4 && parts[2] == "sessions" {
			if host = s.fleet.ownerOf(parts[3]); host == "" {
				s.fleet.gather(r.Context(), "/api/sessions?local=1")
				host = s.fleet.ownerOf(parts[3])
			}
		}
		p := s.fleet.peer(host)
		if p == nil || host == s.Host {
			next.ServeHTTP(w, r)
			return
		}
		attachID := ""
		if len(parts) == 5 && parts[4] == "attach" {
			attachID = parts[3]
			s.nameViewer(r)
		}
		s.fleet.proxy(w, r, p, attachID)
	})
}

type startReq struct {
	Dir, Name, Prompt, Preset, Engine string
	Worktree                          bool
}

type badRequest struct{ error }

func badf(format string, a ...any) error { return badRequest{fmt.Errorf(format, a...)} }

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	var req startReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	id, err := s.startSession(r.Context(), req)
	if errors.As(err, new(badRequest)) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.done(w, id, err)
}

func (s *Server) startSession(ctx context.Context, req startReq) (string, error) {
	var p Preset
	if req.Preset != "" {
		var ok bool
		if p, ok = s.preset(req.Preset); !ok {
			return "", badf("no preset named %s", req.Preset)
		}
		req.Dir, req.Name, req.Worktree = cmp.Or(req.Dir, p.Dir), cmp.Or(req.Name, p.Name), req.Worktree || p.Worktree
	}
	dir, err := expand(req.Dir)
	if err == nil {
		var st os.FileInfo
		if st, err = os.Stat(dir); err == nil && !st.IsDir() {
			err = fmt.Errorf("%s is not a directory", dir)
		}
	}
	if err != nil {
		return "", badRequest{err}
	}
	extra, err := p.extra(dir)
	if err != nil {
		return "", err
	}
	var e Engine
	if req.Engine != "" {
		var ok bool
		if e, ok = s.engine(req.Engine); !ok {
			return "", badf("no engine named %s", req.Engine)
		}
	}
	if e.Harness == opencode.Harness {
		if req.Worktree {
			return "", badf("a git worktree needs Claude; opencode sessions start in the folder itself")
		}
		var pp *Preset
		if req.Preset != "" {
			pp = &p
		}
		return s.startOpenCode(ctx, dir, req.Name, req.Prompt, e, pp)
	}
	if req.Worktree {
		extra = append(extra, "--worktree="+worktreeName(req.Name))
	}
	if req.Engine != "" {
		extra = append(extra, e.args()...)
	}
	id, err := s.M.CLI.Start(ctx, dir, req.Name, req.Prompt, extra...)
	if err == nil {
		s.tag(ctx, id, req.Engine, p.appName())
	}
	return id, err
}

func worktreeName(name string) string {
	slug := strings.Trim(strings.Map(func(c rune) rune {
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' {
			return c
		}
		return '-'
	}, strings.ToLower(name)), "-")
	if len(slug) > 40 {
		slug = strings.TrimRight(slug[:40], "-")
	}
	return cmp.Or(slug, "atc") + "-" + time.Now().Format("0102-1504")
}

func (s *Server) send(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text      string
		Suggested bool
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "text is required", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	if req.Suggested {
		log.Printf("send %s: suggested reply %q", id, req.Text)
	}
	if s.M.OpenCode(id) {
		s.done(w, id, s.sendOpenCode(r.Context(), id, req.Text))
		return
	}
	s.done(w, id, s.Term.Send(r.Context(), id, req.Text))
}

func (s *Server) keys(w http.ResponseWriter, r *http.Request) {
	var req struct{ Keys string }
	json.NewDecoder(r.Body).Decode(&req)
	if req.Keys != "\x1b" && req.Keys != "\r" {
		http.Error(w, "keys is Esc or Enter", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	s.done(w, id, s.Term.Keys(r.Context(), id, req.Keys))
}

func (s *Server) resume(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	if s.M.OpenCode(sid) {
		s.done(w, sid, s.M.Keep(sid, store.Running))
		return
	}
	t, _ := s.M.Index.Find(sid)
	dir, name := t.StartCwd, t.AgentName
	if dir == "" {
		http.Error(w, "unknown session "+sid, http.StatusNotFound)
		return
	}
	id, err := s.relaunch(r.Context(), name, dir, sid)
	s.done(w, id, err)
}

func (s *Server) act(f func(context.Context, string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.rv != nil {
			s.rv.stopping(r.PathValue("id"))
		}
		s.done(w, r.PathValue("id"), f(r.Context(), r.PathValue("id")))
	}
}

func (s *Server) patch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   *string `json:"name"`
		Pinned *bool   `json:"pinned"`
		Parked *bool   `json:"parked"`
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
		if req.Parked != nil {
			m.Parked = *req.Parked
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
	Path   string   `json:"path"`
	Recent bool     `json:"recent,omitempty"`
	Git    bool     `json:"git,omitempty"`
	Titles []string `json:"-"`
}

func (s *Server) dirs(w http.ResponseWriter, r *http.Request) {
	reply(w, s.dirList())
}

func (s *Server) dirList() []dir {
	at := map[string]int{}
	var out []dir
	add := func(p string, recent bool) int {
		if p == "" {
			return -1
		}
		if i, ok := at[p]; ok {
			return i
		}
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			return -1
		}
		_, err := os.Stat(filepath.Join(p, ".git"))
		at[p] = len(out)
		out = append(out, dir{Path: p, Recent: recent, Git: err == nil})
		return at[p]
	}
	for _, h := range s.M.History("", "", 0) {
		if _, seen := at[h.StartCwd]; !seen && len(out) >= 30 {
			continue
		}
		if i := add(h.StartCwd, true); i >= 0 && len(out[i].Titles) < 4 && h.Title != "" {
			out[i].Titles = append(out[i].Titles, h.Title)
		}
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
	return out
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
	var idle int
	for {
		select {
		case <-t.C:
		case <-s.kick:
		}
		s.mu.Lock()
		n := len(s.subs)
		s.mu.Unlock()
		if n == 0 && (s.Push == nil || s.Push.Count() == 0) {
			s.seen, s.shown, s.noted = nil, nil, nil
			if idle++; s.rv == nil || idle%8 != 0 {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			list, err := s.M.Live(ctx)
			cancel()
			if err == nil {
				s.watch(list)
			}
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		list, err := s.liveAll(ctx, false)
		cancel()
		if err != nil {
			log.Printf("poll: %v", err)
			continue
		}
		s.watch(list)
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

func (s *Server) watch(list []sessions.Session) {
	if s.rv == nil {
		return
	}
	now := runningOf(list, s.Host)
	if lost := s.rv.observe(now); len(lost) > 0 {
		go s.revive(lost, "Claude's background service on "+s.Host+" stopped")
	}
	var ids []string
	for _, r := range now {
		if r.Harness == "" {
			ids = append(ids, r.ID)
		}
	}
	if err := claude.KeepAlive(ids); err != nil {
		log.Printf("keep alive: %v", err)
	}
}

func (s *Server) notify(list []sessions.Session) {
	prev := s.seen
	s.seen = states(list)
	viewing := func(x sessions.Session) bool { return s.Term.Viewing(x.ID) || s.fleet.viewing(x.Host, x.ID) }
	shown, showing := pageAlerts(s.shown, list, viewing)
	s.shown = shown
	noted, normal, urgent := noteAlerts(s.noted, list, viewing)
	s.noted = noted
	if prev == nil || s.Push == nil {
		return
	}
	if len(urgent) > 0 {
		go s.pushAll(urgent, true)
	}
	ms, later := alerts(prev, list, viewing)
	ms = append(ms, showing...)
	ms = append(ms, normal...)
	for _, m := range later {
		s.held[m.Tag] = held{m, time.Now().Add(holdForSummary)}
	}
	if ms = append(ms, s.release(list)...); len(ms) > 0 {
		go s.pushAll(ms, false)
	}
	s.syncWidgets(list)
}

type widgetFeed struct {
	Type     string          `json:"type"`
	At       time.Time       `json:"at"`
	Sessions []widgetSession `json:"sessions"`
}

type widgetSession struct {
	ID      string    `json:"id,omitempty"`
	SID     string    `json:"sid"`
	Title   string    `json:"title"`
	State   string    `json:"state"`
	Host    string    `json:"host,omitempty"`
	Pinned  bool      `json:"pinned,omitempty"`
	Since   time.Time `json:"since,omitzero"`
	Summary string    `json:"summary,omitempty"`
}

func widgetList(list []sessions.Session) []widgetSession {
	out := []widgetSession{}
	for _, x := range list {
		if x.Parked || x.Hidden() || x.State == sessions.Stopped || x.State == sessions.Past {
			continue
		}
		since := x.Last()
		if x.State == sessions.Working && !x.PromptAt.IsZero() {
			since = x.PromptAt
		}
		ws := widgetSession{x.ID, x.SessionID, x.Title, x.State, x.Host, x.Pinned, since, ""}
		if x.Summary != nil && x.State != sessions.Working {
			ws.Summary = x.Summary.Status
		}
		out = append(out, ws)
		if len(out) == 12 {
			break
		}
	}
	return out
}

func widgetKey(ws []widgetSession) string {
	var b strings.Builder
	for _, w := range ws {
		fmt.Fprintf(&b, "%s|%s|%s|%s|%v|%s\n", w.SID, w.ID, w.Title, w.State, w.Pinned, w.Summary)
	}
	return b.String()
}

func (s *Server) widget(w http.ResponseWriter, r *http.Request) {
	list, err := s.liveAll(r.Context(), false)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, widgetFeed{"sessions", time.Now(), widgetList(list)})
}

func (s *Server) syncWidgets(list []sessions.Session) {
	ws := widgetList(list)
	key := widgetKey(ws)
	if key == s.widgetSent || time.Since(s.widgetAt) < 15*time.Second {
		return
	}
	s.widgetSent, s.widgetAt = key, time.Now()
	go s.Push.SendWidget(widgetFeed{"sessions", time.Now(), ws})
}

func states(list []sessions.Session) map[string]string {
	m := map[string]string{}
	for _, x := range list {
		m[x.SessionID] = x.State
	}
	return m
}

func (s *Server) pushAll(ms []push.Message, urgent bool) {
	if !urgent {
		if ok, where := s.userActive(context.Background()); ok {
			log.Printf("push: held %d, you are active (%s)", len(ms), where)
			return
		}
	}
	for _, m := range ms {
		s.Push.Send(m)
	}
}

func alerts(prev map[string]string, list []sessions.Session, viewing func(sessions.Session) bool) (out, later []push.Message) {
	for _, x := range list {
		was, ok := prev[x.SessionID]
		if !ok || was == x.State || x.Parked || viewing(x) {
			continue
		}
		m := push.Message{Title: x.Title, Tag: x.SessionID, URL: "/#/s/" + x.SessionID}
		switch {
		case x.State == sessions.NeedsYou:
			m.Body = "Needs you"
			if x.Activity != "" {
				m.Body += ": " + x.Activity
			}
		case x.State == sessions.YourTurn && was == sessions.Working && x.App == "":
			m.Body = cmp.Or(pushBody(x.Summary), x.LastReply, "Finished. Your turn.")
			answerable(&m, x)
			if x.Summary == nil && x.Summarizing {
				later = append(later, m)
				continue
			}
		default:
			continue
		}
		out = append(out, m)
	}
	return out, later
}

func (s *Server) pushRegister(w http.ResponseWriter, r *http.Request) {
	var d push.Device
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil || !strings.HasPrefix(d.Endpoint, "http") {
		http.Error(w, "bad endpoint", http.StatusBadRequest)
		return
	}
	if err := s.Push.Add(d); err != nil {
		fail(w, err)
		return
	}
	s.refresh()
	reply(w, map[string]string{"ok": "registered"})
}

func (s *Server) pushUnregister(w http.ResponseWriter, r *http.Request) {
	var d push.Device
	json.NewDecoder(r.Body).Decode(&d)
	if err := s.Push.Remove(d.Endpoint); err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"ok": "unregistered"})
}

func (s *Server) assist(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("new") == "" {
		list, err := s.M.Live(r.Context())
		if err != nil {
			fail(w, err)
			return
		}
		var last *sessions.Session
		for i, x := range list {
			if x.Kind == "background" && (x.Name == "assistant" || s.M.Store.Get(x.SessionID).Name == "assistant") &&
				(last == nil || x.Last().After(last.Last())) {
				last = &list[i]
			}
		}
		if last != nil && last.Attachable {
			reply(w, map[string]string{"id": last.ID})
			return
		}
		if last != nil {
			dir := cmp.Or(last.StartCwd, last.Cwd)
			id, err := s.relaunch(r.Context(), "assistant", dir, last.SessionID)
			s.done(w, id, err)
			return
		}
	}
	dir, err := expand(cmp.Or(s.AssistDir, "~"))
	if err != nil {
		fail(w, err)
		return
	}
	id, err := s.M.CLI.Start(r.Context(), dir, "assistant", "", assistArgs()...)
	s.done(w, id, err)
}

func assistArgs() []string {
	extra := []string{"--append-system-prompt", voicePrompt}
	if exe, err := os.Executable(); err == nil {
		cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"atc": map[string]any{"command": exe, "args": []string{"mcp"}}}})
		extra = append(extra, "--mcp-config", string(cfg))
	}
	return extra
}

func (s *Server) relaunch(ctx context.Context, name, dir, sid string) (string, error) {
	if name == "assistant" {
		return s.M.CLI.Resume(ctx, dir, sid, assistArgs()...)
	}
	var extra []string
	if p, ok := s.preset(name); ok {
		var err error
		if extra, err = p.extra(dir); err != nil {
			log.Printf("resume %s: %v", name, err)
		}
	}
	e, ok := s.engineOf(sid)
	if ok {
		extra = append(extra, e.args()...)
	}
	id, err := s.M.CLI.Resume(ctx, dir, sid, extra...)
	if err == nil {
		s.tag(ctx, id, e.Name, s.M.Store.Get(sid).App)
	}
	return id, err
}

const voicePrompt = `This session is used by voice. The user speaks to you through speech-to-text and hears your replies through text-to-speech. ` +
	`Answer the way you would say it out loud: short, natural sentences, the important part first. No markdown, no code blocks, no tables, no bullet lists, ` +
	`no URLs read out; say file and command names plainly. When the work produces something long (code, a report, a list), put it in a file or the session ` +
	`and tell the user briefly where it is. Transcription can mishear words: if a request is ambiguous, ask a short question. ` +
	`You are also the user's switchboard for their other Claude Code sessions: with the atc tools you can list them, read what they did, ` +
	`send them instructions, start new ones and wait for results. When the user mentions another session or project, use those tools ` +
	`rather than doing the work yourself, and match names loosely since speech-to-text mangles them.`

func (s *Server) app() http.Handler {
	if s.AppDir == "" {
		return http.NotFoundHandler()
	}
	files := http.StripPrefix("/app/", http.FileServer(http.Dir(s.AppDir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		switch {
		case strings.HasSuffix(r.URL.Path, ".apk"):
			w.Header().Set("Content-Type", "application/vnd.android.package-archive")
		case r.URL.Path == "/app/":
			var v struct{ VersionName string }
			if b, err := os.ReadFile(filepath.Join(s.AppDir, "version.json")); err == nil {
				json.Unmarshal(b, &v)
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprintf(w, appPage, cmp.Or(v.VersionName, "not built yet"))
			return
		}
		files.ServeHTTP(w, r)
	})
}

const appPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>atc for Android</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}a.b{display:inline-block;padding:.7rem 1.1rem;border-radius:8px;background:#1d2533;color:#fff;text-decoration:none}</style>
<h1>atc for Android</h1><p>Version %s.</p><p><a class="b" href="atc.apk">Download the app</a></p>
<p>Open the downloaded file to install or update it. Android asks once to allow installs from your browser.</p>`

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
