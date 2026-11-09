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
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/backlog"
	"github.com/zcag/atc/internal/browser"
	"github.com/zcag/atc/internal/caps"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/pair"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/resources"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/settings"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/usage"
	"github.com/zcag/atc/internal/whatsapp"
	"github.com/zcag/atc/modes"
)

type Server struct {
	agentMu map[string]*sync.Mutex
	linesMu sync.Mutex
	lines   map[string]*hubLink
	wakes   map[string]time.Time
	told    map[string]string
	M       *sessions.Manager
	Res     *resources.Sampler
	Term    *attach.Hub
	Web     fs.FS
	Token   string
	Roots   []string
	Host    string
	Push    *push.Pusher
	Pages   *pages.Store
	Backlog *backlog.Store
	Browser *browser.Browser
	Peers   []Peer
	Presets []Preset
	Paired  *pair.Store
	claims  *pair.Limiter
	// AgentsDir holds a folder per agent; every machine reads it and runs the ones naming it.
	AgentsDir string
	Engines   []Engine
	// Settings is settings.json, and Version this build; capsRunner keeps the feature checks' results briefly.
	Settings   *settings.Settings
	Version    string
	capsRunner caps.Runner
	aloneAt    string
	Voice      Voice

	WhatsApp *whatsapp.Client
	Hub      *hub.Client
	// CallLine is the call line service, whose app line the phone app's calls go through; calls from
	// CallTestFrom go to CallTestLine.
	CallLine, CallTestLine string
	CallTestFrom           []string
	// CallNumber is the assistant's own phone line, which the app logs its calls under.
	CallNumber string
	// CallVoices is the voice service, which lists the voices calls can speak with and keeps the pick.
	CallVoices string
	// Pal is a pal launcher's remote address, whose panel the page can open (ATC_PAL); PalToken is pal's token for atc's site, needed off the tailnet.
	Pal, PalToken string
	// PalBarHide is the pal bar items atc leaves out (ATC_PAL_BAR_HIDE), unless a device chose its own.
	PalBarHide []string
	hub        *hubLink
	guests     *hubLink
	Reachable  func() string
	// PublicURL is where the user reaches atc (links in messages), LocalURL where this
	// machine's own browser does.
	PublicURL, LocalURL string
	wa                  *waChat

	AppDir    string
	AssistDir string
	StateDir  string

	TrustTailnet   string
	TrustedProxies *Proxies
	tailnet        *tailnet

	fleet     *fleet
	feed      *feed
	rv        *reviver
	contained time.Time
	here      presence
	scanner   outputs.Scanner
	stats     usage.Scanner
	limits    usage.LimitsClient

	prefMu sync.Mutex
	mu     sync.Mutex
	subs   map[chan []byte]bool
	last   []byte
	lastAt time.Time
	kick   chan struct{}
	seen   map[string]string
	shown  map[string]time.Time
	noted  map[string]time.Time
	held   map[string]held
	notes  notes

	web        string
	widgetSent string
	widgetAt   time.Time
	answers    answers
}

