package server

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/startover"
	"github.com/zcag/atc/internal/store"
)

const agentRef = "@"

// Agent is a standing conversation defined by a folder: agent.json, brief.md, and settings.json
// and mcp.json when they are there, all read fresh each time it starts or resumes.
type Agent struct {
	Name   string     `json:"name"`
	Folder string     `json:"folder"`
	Host   string     `json:"host"`
	Title  string     `json:"title,omitempty"`
	Icon   string     `json:"icon,omitempty"`
	Color  string     `json:"color,omitempty"`
	Dir    string     `json:"dir,omitempty"`
	Args   []string   `json:"args,omitempty"`
	Every  string     `json:"every,omitempty"`
	From   string     `json:"from,omitempty"`
	Check  string     `json:"check,omitempty"`
	Prompt string     `json:"prompt,omitempty"`
	Reset  *resetSpec `json:"reset,omitempty"`
	Err    string     `json:"error,omitempty"`
}

type resetSpec struct {
	Quiet    string `json:"quiet,omitempty"`
	Over     int    `json:"over,omitempty"`
	CapQuiet string `json:"capQuiet,omitempty"`
	Cap      int    `json:"cap,omitempty"`
}

func loadAgents(root string) []Agent {
	root, err := expand(root)
	if err != nil {
		return nil
	}
	ents, _ := os.ReadDir(root)
	var out []Agent
	for _, e := range ents {
		folder := filepath.Join(root, e.Name())
		b, err := os.ReadFile(filepath.Join(folder, "agent.json"))
		if !e.IsDir() || os.IsNotExist(err) {
			continue
		}
		var a Agent
		if err == nil {
			err = json.Unmarshal(b, &a)
		}
		a.Name, a.Folder = e.Name(), folder
		if err == nil {
			err = a.valid()
		}
		if err != nil {
			a.Err = err.Error()
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (a Agent) valid() error {
	if a.Host == "" {
		return errors.New("agent.json needs a host: the machine it runs on")
	}
	if _, err := a.interval(); err != nil {
		return err
	}
	_, err := a.policy()
	return err
}

func (a Agent) policy() (startover.Policy, error) {
	p := startover.Default
	if a.Reset == nil {
		return p, nil
	}
	for _, d := range []struct {
		s   string
		dst *time.Duration
	}{{a.Reset.Quiet, &p.Quiet}, {a.Reset.CapQuiet, &p.CapQuiet}} {
		if d.s == "" {
			continue
		}
		v, err := time.ParseDuration(d.s)
		if err != nil {
			return p, fmt.Errorf("reset: %w", err)
		}
		*d.dst = v
	}
	p.Small, p.Cap = cmp.Or(a.Reset.Over, p.Small), cmp.Or(a.Reset.Cap, p.Cap)
	return p, nil
}

func (a Agent) label() string { return cmp.Or(a.Title, a.Name) }

func (a Agent) dir() string {
	d, err := expand(cmp.Or(a.Dir, a.Folder))
	if err != nil {
		return a.Folder
	}
	return d
}

func (a Agent) args() ([]string, error) {
	extra := append([]string(nil), a.Args...)
	brief, err := os.ReadFile(filepath.Join(a.Folder, "brief.md"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	extra = append(extra, "--append-system-prompt", a.standing()+"\n\n"+string(brief))
	for _, f := range []struct{ flag, file string }{{"--settings", "settings.json"}, {"--mcp-config", "mcp.json"}} {
		if p := filepath.Join(a.Folder, f.file); exists(p) {
			extra = append(extra, f.flag, p)
		}
	}
	return extra, nil
}

func (a Agent) standing() string {
	return fmt.Sprintf(`You are the %s agent (%s%s in atc): one standing conversation the user comes back to. Your folder is %s.

- Messages reach you from the user, from your schedule and from other tools. One that is not from the user starts with a line in brackets saying where it came from.
- This conversation starts over now and then, with a handover note. Keep what must outlive it in notes.md in your folder, and read that file when a conversation starts.
- Park yourself (atc's park tool, or `+"`atc park`"+`) when your work with the user is done: nothing left for them to answer or look at. A parked agent leaves their list. When a wake-up turns up something for them, unpark (park with unpark) before you tell them; otherwise stay parked and keep it short.
- Show pages with atc show; they belong to you, not to one conversation.`, a.label(), agentRef, a.Name, a.Folder)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (s *Server) agentList() []Agent { return loadAgents(s.AgentsDir) }

// agentHost is the machine an agent runs on, from its folder, which every machine sees.
func (s *Server) agentHost(name string) string {
	for _, a := range s.agentList() {
		if a.Name == name {
			return a.Host
		}
	}
	return ""
}

func (s *Server) agentNamed(name string) (Agent, bool) {
	for _, a := range s.agentList() {
		if a.Name == name && a.Host == s.Host && a.Err == "" {
			return a, true
		}
	}
	return Agent{}, false
}

func (s *Server) localAgents() []Agent {
	var out []Agent
	for _, a := range s.agentList() {
		if a.Host == s.Host && a.Err == "" {
			out = append(out, a)
		}
	}
	return out
}

func (s *Server) localAgent(ref string) bool {
	name, ok := strings.CutPrefix(ref, agentRef)
	_, found := s.agentNamed(name)
	return ok && found
}

// owner is who a session's pages belong to: its agent, so every conversation it has shows the
// same pages, or the session itself.
func (s *Server) owner(sid string) string {
	if a := s.M.Store.Get(sid).Agent; a != "" {
		return agentRef + a
	}
	return sid
}

func (s *Server) agentLock(name string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.agentMu == nil {
		s.agentMu = map[string]*sync.Mutex{}
	}
	if s.agentMu[name] == nil {
		s.agentMu[name] = &sync.Mutex{}
	}
	return s.agentMu[name]
}

// agentSession is the agent's current conversation: its newest one Claude still lists.
func agentSession(live []sessions.Session, name string) *sessions.Session {
	var cur *sessions.Session
	for i, x := range live {
		if x.Agent == name && (cur == nil || x.StartedAt.After(cur.StartedAt)) {
			cur = &live[i]
		}
	}
	return cur
}

func (s *Server) lastAgentTranscript(name string) (history.Transcript, bool) {
	var last history.Transcript
	for _, sid := range s.M.Store.Find(func(_ string, m store.Meta) bool { return m.Agent == name }) {
		if t, ok := s.M.Index.Find(sid); ok && t.Updated.After(last.Updated) {
			last = t
		}
	}
	return last, last.SessionID != ""
}

func (s *Server) wakeAgent(ctx context.Context, a Agent, text string) (string, error) {
	mu := s.agentLock(a.Name)
	mu.Lock()
	defer mu.Unlock()
	return s.deliverAgent(ctx, a, text)
}

// deliverAgent types text into the agent's conversation: its running one, the last one resumed,
// or a new one. A message that lands mid-turn is queued by Claude Code for the turn's end.
func (s *Server) deliverAgent(ctx context.Context, a Agent, text string) (string, error) {
	live, err := s.M.Live(ctx)
	if err != nil {
		return "", err
	}
	cur := agentSession(live, a.Name)
	if cur != nil && cur.Attachable {
		return cur.ID, s.Term.Send(ctx, cur.ID, text)
	}
	sid := ""
	if cur != nil {
		sid = cur.SessionID
	} else if t, ok := s.lastAgentTranscript(a.Name); ok {
		sid = t.SessionID
	}
	if sid == "" {
		return s.startAgent(ctx, a, text, true)
	}
	id, err := s.resumeAgent(ctx, a, sid)
	if err != nil {
		return "", err
	}
	if err := s.untilAttachable(ctx, id); err != nil {
		return id, err
	}
	return id, s.Term.Send(ctx, id, text)
}

func (s *Server) startAgent(ctx context.Context, a Agent, prompt string, parked bool) (string, error) {
	args, err := a.args()
	if err != nil {
		return "", err
	}
	id, err := s.M.CLI.Start(ctx, a.dir(), a.Name, prompt, args...)
	if err == nil {
		s.tag(ctx, id, func(m *store.Meta) { m.Agent, m.Name, m.Parked = a.Name, a.label(), parked })
		log.Printf("agent %s: started %s", a.Name, id)
	}
	return id, err
}

func (s *Server) resumeAgent(ctx context.Context, a Agent, sid string) (string, error) {
	args, err := a.args()
	if err != nil {
		return "", err
	}
	home, _ := os.UserHomeDir()
	id, err := s.M.CLI.Resume(ctx, existingDir(a.dir(), home), sid, args...)
	if err != nil {
		return "", err
	}
	was := s.M.Store.Get(sid)
	s.superseded(sid, id)
	s.tag(ctx, id, func(m *store.Meta) { m.Agent, m.Name, m.Parked = a.Name, a.label(), was.Parked })
	log.Printf("agent %s: resumed %s as %s", a.Name, sid, id)
	return id, nil
}

func (s *Server) untilAttachable(ctx context.Context, id string) error {
	_, err := s.until(ctx, id, 30*time.Second, func(x sessions.Session) bool { return x.Attachable })
	return err
}

func (s *Server) until(ctx context.Context, id string, limit time.Duration, ok func(sessions.Session) bool) (sessions.Session, error) {
	end := time.Now().Add(limit)
	for {
		list, _ := s.M.Live(ctx)
		for _, x := range list {
			if x.ID == id && ok(x) {
				return x, nil
			}
		}
		if time.Now().After(end) {
			return sessions.Session{}, fmt.Errorf("%s: gave up after %s", id, limit)
		}
		select {
		case <-ctx.Done():
			return sessions.Session{}, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// unparkOnInput brings an agent back into the list when the user types to it: active work with
// them. Messages from other sessions and wake-ups leave it parked.
func (s *Server) unparkOnInput(ctx context.Context, id string) {
	agents, err := s.M.CLI.Agents(ctx)
	if err != nil {
		return
	}
	for _, a := range agents {
		if m := s.M.Store.Get(a.SessionID); a.ID == id && m.Agent != "" && m.Parked {
			s.M.Store.Update(a.SessionID, func(m *store.Meta) { m.Parked = false })
		}
	}
}

func (s *Server) watchAgents() {
	for range time.Tick(time.Minute) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		live, err := s.M.Live(ctx)
		cancel()
		if err != nil {
			continue
		}
		for _, a := range s.localAgents() {
			cur := agentSession(live, a.Name)
			if cur == nil || !cur.Parked || cur.State != sessions.YourTurn && cur.State != sessions.Stopped || strings.HasPrefix(cur.LastPrompt, seedMark) {
				continue
			}
			p, _ := a.policy()
			if why := p.Due(time.Since(cur.Last()), cur.Context); why != "" {
				go func() {
					if err := s.resetAgent(context.Background(), a, why); err != nil {
						log.Printf("agent %s: start over: %v", a.Name, err)
					}
				}()
			}
		}
	}
}

// seedMark starts the first message of a conversation that started over; one with nothing after
// it has nothing to hand over, so it is not started over again.
const seedMark = "[atc: a new conversation"

var errAgentBusy = errors.New("the agent is busy; try again when its turn ends")

const handoverPrompt = "[atc: this conversation is about to start over] Write a handover note for your next conversation: " +
	"work in progress and who has it, promises made, open questions, preferences the user stated here, the last topic. " +
	"Put anything durable into notes.md first. Reply with the note only, short and plain."

// resetAgent starts the agent's conversation over: the current one writes a handover note, a new
// one starts with it (parked as the old one was), and the old one leaves Claude's list under a
// dated name, its transcript kept.
func (s *Server) resetAgent(ctx context.Context, a Agent, why string) error {
	mu := s.agentLock(a.Name)
	if !mu.TryLock() {
		return errAgentBusy
	}
	defer mu.Unlock()
	live, err := s.M.Live(ctx)
	if err != nil {
		return err
	}
	cur := agentSession(live, a.Name)
	if cur == nil {
		return errors.New("it has no conversation yet")
	}
	if cur.State == sessions.Working || cur.State == sessions.NeedsYou {
		return errAgentBusy
	}
	log.Printf("agent %s: start over (%s)", a.Name, why)
	parked, before := cur.Parked, ""
	if t, ok := s.M.Index.Find(cur.SessionID); ok {
		before = t.ReplyID
	}
	id, err := s.deliverAgent(ctx, a, handoverPrompt)
	if err != nil {
		return err
	}
	var note string
	old, err := s.until(ctx, id, 10*time.Minute, func(x sessions.Session) bool {
		if x.State == sessions.Working {
			return false
		}
		t, ok := s.M.Index.Find(x.SessionID)
		if !ok || t.ReplyID == "" || t.ReplyID == before {
			return false
		}
		var rerr error
		note, rerr = history.Reply(t.Path, t.ReplyID)
		return rerr == nil
	})
	if err != nil {
		return fmt.Errorf("handover: %w", err)
	}
	note = strings.TrimSpace(note)
	if dir := filepath.Join(s.StateDir, "agents", a.Name); s.StateDir != "" && os.MkdirAll(dir, 0o755) == nil {
		os.WriteFile(filepath.Join(dir, time.Now().Format("20060102-150405")+"-"+old.SessionID[:min(8, len(old.SessionID))]+".md"), []byte(note+"\n"), 0o644)
	}
	seed := fmt.Sprintf(seedMark+"; the previous one (%s) left this handover note]\n\n%s\n\nRead notes.md, then answer in one line.", old.SessionID[:min(8, len(old.SessionID))], note)
	if _, err := s.startAgent(ctx, a, seed, parked); err != nil {
		return err
	}
	s.M.Store.Update(old.SessionID, func(m *store.Meta) { m.Name = a.label() + " " + old.StartedAt.Format("01-02 15:04") })
	return s.remove(ctx, id)
}

func (s *Server) lastReset(name string) time.Time {
	ents, _ := os.ReadDir(filepath.Join(s.StateDir, "agents", name))
	var last time.Time
	for _, e := range ents {
		if i, err := e.Info(); err == nil && i.ModTime().After(last) {
			last = i.ModTime()
		}
	}
	return last
}

type AgentView struct {
	Agent
	Rule      startover.Policy `json:"rule"`
	Next      time.Time        `json:"next,omitzero"`
	LastReset time.Time        `json:"lastReset,omitzero"`
	Session   string           `json:"sessionId,omitempty"`
	ID        string           `json:"id,omitempty"`
	State     string           `json:"state,omitempty"`
	Parked    bool             `json:"parked,omitempty"`
	Context   int              `json:"context,omitempty"`
	Last      time.Time        `json:"last,omitzero"`
	Pages     []pages.Page     `json:"pages"`
	Badge     json.RawMessage  `json:"badge,omitempty"`
	Headline  string           `json:"headline,omitempty"`
}

func (s *Server) agents(w http.ResponseWriter, r *http.Request) {
	list := []AgentView{}
	live, _ := s.M.Live(r.Context())
	for _, a := range s.agentList() {
		if a.Host != s.Host && a.Err == "" {
			continue
		}
		v := AgentView{Agent: a, Next: s.nextWake(a.Name), LastReset: s.lastReset(a.Name), Pages: append([]pages.Page{}, s.pageURLs(s.Pages.Of(agentRef+a.Name))...)}
		v.Rule, _ = a.policy()
		if x := agentSession(live, a.Name); x != nil {
			v.Session, v.ID, v.State, v.Parked, v.Context, v.Last = x.SessionID, x.ID, x.State, x.Parked, x.Context, x.Last()
		} else if t, ok := s.lastAgentTranscript(a.Name); ok {
			v.Session, v.State, v.Parked, v.Context, v.Last = t.SessionID, sessions.Past, s.M.Store.Get(t.SessionID).Parked, t.Context, t.Updated
		}
		for _, pg := range v.Pages {
			st := s.Pages.State(pg.Session, pg.Name)
			if v.Badge == nil {
				v.Badge = badge(st)
			}
			v.Headline = cmp.Or(v.Headline, headline(st))
		}
		list = append(list, v)
	}
	if a, ok := s.assistant(r.Context()); ok {
		list = append(list, a)
	}
	gather(s, w, r, "/api/agents", list, func(a *AgentView, h string) { a.Host = cmp.Or(a.Host, h) })
}

// assistant is the hub's conversation as an agent: it keeps its own process and channels, and
// shares the reset rule.
func (s *Server) assistant(ctx context.Context) (AgentView, bool) {
	if !s.hubUp() {
		return AgentView{}, false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	st, err := s.Hub.Status(ctx)
	if err != nil || st.Session == "" {
		return AgentView{}, false
	}
	v := AgentView{Agent: Agent{Name: hubName, Host: s.Host, Title: "Assistant", Icon: "chat", Color: "violet", Folder: st.Dir},
		Rule: st.Reset, LastReset: st.LastReset, Session: st.Session, ID: st.Session, State: sessions.YourTurn,
		Parked: s.M.Store.Get(st.Session).Parked, Context: st.Context, Last: time.Now().Add(-time.Duration(st.IdleS) * time.Second), Pages: []pages.Page{}}
	if len(st.Owners) > 0 || len(st.Pending) > 0 {
		v.State = sessions.Working
	}
	return v, true
}

// agentMessage wakes an agent with the request body: {"text": ...} or anything else as it came
// (a Grafana alert, a CI payload). With from=<source> it answers at once and delivers in the
// background, so a webhook never times out and retries. {"user": true} is the user writing from
// atc, which unparks it like typing into its conversation does.
func (s *Server) agentMessage(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("name") == hubName && s.hubUp() {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 256<<10))
		text := strings.TrimSpace(string(b))
		if text == "" {
			http.Error(w, "nothing to send", http.StatusBadRequest)
			return
		}
		if from := r.URL.Query().Get("from"); from != "" {
			text = "[message from " + from + "]\n" + text
		}
		s.done(w, s.hubSID(), s.hubSend(r.Context(), hub.Agent, text))
		return
	}
	a, ok := s.agentNamed(r.PathValue("name"))
	if !ok {
		http.Error(w, "no agent named "+r.PathValue("name")+" on "+s.Host, http.StatusNotFound)
		return
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	var body struct {
		Text string
		User bool
	}
	text := strings.TrimSpace(string(b))
	if json.Unmarshal(b, &body) == nil && body.Text != "" {
		text = body.Text
	}
	text = cmp.Or(text, a.Prompt)
	if text == "" {
		http.Error(w, "nothing to send, and the agent has no prompt", http.StatusBadRequest)
		return
	}
	from := r.URL.Query().Get("from")
	if from == "" {
		id, err := s.wakeAgent(r.Context(), a, text)
		if err == nil && body.User {
			s.unparkOnInput(r.Context(), id)
		}
		s.done(w, id, err)
		return
	}
	go func() {
		if _, err := s.wakeAgent(context.Background(), a, "[message from "+from+"]\n"+text); err != nil {
			log.Printf("agent %s: message from %s: %v", a.Name, from, err)
		}
		s.refresh()
	}()
	w.WriteHeader(http.StatusAccepted)
	reply(w, map[string]string{"ok": "delivering"})
}

func (s *Server) agentReset(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("name") == hubName && s.hubUp() {
		s.done(w, s.hubSID(), s.Hub.Reset(r.Context()))
		return
	}
	a, ok := s.agentNamed(r.PathValue("name"))
	if !ok {
		http.Error(w, "no agent named "+r.PathValue("name")+" on "+s.Host, http.StatusNotFound)
		return
	}
	go func() {
		if err := s.resetAgent(context.Background(), a, "asked"); err != nil {
			log.Printf("agent %s: start over: %v", a.Name, err)
		}
		s.refresh()
	}()
	w.WriteHeader(http.StatusAccepted)
	reply(w, map[string]string{"ok": "starting over"})
}

func headline(state json.RawMessage) string {
	var st struct{ Headline string }
	json.Unmarshal(state, &st)
	h := strings.TrimSpace(st.Headline)
	if r := []rune(h); len(r) > 160 {
		h = string(r[:159]) + "…"
	}
	return h
}

func badge(state json.RawMessage) json.RawMessage {
	var st struct{ Badge json.RawMessage }
	if json.Unmarshal(state, &st) != nil || st.Badge == nil {
		return nil
	}
	var v any
	json.Unmarshal(st.Badge, &v)
	switch x := v.(type) {
	case float64:
		return st.Badge
	case string:
		if x != "" && len([]rune(x)) <= 12 {
			return st.Badge
		}
	}
	return nil
}