func (s *Server) Handler() http.Handler {
	s.subs = map[chan []byte]bool{}
	s.held = map[string]held{}
	if s.TrustTailnet != "" {
		s.tailnet = &tailnet{bin: s.TrustTailnet}
	}
	s.web = webVersion(s.Web)
	s.fleet = newFleet(s.Peers)
	s.feed = newFeed()
	s.feed.onDemand = s.onDemandAgents
	s.kick = make(chan struct{}, 1)
	if s.Pages == nil {
		s.Pages, _ = pages.Open("")
	}
	if s.Backlog == nil {
		s.Backlog, _ = backlog.Open("")
	}
	if s.Paired == nil {
		s.Paired, _ = pair.Open("")
	}
	s.claims = newClaimLimiter()
	if s.StateDir != "" {
		s.rv = &reviver{path: revivePath(s.StateDir)}
		if lost := s.rv.afterReboot(); len(lost) > 0 && s.rv.begin() {
			go func() {
				time.Sleep(10 * time.Second)
				s.revive(lost, s.Host+" restarted")
			}()
		}
	}
	if s.WhatsApp != nil {
		s.startWhatsApp()
	}
	if s.Hub != nil {
		s.startHub()
	}
	go s.poll()
	s.startResources()
	s.watchOpenCode()
	go s.schedule()
	go s.watchAgents()
	if s.Push != nil {
		go s.watchPushes()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /api/sessions", s.live)
	mux.HandleFunc("GET /api/feed", s.feedNews)
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
	mux.HandleFunc("GET /api/sessions/{sid}/agents", s.sessionAgents)
	mux.HandleFunc("GET /api/sessions/{sid}/background", s.backgroundOutputs)
	mux.HandleFunc("GET /api/sessions/{sid}/agents/{tool}", s.agent)
	mux.HandleFunc("GET /api/sessions/{sid}/summary", s.summary)
	mux.HandleFunc("POST /api/sessions/{sid}/summary", s.summary)
	mux.HandleFunc("POST /api/sessions/{sid}/upload", s.upload)
	mux.HandleFunc("POST /api/uploads", s.upload)
	mux.HandleFunc("POST /api/sessions/{id}/send", s.send)
	mux.HandleFunc("POST /api/sessions/{id}/keys", s.keys)
	mux.HandleFunc("POST /api/sessions/{sid}/asks/{ask}", s.answer)
	mux.HandleFunc("GET /api/widget", s.widget)
	mux.HandleFunc("GET /api/presets", s.presets)
	mux.HandleFunc("GET /api/backlog", s.backlogList)
	mux.HandleFunc("POST /api/backlog", s.backlogAdd)
	mux.HandleFunc("PATCH /api/backlog/{id}", s.backlogPatch)
	mux.HandleFunc("DELETE /api/backlog/{id}", s.backlogRemove)
	mux.HandleFunc("POST /api/backlog/{id}/start", s.backlogStart)
	mux.HandleFunc("POST /api/sessions/{sid}/aside", s.putAside)
	mux.HandleFunc("GET /api/agents", s.agents)
	mux.HandleFunc("POST /api/agents/{name}/message", s.agentMessage)
	mux.HandleFunc("POST /api/agents/{name}/reset", s.agentReset)
	mux.HandleFunc("POST /api/agents/{name}/line", s.agentLine)
	mux.HandleFunc("GET /api/agents/{name}/usage", s.agentUsage)
	mux.HandleFunc("GET /api/engines", s.engines)
	mux.HandleFunc("POST /api/presence", s.presencePost)
	mux.HandleFunc("POST /api/termlog", s.termLog)
	mux.HandleFunc("GET /api/presence", s.presenceGet)
	mux.HandleFunc("GET /api/sessions/{sid}/outputs", s.outputs)
	mux.HandleFunc("GET /api/sessions/{sid}/usage", s.sessionUsage)
	mux.HandleFunc("GET /api/sessions/{sid}/ref/file", s.refFile)
	mux.HandleFunc("GET /api/sessions/{sid}/ref/commit", s.refCommit)
	mux.HandleFunc("GET /api/sessions/{sid}/ref/repo", s.refRepo)
	mux.HandleFunc("GET /api/sessions/{sid}/ref/range", s.refRange)
	mux.HandleFunc("GET /api/sessions/{sid}/ref/issue", s.refIssue)
	mux.HandleFunc("GET /api/usage/limits", s.usageLimits)
	mux.HandleFunc("GET /api/usage/windows", s.usageWindows)
	mux.HandleFunc("GET /api/usage/spend", s.usageSpend)
	mux.HandleFunc("GET /api/usage/report", s.usageReport)
	mux.HandleFunc("GET /api/resources", s.resourcesNow)
	mux.HandleFunc("GET /api/resources/history", s.resourcesHistory)
	mux.HandleFunc("GET /api/sessions/{sid}/o/{tok}/{path...}", s.outputFile)
	mux.HandleFunc("GET /api/sessions/{sid}/pages", s.sessionPages)
	mux.HandleFunc("POST /api/sessions/{sid}/pages", s.showPage)
	mux.HandleFunc("POST /api/sessions/{sid}/open", s.openPage)
	mux.HandleFunc("DELETE /api/sessions/{sid}/pages/{name}", s.hidePage)
	mux.HandleFunc("GET /api/sessions/{sid}/pages/{name}/state", s.pageState)
	mux.HandleFunc("PUT /api/sessions/{sid}/pages/{name}/state", s.pageState)
	mux.HandleFunc("POST /api/sessions/{sid}/pages/{name}/run", s.runAction)
	mux.HandleFunc("GET /api/pages", s.allPages)
	mux.HandleFunc("POST /api/pages/phone", s.pageToPhone)
	mux.HandleFunc("POST /api/sessions/{sid}/notify", s.postNote)
	mux.HandleFunc("GET /api/browser/{sid}/cdp", s.browserCDP)
	mux.HandleFunc("GET /api/sessions/{sid}/tabs/{tab}/view", s.browserView)
	mux.HandleFunc("GET /api/sessions/{id}/attach", func(w http.ResponseWriter, r *http.Request) {
		if s.hubSession(r.PathValue("id")) {
			http.Error(w, "the assistant has no terminal: write to it in the transcript", http.StatusConflict)
			return
		}
		if s.stopped(r.Context(), r.PathValue("id")) {
			http.Error(w, "it is stopped: resume it first", http.StatusConflict)
			return
		}
		s.nameViewer(r)
		s.Term.Serve(w, r, r.PathValue("id"))
	})
	mux.HandleFunc("GET /api/trust", s.trustState)
	mux.HandleFunc("GET /api/trust/term", s.trustTerm)
	mux.HandleFunc("POST /api/call/about", s.callAbout)
	mux.HandleFunc("POST /api/call/to", s.callTo)
	mux.HandleFunc("GET /api/call/voices", s.callVoices)
	mux.HandleFunc("POST /api/call/voices", s.callVoices)
	mux.HandleFunc("GET /api/call/voices/sample", s.callVoiceSample)
	mux.HandleFunc("GET /api/call/backgrounds", s.callBackgrounds)
	mux.HandleFunc("POST /api/call/backgrounds", s.callBackgroundAdd)
	mux.HandleFunc("DELETE /api/call/backgrounds/{file}", s.callBackgroundDelete)
	mux.HandleFunc("POST /api/agents/{name}/person", s.agentPerson)
	mux.HandleFunc("GET /api/call/persons", s.callPersons)
	mux.HandleFunc("POST /api/call/persons", s.callPersonSave)
	mux.HandleFunc("POST /api/call/persons/pick", s.callPersonPick)
	mux.HandleFunc("DELETE /api/call/persons/{id}", s.callPersonDelete)
	mux.HandleFunc("PUT /api/look", s.setLook)
	mux.HandleFunc("GET /api/seen", s.getSeen)
	mux.HandleFunc("PUT /api/seen", s.putSeen)
	mux.HandleFunc("GET /api/drafts", s.getDrafts)
	mux.HandleFunc("PUT /api/drafts/{sid}", s.putDraft)
	mux.HandleFunc("GET /api/bays", s.getBays)
	mux.HandleFunc("PUT /api/bays", s.putBays)
	mux.HandleFunc("PATCH /api/bays/{bay}", s.patchBay)
	mux.HandleFunc("GET /api/caps", s.capsList)
	mux.HandleFunc("POST /api/caps/{id}/test", s.capsTest)
	mux.HandleFunc("PUT /api/settings", s.putSettings)
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) { reply(w, s.me()) })
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/pair", s.pairStart)
	mux.HandleFunc("POST "+pair.ClaimPath, s.pairClaim)
	mux.HandleFunc("GET /api/devices", s.devicesList)
	mux.HandleFunc("DELETE /api/devices/{id}", s.deviceRevoke)
	mux.HandleFunc("POST /api/push/register", s.pushRegister)
	mux.HandleFunc("POST /api/push/unregister", s.pushUnregister)
	mux.HandleFunc("POST /api/push/heard", s.pushHeard)
	mux.HandleFunc("GET /api/push/devices", func(w http.ResponseWriter, r *http.Request) { reply(w, s.Push.Devices()) })
	mux.HandleFunc("POST /api/assist", s.assist)
	mux.HandleFunc("POST /api/whatsapp/hook", s.waHook)
	mux.HandleFunc("POST /api/whatsapp/send", s.waPost)
	mux.HandleFunc("GET /api/whatsapp/guests", s.waGuests)
	mux.HandleFunc("POST /api/whatsapp/guests", s.waGuests)
	mux.HandleFunc("POST /api/call", s.call)
	mux.HandleFunc("GET /api/call/line", s.callLine)
	mux.HandleFunc("POST /api/call/diag", s.callDiag)
	mux.HandleFunc("GET /api/sessions/{sid}/stream", s.hubStream)
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
		if s.Token == "" || r.URL.Path == "/api/login" || r.URL.Path == pair.ClaimPath || r.URL.Path == "/healthz" || r.URL.Path == "/api/whatsapp/hook" || isOutputLink(r) {
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
		tok := requestToken(r)
		if s.isMaster(tok) {
			next.ServeHTTP(w, r)
			return
		}
		if id, ok := s.Paired.Check(tok); ok {
			s.asDevice(id, next, w, r)
			return
		}
		if !s.fromMyTailnet(r) {
			if s.tailnet != nil {
				log.Printf("auth: refused %s (seen as %s)", r.URL.Path, s.clientIP(r))
			}
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) isMaster(tok string) bool {
	return tok != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.Token)) == 1
}

func (s *Server) valid(tok string) bool {
	if s.isMaster(tok) {
		return true
	}
	_, ok := s.Paired.Check(tok)
	return ok
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
	me := map[string]any{"host": s.Host, "home": home, "claudeTheme": theme, "hosts": hosts, "peers": s.fleet.statuses(), "callNumber": s.CallNumber,
		"web": s.web, "call": s.CallLine != "", "look": s.look()}
	if s.Pal != "" {
		me["pal"] = map[string]any{"server": s.Pal, "token": s.PalToken, "hide": s.PalBarHide}
	}
	return me
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
	pal := ""
	if u, err := url.Parse(s.Pal); err == nil && u.Host != "" {
		pal = " " + u.Scheme + "://" + u.Host
	}
	csp := fmt.Sprintf("script-src 'self'%[1]s; frame-src 'self'%[1]s; object-src 'none'; base-uri 'self'", pal)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Security-Policy", csp)
		}
		if strings.HasPrefix(r.URL.Path, "/vendor/fonts/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
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
	path, err := saveUpload(cmp.Or(r.PathValue("sid"), "shared"), hdr.Filename, f)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"path": path})
}

func saveUpload(folder, filename string, src io.Reader) (string, error) {
	cache, _ := os.UserCacheDir()
	dir := filepath.Join(cache, "atc", "uploads", filepath.Base(folder))
	name := strings.Map(func(c rune) rune {
		if c == '/' || c == '\\' || c < ' ' {
			return '_'
		}
		return c
	}, filepath.Base(filename))
	if name == "" || name == "." {
		name = "upload"
	}
	os.MkdirAll(dir, 0o755)
	stamp := time.Now().Format("150405")
	path := filepath.Join(dir, stamp+"-"+name)
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	for i := 2; errors.Is(err, fs.ErrExist); i++ {
		path = filepath.Join(dir, fmt.Sprintf("%s-%d-%s", stamp, i, name))
		out, err = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	}
	if err != nil {
		return "", err
	}
	_, err = io.Copy(out, src)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return path, err
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
	waiting, _ := s.M.Index.Waiting(t.Path)
	reply(w, map[string]any{"turns": turns, "size": size, "waiting": waiting})
}

// backgroundOutputs is the end of what each background command and monitor of a session wrote: n lines (default 3)
// each, or of the one task id names.
func (s *Server) backgroundOutputs(w http.ResponseWriter, r *http.Request) {
	t, ok := s.M.Index.Find(r.PathValue("sid"))
	if !ok {
		http.Error(w, "no transcript", http.StatusNotFound)
		return
	}
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	reply(w, map[string]any{"outputs": claude.Outputs(t.SessionID, min(cmp.Or(n, 3), 200), r.URL.Query().Get("id"))})
}

func (s *Server) sessionAgents(w http.ResponseWriter, r *http.Request) {
	t, ok := s.M.Index.Find(r.PathValue("sid"))
	if !ok {
		http.Error(w, "no transcript", http.StatusNotFound)
		return
	}
	reply(w, map[string]any{"agents": history.Agents(t.Path)})
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

// live with recent=1 answers from the poll's snapshot while one is at most a poll old: a reader that
// only looks (the assistant mid-call) then pays nothing for listing every machine's sessions.
func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("recent") != "" && r.URL.Query().Get("local") == "" {
		s.mu.Lock()
		b, fresh := s.last, time.Since(s.lastAt) < 3*time.Second
		s.mu.Unlock()
		if fresh && b != nil {
			w.Header().Set("Content-Type", "application/json")
			w.Write(b)
			return
		}
	}
	list, err := s.liveAll(r.Context(), r.URL.Query().Get("local") != "")
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		http.Error(w, "Claude Code is not installed on this machine: atc doctor says how to set it up", http.StatusServiceUnavailable)
		return
	}
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
	list = s.hubMark(ctx, list)
	for i := range list {
		list[i].Host = s.Host
		list[i].Load = s.Res.Load(cmp.Or(list[i].ID, list[i].SessionID))
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
	s.answers.attach(list)
	s.attachTabs(list)
	s.fleet.remember(s.Host, list)
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
		if len(s.Peers) == 0 || !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == pair.ClaimPath {
			next.ServeHTTP(w, r)
			return
		}
		parts := strings.Split(r.URL.Path, "/")
		host := r.URL.Query().Get("host")
		if name, ok := strings.CutPrefix(parts[min(3, len(parts)-1)], agentRef); host == "" && len(parts) >= 4 && parts[2] == "sessions" && ok {
			host = s.agentHost(name)
		} else if host == "" && len(parts) >= 4 && parts[2] == "agents" {
			host = s.agentHost(parts[3])
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
		if len(parts) == 6 && parts[4] == "asks" || r.URL.Path == "/api/trust/term" {
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
	dir, err := folderAt(req.Dir)
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
		return s.startOpenCode(ctx, dir, req.Name, req.Prompt, e, p)
	}
	if req.Worktree {
		extra = append(extra, "--worktree="+worktreeName(req.Name))
	}
	if req.Engine != "" {
		extra = append(extra, e.args()...)
	}
	id, err := s.M.CLI.Start(ctx, dir, req.Name, req.Prompt, extra...)
	if err == nil {
		s.tag(ctx, id, func(m *store.Meta) { m.Engine = cmp.Or(req.Engine, m.Engine) })
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
		From      string
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
	if l := s.linkOf(id); l != nil {
		channel := "atc"
		if req.From != "" {
			channel = hub.Agent
		}
		s.done(w, id, s.linkSend(r.Context(), l, channel, req.Text))
		return
	}
	if req.From == "" {
		s.unparkOnInput(r.Context(), id)
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
	if l := s.linkOf(id); l != nil {
		if req.Keys == "\x1b" {
			_, err := l.c.Interrupt(r.Context(), "atc")
			s.done(w, id, err)
			return
		}
		s.done(w, id, nil)
		return
	}
	s.done(w, id, s.Term.Keys(r.Context(), id, req.Keys))
}

func (s *Server) resume(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	if s.M.OpenCode(sid) {
		s.done(w, sid, s.M.Keep(sid, store.Running))
		return
	}
	if s.hubSession(sid) {
		s.done(w, sid, nil)
		return
	}
	id, err := s.resumeSession(r.Context(), sid)
	if errors.Is(err, errUnknown) {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	s.done(w, id, err)
}

var errUnknown = errors.New("unknown session")

var errRetired = errors.New("an earlier conversation of the assistant: it stays stopped, and messages for it go to the assistant (@assistant)")

func (s *Server) resumeSession(ctx context.Context, sid string) (string, error) {
	if sessions.RetiredHub(s.M.Store.Get(sid).Name) {
		return "", errRetired
	}
	agents, _ := s.M.CLI.Agents(ctx)
	chain := s.chain(sid, agents)
	if id, ok := s.liveIn(chain, agents); ok {
		return id, nil
	}
	for i, c := range slices.Backward(chain) {
		if t, _ := s.M.Index.Find(c); t.StartCwd != "" && (i == 0 || t.SessionID == c) {
			return s.relaunch(ctx, s.standingName(c, t.AgentName), t.StartCwd, c)
		}
	}
	if t, ok := s.recorded(sid); ok && t.StartCwd != "" {
		return s.relaunch(ctx, s.standingName(sid, t.AgentName), t.StartCwd, t.SessionID)
	}
	return "", fmt.Errorf("%w %s", errUnknown, sid)
}

func (s *Server) recorded(sid string) (history.Transcript, bool) {
	for range 50 {
		if t, ok := s.M.Index.Find(sid); ok {
			return t, true
		}
		if a := s.M.Store.Get(sid).Agent; a != "" {
			return s.lastAgentTranscript(a)
		}
		prev := s.M.Store.Find(func(_ string, m store.Meta) bool { return m.Next != "" && strings.HasPrefix(sid, m.Next) })
		if len(prev) == 0 {
			break
		}
		sid = prev[0]
	}
	return history.Transcript{}, false
}

func (s *Server) liveIn(chain []string, agents []claude.Agent) (string, bool) {
	for _, c := range slices.Backward(chain) {
		if i := slices.IndexFunc(agents, func(a claude.Agent) bool { return a.SessionID == c && a.PID > 0 }); i >= 0 {
			return agents[i].ID, true
		}
	}
	return "", false
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
		Name      *string `json:"name"`
		Pinned    *bool   `json:"pinned"`
		Parked    *bool   `json:"parked"`
		ReportsTo *string `json:"reportsTo"`
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
		if req.ReportsTo != nil {
			m.ReportsTo = *req.ReportsTo
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
	Git    bool   `json:"git,omitempty"`
	Uses   int    `json:"uses,omitempty"`
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
		p := worktreeDir.ReplaceAllString(h.StartCwd, "")
		if _, seen := at[p]; strings.Contains(p, "/.claude/") || !seen && len(out) >= 30 {
			continue
		}
		if i := add(p, true); i >= 0 {
			out[i].Uses++
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
		_, err := w.Write(b)
		fl.Flush()
		return err == nil
	}
	if last != nil && !send(frame("sessions", last)) {
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

func frame(event string, data []byte) []byte {
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, data))
}

func (s *Server) broadcast(event string, data []byte) {
	b := frame(event, data)
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- b:
		default:
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
		if n == 0 && (s.Push == nil || s.Push.Count() == 0) && !s.hubUp() {
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
		if s.feed.observe(list, s.fleet.statuses(), s.isHub) && s.hubUp() {
			go s.Hub.Notice(context.Background())
		}
		b, _ := json.Marshal(list)
		s.mu.Lock()
		s.lastAt = time.Now()
		changed := !bytes.Equal(b, s.last)
		s.last = b
		s.mu.Unlock()
		if changed {
			s.broadcast("sessions", b)
		}
	}
}

func (s *Server) watch(list []sessions.Session) {
	s.trackResources(list)
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
	if time.Since(s.contained) > 30*time.Second {
		s.contained = time.Now()
		go s.shelveFinished(list)
		go s.closeRetiredHub(list)
		if unit, err := s.M.CLI.Contain(); err != nil {
			log.Printf("contain claude's daemon: %v", err)
		} else if unit != "" {
			log.Printf("moved claude's daemon into %s", unit)
		}
	}
}

func (s *Server) notify(list []sessions.Session) {
	prev := s.seen
	s.seen = states(list)
	viewing := func(x sessions.Session) bool {
		return s.Term.Viewing(x.ID) || s.fleet.viewing(x.Host, x.ID) || s.hub != nil && s.hubQuiet(x) ||
			guestWork(x) && x.State != sessions.NeedsYou
	}
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
	Type      string          `json:"type"`
	At        time.Time       `json:"at"`
	Sessions  []widgetSession `json:"sessions"`
	Assistant *widgetSaid     `json:"assistant,omitempty"`
	Look      Look            `json:"look"`
}

type widgetSaid struct {
	Text string    `json:"text"`
	At   time.Time `json:"at,omitzero"`
}

func (s *Server) widgetFeed(list []sessions.Session) widgetFeed {
	return widgetFeed{"sessions", time.Now(), widgetList(list), assistantSaid(list), s.look()}
}

func assistantSaid(list []sessions.Session) *widgetSaid {
	for _, x := range list {
		if x.Kind != "hub" {
			continue
		}
		said := x.LastReply
		if said == "" && x.Summary != nil {
			said = x.Summary.Status
		}
		if t := strings.Join(strings.Fields(said), " "); t != "" {
			return &widgetSaid{t, x.Updated}
		}
	}
	return nil
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
	Bay     string    `json:"bay,omitempty"`
	Ask     *push.Ask `json:"ask,omitempty"`
}

func widgetList(list []sessions.Session) []widgetSession {
	out := []widgetSession{}
	for _, x := range list {
		if x.Away() || x.State == sessions.Stopped || x.State == sessions.Past {
			continue
		}
		since := x.Last()
		if x.State == sessions.Working && !x.PromptAt.IsZero() {
			since = x.PromptAt
		}
		ws := widgetSession{x.ID, x.SessionID, x.Title, x.State, x.Host, x.Pinned, since, "", bayOf(x), pushAsk(x)}
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
		fmt.Fprintf(&b, "%s|%s|%s|%s|%v|%s|%s", w.SID, w.ID, w.Title, w.State, w.Pinned, w.Summary, w.Bay)
		if w.Ask != nil {
			b.WriteString("|" + w.Ask.Key)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (s *Server) widget(w http.ResponseWriter, r *http.Request) {
	list, err := s.liveAll(r.Context(), false)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, s.widgetFeed(list))
}

func (s *Server) syncWidgets(list []sessions.Session) {
	feed := s.widgetFeed(list)
	key := widgetKey(feed.Sessions)
	if key == s.widgetSent || time.Since(s.widgetAt) < 15*time.Second {
		return
	}
	s.widgetSent, s.widgetAt = key, time.Now()
	go s.Push.SendWidget(feed)
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
		if !ok || was == x.State || x.Away() || viewing(x) {
			continue
		}
		m := push.Message{Title: x.Title, Tag: x.SessionID, URL: "/#/s/" + x.SessionID, Bay: bayOf(x)}
		switch {
		case x.State == sessions.NeedsYou:
			m.Body = "Needs you"
			if x.Activity != "" {
				m.Body += ": " + x.Activity
			}
			if m.Ask = pushAsk(x); m.Ask != nil {
				m.Body = askBody(m.Ask)
			}
		case x.State == sessions.YourTurn && was == sessions.Working:
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
	if sid := s.hubSID(); s.hubUp() {
		var err error
		if r.URL.Query().Get("new") != "" {
			err = s.Hub.Reset(r.Context())
		}
		s.done(w, sid, err)
		return
	}
	id, err := s.keep(r.Context(), hubName, r.URL.Query().Get("new") != "")
	s.done(w, id, err)
}

// DefaultAssistDir is the assistant's own folder, the hub's and atc's, so it never starts in the home
// folder: Claude Code refuses a background session there unless it already has a yes on record.
func DefaultAssistDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/share/atc/assistant")
}

// keep returns the running session of a standing name (assistant, whatsapp): the newest one
// by that name, resumed when it stopped, or a new one when there is none or fresh is set.
func (s *Server) keep(ctx context.Context, name string, fresh bool) (string, error) {
	home, err := expand(cmp.Or(s.AssistDir, DefaultAssistDir()))
	if err != nil {
		return "", err
	}
	os.MkdirAll(home, 0o755)
	if !fresh {
		list, err := s.M.Live(ctx)
		if err != nil {
			return "", err
		}
		var last *sessions.Session
		for _, ours := range []bool{true, false} {
			for i, x := range list {
				named := s.M.Store.Get(x.SessionID).Name
				if x.Kind == "background" && (ours && named == name || !ours && named == "" && x.Name == name) &&
					(last == nil || x.Last().After(last.Last())) {
					last = &list[i]
				}
			}
			if last != nil {
				break
			}
		}
		if last != nil && last.Attachable {
			s.name(last.SessionID, name)
			return last.ID, nil
		}
		from, dir := "", ""
		if last != nil {
			from, dir = last.SessionID, existingDir(last.StartCwd, last.Cwd)
		} else if sid := s.hubSID(); sid != "" && name == waName {
			from, dir = sid, home
		} else if t, ok := s.lastNamed(name); ok {
			from, dir = t.SessionID, existingDir(t.StartCwd, t.Cwd)
		}
		if from != "" {
			return s.relaunch(ctx, name, dir, from)
		}
	}
	args, _ := standing(name)
	id, err := s.M.CLI.Start(ctx, home, name, "", args...)
	if err == nil {
		s.claim(ctx, name, id, "")
	}
	return id, err
}

// claim names a standing session in atc's own store once Claude has given it a session id.
// Claude renames background sessions after their content, so its name can't be what finds
// the session next time; and a resume can come back under a new id, so the conversation it
// continued gives the name up, or it would be resumed again.
func (s *Server) claim(ctx context.Context, name, id, from string) {
	for range 20 {
		list, _ := s.M.Live(ctx)
		for _, x := range list {
			if x.ID != id || x.SessionID == "" {
				continue
			}
			s.name(x.SessionID, name)
			if from != "" && from != x.SessionID {
				s.M.Store.Update(from, func(m *store.Meta) { m.Name = name + " (continued as " + x.SessionID[:min(8, len(x.SessionID))] + ")" })
			}
			return
		}
		time.Sleep(time.Second)
	}
	log.Printf("%s: could not find %s to name it", name, id)
}

func (s *Server) name(sid, name string) {
	if s.M.Store.Get(sid).Name == name {
		return
	}
	s.M.Store.Update(sid, func(m *store.Meta) { m.Name, m.Parked = name, m.Parked || name == waName })
}

// existingDir is the first of dirs still on disk: a session that worked in a git worktree
// outlives the worktree, and Claude cannot start in a folder that is gone.
func existingDir(dirs ...string) string {
	for _, d := range dirs {
		if st, err := os.Stat(d); d != "" && err == nil && st.IsDir() {
			return d
		}
	}
	return dirs[len(dirs)-1]
}

// lastNamed is the newest conversation atc named so that Claude's background service no
// longer lists, so a standing session outlives being dropped from it.
func (s *Server) lastNamed(name string) (history.Transcript, bool) {
	var last history.Transcript
	for _, sid := range s.M.Store.Find(func(_ string, m store.Meta) bool { return m.Name == name }) {
		if t, ok := s.M.Index.Find(sid); ok && t.Updated.After(last.Updated) {
			last = t
		}
	}
	return last, last.SessionID != ""
}

// standingName is the standing name atc gave a session (whatsapp, assistant) when it has one,
// since Claude's own name for it drifts, and fallback otherwise.
func (s *Server) standingName(sid, fallback string) string {
	if n := s.M.Store.Get(sid).Name; n != "" {
		if _, ok := standing(n); ok {
			return n
		}
	}
	return fallback
}

func standing(name string) ([]string, bool) {
	switch name {
	case hubName:
		return standingArgs(modes.Text("atc") + "\n\n" + switchboard), true
	case waName:
		return append(standingArgs(modes.Text(waName)+"\n\n"+switchboard), "--disallowedTools", "AskUserQuestion,EnterPlanMode"), true
	}
	return nil, false
}

func standingArgs(prompt string) []string {
	return append([]string{"--append-system-prompt", prompt}, atcTools()...)
}

func atcTools() []string {
	exe, err := os.Executable()
	if err != nil {
		return nil
	}
	cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"atc": map[string]any{"command": exe, "args": []string{"mcp"}, "alwaysLoad": true}}})
	return []string{"--mcp-config", string(cfg)}
}

func (s *Server) relaunch(ctx context.Context, name, dir, sid string) (string, error) {
	home, _ := os.UserHomeDir()
	dir = existingDir(dir, home)
	if args, ok := standing(name); ok {
		id, err := s.M.CLI.Resume(ctx, dir, sid, args...)
		if err == nil {
			s.superseded(sid, id)
			s.claim(ctx, name, id, sid)
		}
		return id, err
	}
	if a, ok := s.agentNamed(s.M.Store.Get(sid).Agent); ok {
		return s.resumeAgent(ctx, a, sid)
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
	was := s.M.Store.Get(sid)
	id, err := s.M.CLI.Resume(ctx, dir, sid, extra...)
	if err == nil {
		s.superseded(sid, id)
		s.tag(ctx, id, func(m *store.Meta) {
			m.Engine, m.Name, m.Pinned = cmp.Or(e.Name, m.Engine, was.Engine), cmp.Or(m.Name, was.Name), m.Pinned || was.Pinned
		})
	}
	return id, err
}

func (s *Server) superseded(sid, id string) {
	if id != "" && !strings.HasPrefix(sid, id) {
		s.M.Store.Update(sid, func(m *store.Meta) { m.Next = id })
	}
}

func (s *Server) chain(sid string, agents []claude.Agent) []string {
	out := []string{sid}
	for range 50 {
		next := s.M.Store.Get(sid).Next
		i := slices.IndexFunc(agents, func(a claude.Agent) bool { return next != "" && a.ID == next })
		if i < 0 {
			break
		}
		sid = agents[i].SessionID
		out = append(out, sid)
	}
	return out
}

func (s *Server) stopped(ctx context.Context, id string) bool {
	agents, err := s.M.CLI.Agents(ctx)
	return err == nil && slices.ContainsFunc(agents, func(a claude.Agent) bool { return a.ID == id && a.PID == 0 })
}

const switchboard = `You are also the user's switchboard for their other Claude Code sessions: with the atc tools you can list them, read what they did, ` +
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

func folderAt(p string) (string, error) {
	dir, err := expand(p)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(dir)
	if err == nil && !st.IsDir() {
		err = fmt.Errorf("%s is not a directory", dir)
	}
	return dir, err
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
	var u *claude.Untrusted
	if errors.As(err, &u) {
		code = http.StatusBadRequest
		if !u.Home {
			code = http.StatusConflict
			w.Header().Set(claude.UntrustedHeader, url.Values{"dir": {u.Dir}, "parent": {u.Parent}, "host": {u.Host}}.Encode())
		}
	}
	http.Error(w, err.Error(), code)
}
