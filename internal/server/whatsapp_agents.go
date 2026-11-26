package server

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/zcag/atc/internal/whatsapp"
)

// An agent with "whatsapp": true has a WhatsApp group of its own, the user and atc's account and nobody else: what
// the user writes there goes to that agent on a line (its conversation in the hub, as on a call) and its replies come
// back there, and its `atc wa` lands there too. Every other session's `atc wa` goes to one more such group,
// Sessions, where a reply quoting a message goes back to the session that sent it. The owner's DM stays the
// assistant's. None of these groups ever reaches the guests' conversation, and nothing but the agent it belongs to
// can post into an agent's group.

const (
	waSessionsGroup = "Sessions"
	waGroupsEvery   = 10 * time.Minute
	waBusyRetry     = 20 * time.Second
	waBusyLongest   = 30 * time.Minute
)

// waBinding is which group is whose, kept in whatsapp-groups.json.
type waBinding struct {
	Agents   map[string]string `json:"agents"`
	Sessions string            `json:"sessions,omitempty"`
	// Looks is the tile each group's picture was drawn from, so it is drawn again when the agent's icon, colour or
	// title changes.
	Looks map[string]string `json:"looks,omitempty"`
}

// waGroupState is the groups atc talks in as someone's own, and who wrote what in Sessions.
type waGroupState struct {
	mu       sync.Mutex
	path     string
	b        waBinding
	creating map[string]bool
	routes   map[string]*waRoute
	sentBy   map[string]string
	order    []string
	last     string
	warned   map[string]bool
	waiting  map[string][]waQueued
}

type waQueued struct {
	msg         waMsg
	text, voice string
}

func (g *waGroupState) load(dir string) {
	g.creating, g.routes, g.sentBy, g.warned, g.waiting = map[string]bool{}, map[string]*waRoute{}, map[string]string{}, map[string]bool{}, map[string][]waQueued{}
	g.b.Agents = map[string]string{}
	if dir == "" {
		return
	}
	g.path = filepath.Join(dir, "whatsapp-groups.json")
	if b, err := os.ReadFile(g.path); err == nil {
		json.Unmarshal(b, &g.b)
	}
	if g.b.Agents == nil {
		g.b.Agents = map[string]string{}
	}
}

// save writes the binding; the caller holds g.mu.
func (g *waGroupState) save() {
	if g.path == "" {
		return
	}
	b, _ := json.MarshalIndent(g.b, "", "  ")
	tmp := g.path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, g.path)
	}
}

func (g *waGroupState) ids() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []string
	for _, id := range g.b.Agents {
		out = append(out, id)
	}
	if g.b.Sessions != "" {
		out = append(out, g.b.Sessions)
	}
	slices.Sort(out)
	return out
}

// whose is the agent a group belongs to, or sessions for the Sessions group; ok is false for any other chat.
func (g *waGroupState) whose(chat string) (agent string, sessions, ok bool) {
	if chat == "" {
		return "", false, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if chat == g.b.Sessions {
		return "", true, true
	}
	for name, id := range g.b.Agents {
		if id == chat {
			return name, false, true
		}
	}
	return "", false, false
}

func (g *waGroupState) agentGroup(name string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.b.Agents[name]
}

func (g *waGroupState) sessionsGroup() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.b.Sessions
}

// wrote remembers that a session sent message id in Sessions, so a reply quoting it finds the session.
func (g *waGroupState) wrote(id, sid string) {
	if id == "" || sid == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.sentBy[id]; !ok {
		g.order = append(g.order, id)
	}
	g.sentBy[id], g.last = sid, sid
	for len(g.order) > 2*waMemory {
		delete(g.sentBy, g.order[0])
		g.order = g.order[1:]
	}
}

func (g *waGroupState) writer(id string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if sid := g.sentBy[id]; sid != "" {
		return sid
	}
	return ""
}

func (g *waGroupState) lastWriter() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.last
}

// waOwnGroup is whether a group is one atc talks in as someone's own, or one it is making right now (its join
// can come before the new group's id is known), so the guests' conversation never hears of it.
func (s *Server) waOwnGroup(ctx context.Context, id string) bool {
	g := &s.wa.groups
	if _, _, ok := g.whose(id); ok {
		return true
	}
	g.mu.Lock()
	making := len(g.creating) > 0
	g.mu.Unlock()
	if !making {
		return false
	}
	x, err := s.WhatsApp.Group(ctx, id)
	g.mu.Lock()
	defer g.mu.Unlock()
	return err != nil || g.creating[x.Name]
}

// waPlainName is a group name a maker can type (adb types no emoji): the first of these an agent has goes to it.
var waPlainName = regexp.MustCompile(`^[A-Za-z0-9 ._-]+$`)

// waGroupName is what an agent's group is called: its icon when that is an emoji, its title, and the account's
// name, so it reads as the account's in the user's chat list.
func waGroupName(a Agent, self string) string {
	name := a.label()
	if r := []rune(a.Icon); len(r) > 0 && r[0] > unicode.MaxLatin1 {
		name = a.Icon + " " + name
	}
	if self != "" && !strings.HasPrefix(self, "+") {
		name += " - " + self
	}
	return name
}

type waLook struct {
	id, name string
	a        Agent
}

// waDress keeps each group of atc's own named as it should be and its picture the agent's tile, drawn by atc's
// browser from avatar.html.
func (s *Server) waDress(ctx context.Context, looks []waLook) error {
	wa, g := s.WhatsApp, &s.wa.groups
	list, err := wa.Groups(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, l := range looks {
		i := slices.IndexFunc(list, func(x whatsapp.Group) bool { return x.ID == l.id })
		if l.id == "" || i < 0 {
			continue
		}
		if list[i].Name != l.name {
			if err := wa.RenameGroup(ctx, l.id, l.name); err != nil {
				errs = append(errs, fmt.Errorf("rename %q: %w", list[i].Name, err))
			} else {
				log.Printf("whatsapp: renamed the group %q to %q", list[i].Name, l.name)
			}
		}
		look := l.a.Icon + "|" + l.a.Color + "|" + l.a.label()
		g.mu.Lock()
		done := g.b.Looks[l.id] == look
		g.mu.Unlock()
		if done || s.Browser == nil || s.LocalURL == "" {
			continue
		}
		q := url.Values{"name": {l.a.Name}, "icon": {l.a.Icon}, "color": {l.a.Color}}
		png, err := s.Browser.Shot(ctx, s.LocalURL+"/avatar.html?"+q.Encode(), 640, 640)
		if err == nil {
			err = wa.GroupPicture(ctx, l.id, png)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("picture of %q: %w", l.name, err))
			continue
		}
		log.Printf("whatsapp: drew the picture of %q", l.name)
		g.mu.Lock()
		if g.b.Looks == nil {
			g.b.Looks = map[string]string{}
		}
		g.b.Looks[l.id] = look
		g.save()
		g.mu.Unlock()
	}
	return errors.Join(errs...)
}

// waAgentGroups keeps every agent that asks for a group in one, now and then: a new agent gets its group within
// a few minutes, and a group atc's account was taken out of is made again.
func (s *Server) waAgentGroups() {
	time.Sleep(20 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		if err := s.ensureAgentGroups(ctx); err != nil {
			log.Printf("whatsapp: agents' groups: %v", err)
		}
		cancel()
		time.Sleep(waGroupsEvery)
	}
}

func (s *Server) ensureAgentGroups(ctx context.Context) error {
	wa, g := s.WhatsApp, &s.wa.groups
	var want []Agent
	for _, a := range s.localAgents() {
		if a.WhatsApp {
			want = append(want, a)
		}
	}
	if len(want) == 0 {
		return nil
	}
	list, err := wa.Groups(ctx)
	if err != nil {
		return err
	}
	in := func(id string) bool {
		return slices.ContainsFunc(list, func(x whatsapp.Group) bool { return x.ID == id })
	}
	changed := false
	take := func(list []whatsapp.Group, names []string) string {
		for _, x := range list {
			if !slices.ContainsFunc(names, func(n string) bool { return strings.EqualFold(strings.TrimSpace(x.Name), n) }) {
				continue
			}
			if full, err := wa.Group(ctx, x.ID); err == nil && wa.OnlyOwner(ctx, full) && !slices.Contains(g.ids(), x.ID) {
				if err := wa.LockGroup(ctx, x.ID); err != nil {
					log.Printf("whatsapp: could not lock the group %q: %v", x.Name, err)
				}
				return x.ID
			}
		}
		return ""
	}
	ensure := func(key string, names []string, have string) (string, error) {
		if have != "" && in(have) {
			return have, nil
		}
		if id := take(list, names); id != "" {
			changed = true
			log.Printf("whatsapp: %s takes the group %q that was already there (%s)", key, names[0], id)
			return id, nil
		}
		g.mu.Lock()
		for _, n := range names {
			g.creating[n] = true
		}
		g.mu.Unlock()
		made, err := wa.CreateGroup(ctx, names[0])
		if made.ID != "" {
			if err != nil {
				log.Printf("whatsapp: made %s's group %q, but could not lock it: %v", key, names[0], err)
			}
			log.Printf("whatsapp: made %s's group %q (%s)", key, names[0], made.ID)
			changed = true
			return made.ID, nil
		}
		if i := slices.IndexFunc(names, waPlainName.MatchString); i >= 0 && wa.Maker != "" {
			plain := names[i]
			mctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			out, merr := exec.CommandContext(mctx, wa.Maker, plain).CombinedOutput()
			cancel()
			log.Printf("whatsapp: %s %q: %s", wa.Maker, plain, strings.TrimSpace(string(out)))
			if merr == nil {
				if again, lerr := wa.Groups(ctx); lerr == nil {
					if id := take(again, names); id != "" {
						log.Printf("whatsapp: made %s's group %q with %s (%s)", key, plain, wa.Maker, id)
						changed = true
						return id, nil
					}
				}
			}
			err = errors.Join(err, fmt.Errorf("%s: %v", wa.Maker, merr))
		}
		return "", fmt.Errorf("could not make its group (%w); a group called %q with only the user and the account in it is taken instead", err, names[0])
	}
	var errs []error
	bind := func(key string, names []string, have string, set func(id string)) {
		id, err := ensure(key, names, have)
		g.mu.Lock()
		if err == nil {
			set(id)
			g.save()
		}
		for _, n := range names {
			delete(g.creating, n)
		}
		g.mu.Unlock()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", key, err))
		}
	}
	self := ""
	if _, err := wa.Self(ctx); err == nil {
		self = wa.SelfName()
	}
	var looks []waLook
	for _, a := range want {
		name := waGroupName(a, self)
		bind("@"+a.Name, []string{name, waGroupName(a, ""), a.label(), a.Name}, g.agentGroup(a.Name), func(id string) { g.b.Agents[a.Name] = id })
		looks = append(looks, waLook{g.agentGroup(a.Name), name, a})
	}
	sessions := Agent{Name: "sessions", Title: waSessionsGroup, Icon: "people"}
	bind("sessions", []string{waGroupName(sessions, self), waSessionsGroup}, g.sessionsGroup(), func(id string) { g.b.Sessions = id })
	looks = append(looks, waLook{g.sessionsGroup(), waGroupName(sessions, self), sessions})
	if err := s.waDress(ctx, looks); err != nil {
		errs = append(errs, err)
	}
	if changed {
		wa.Bind(g.ids())
		if err := wa.EnsureHook(ctx); err != nil && !errors.Is(err, whatsapp.ErrNoVotes) {
			errs = append(errs, err)
		}
		s.waBindRoutes()
	}
	return errors.Join(errs...)
}

// waBindRoutes gives every open line of an agent with a group its route; a line opened before the group was made
// (on a call) gets one too.
func (s *Server) waBindRoutes() {
	s.linesMu.Lock()
	lines := make([]*hubLink, 0, len(s.lines))
	for _, l := range s.lines {
		lines = append(lines, l)
	}
	s.linesMu.Unlock()
	for _, l := range lines {
		s.waLineRoute(l)
	}
}

// waLineRoute is the route of an agent's line in its group, made the first time it is asked for; nil when the
// agent has no group. It ends with the line.
func (s *Server) waLineRoute(l *hubLink) *waRoute {
	if s.WhatsApp == nil || s.wa == nil {
		return nil
	}
	g := &s.wa.groups
	chat := g.agentGroup(l.name)
	if chat == "" {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if r := g.routes[l.name]; r != nil && r.link == l {
		return r
	}
	r := &waRoute{link: l, chat: chat}
	g.routes[l.name] = r
	go func() {
		s.waHubLoop(r)
		g.mu.Lock()
		if g.routes[l.name] == r {
			delete(g.routes, l.name)
		}
		g.mu.Unlock()
	}()
	return r
}

// waBound is a message in one of the groups atc talks in as someone's own. Only the owner talks there: anyone
// else is ignored, and the owner told once.
func (s *Server) waBound(d whatsapp.Message, agent string, toSessions bool) {
	ctx, cancel := waContext()
	defer cancel()
	wa := s.WhatsApp
	chat := d.ChatID
	ctx = whatsapp.To(ctx, chat)
	if who := cmp.Or(d.Author, d.From); !wa.IsOwner(ctx, who, d.SenderPhone) {
		log.Printf("whatsapp: ignored a message from %s in a group of atc's own (%s)", who, chat)
		g := &s.wa.groups
		g.mu.Lock()
		told := g.warned[chat+" "+who]
		g.warned[chat+" "+who] = true
		g.mu.Unlock()
		if !told {
			s.waText(ctx, "⚠️ Only you can talk here: atc ignored a message from "+cmp.Or(strings.TrimPrefix(d.SenderPhone, "+"), who)+". Take them out of this group.")
		}
		return
	}
	if strings.TrimSpace(d.Body) == "" && d.Media == nil && d.Location == nil || !s.wa.first(d.ID) {
		return
	}
	msg := waMsg{chat, d.ID}
	s.wa.remember(s.wa.heard, d.ID, d.Body)
	wa.Read(ctx, chat)
	switch strings.ToLower(strings.TrimSpace(d.Body)) {
	case "/help":
		s.waText(ctx, waGroupHelp(agent, toSessions))
		return
	case "/stop":
		if agent != "" {
			if l := s.lineTo(agent); l != nil {
				_, err := l.c.Interrupt(ctx, waName)
				s.waFailed(ctx, msg, err)
				return
			}
		}
		s.waText(ctx, "Nothing to stop.")
		return
	}
	wa.React(ctx, chat, d.ID, "⏳")
	text, voice, err := s.waPrompt(ctx, d)
	if err == nil {
		if toSessions {
			ref := ""
			if d.Quoted != nil {
				ref = d.Quoted.ID
			}
			err = s.waToSession(ctx, msg, ref, text)
		} else {
			err = s.waToAgent(ctx, agent, msg, text, voice)
		}
	}
	s.waFailed(ctx, msg, err)
}

func waGroupHelp(agent string, toSessions bool) string {
	if toSessions {
		return "*Sessions*\nSessions that are not one of your agents write to you here. Reply to one of their messages (quote it) to answer that session; a message that quotes nothing goes to the one that wrote last."
	}
	return "*@" + agent + "*\nWhat you write here goes to @" + agent + " and its replies come back here: text, photos, files, voice notes, a reply quoting one of its messages, a reaction to one of its questions or a tap on its poll.\n\n- /stop: interrupt it\n- /help: this"
}

// waToAgent hands the owner's message to the agent on its line, opening the line when it isn't. An agent in the
// middle of something in the background is waited for: the message goes in once it is done.
func (s *Server) waToAgent(ctx context.Context, agent string, msg waMsg, text, voice string) error {
	g := &s.wa.groups
	g.mu.Lock()
	if q, ok := g.waiting[agent]; ok {
		g.waiting[agent] = append(q, waQueued{msg, text, voice})
		g.mu.Unlock()
		return nil
	}
	g.mu.Unlock()
	r, why, err := s.waAgentRoute(ctx, agent)
	if errors.Is(err, errAgentBusy) {
		g.mu.Lock()
		g.waiting[agent] = []waQueued{{msg, text, voice}}
		g.mu.Unlock()
		s.waText(ctx, "⏳ @"+agent+" is in the middle of something"+cmp.Or(why, "")+". Your message goes in once it is done.")
		go s.waAfterBusy(agent, msg.chat)
		return nil
	}
	if err != nil {
		return err
	}
	return s.waHubType(ctx, r, msg, text, voice)
}

// waAfterBusy hands what was written while the agent was busy to it once it can take it.
func (s *Server) waAfterBusy(agent, chat string) {
	g := &s.wa.groups
	end := time.Now().Add(waBusyLongest)
	for {
		time.Sleep(waBusyRetry)
		ctx, cancel := waContext()
		ctx = whatsapp.To(ctx, chat)
		r, _, err := s.waAgentRoute(ctx, agent)
		if errors.Is(err, errAgentBusy) && time.Now().Before(end) {
			cancel()
			continue
		}
		g.mu.Lock()
		q := g.waiting[agent]
		delete(g.waiting, agent)
		g.mu.Unlock()
		if err != nil {
			log.Printf("whatsapp: @%s: %v", agent, err)
			for _, m := range q {
				s.WhatsApp.React(ctx, m.msg.chat, m.msg.id, "❗")
			}
			s.waText(ctx, "⚠️ @"+agent+" could not take your message ("+err.Error()+"). Send it again.")
			cancel()
			return
		}
		for _, m := range q {
			s.waFailed(ctx, m.msg, s.waHubType(ctx, r, m.msg, m.text, m.voice))
		}
		cancel()
		return
	}
}

// waAgentRoute is the agent's route on its line, opened for WhatsApp when there is none. errAgentBusy says the
// agent is working in the background, with what it is doing.
func (s *Server) waAgentRoute(ctx context.Context, agent string) (*waRoute, string, error) {
	if s.Hub == nil || !s.hubUp() {
		return nil, "", errors.New("the hub is not running, and agents talk on WhatsApp through it")
	}
	if l := s.lineTo(agent); l != nil && l.live() {
		if r := s.waLineRoute(l); r != nil {
			return r, "", nil
		}
	}
	code, body, err := s.Hub.OpenLine(ctx, agent, waName)
	if err != nil {
		return nil, "", err
	}
	var ans struct{ Why, Activity, Error string }
	json.Unmarshal(body, &ans)
	switch {
	case code == http.StatusConflict:
		why := ""
		if ans.Activity != "" {
			why = " (" + clipRunes(oneLine(ans.Activity), 80) + ")"
		}
		return nil, why, errAgentBusy
	case code != http.StatusOK:
		return nil, "", errors.New(cmp.Or(ans.Error, strings.TrimSpace(string(body))))
	}
	open, err := s.Hub.Lines(ctx)
	if err != nil {
		return nil, "", err
	}
	s.syncLines(open)
	l := s.lineTo(agent)
	if l == nil {
		return nil, "", errors.New("the hub opened @" + agent + "'s line, but it is gone again")
	}
	for i := 0; i < 50 && !l.live(); i++ {
		time.Sleep(200 * time.Millisecond)
	}
	r := s.waLineRoute(l)
	if r == nil {
		return nil, "", errors.New("@" + agent + " has no group")
	}
	return r, "", nil
}

// waToSession passes the owner's message in Sessions to the session that sent the message it quotes, else to the
// one that wrote there last. Its answer comes back with atc wa; nothing relays its turn.
func (s *Server) waToSession(ctx context.Context, msg waMsg, quoted, text string) error {
	g := &s.wa.groups
	sid := g.writer(quoted)
	if sid == "" && quoted == "" {
		sid = g.lastWriter()
	}
	if sid == "" {
		_, err := s.waText(ctx, "atc doesn't know which session that is for. Reply to one of its messages here (quote it).")
		return err
	}
	x, _ := s.M.Session(sid)
	head := "[WhatsApp · the Sessions group · the user, verified by atc]\n"
	tail := "\n[end of message. Answer with `atc wa`: it reaches them in that group]"
	id := x.ID
	if id == "" || !x.Attachable {
		var err error
		if id, err = s.resumeSession(ctx, sid); err != nil {
			return fmt.Errorf("could not reach %s: %w", cmp.Or(x.Title, sid), err)
		}
		if err := s.untilAttachable(ctx, id); err != nil {
			return err
		}
	}
	s.unparkOnInput(ctx, id)
	if err := s.Term.Send(ctx, id, head+text+tail); err != nil {
		return err
	}
	if msg.id != "" {
		s.WhatsApp.React(ctx, msg.chat, msg.id, "📨")
	}
	return nil
}

// waBoundChange is a reaction, a poll vote or an edit in a group of atc's own, passed to whoever it belongs to:
// the agent, or in Sessions the session that sent the message it is about.
func (s *Server) waBoundChange(ctx context.Context, chat, about string, msg waMsg, text string) {
	agent, toSessions, ok := s.wa.groups.whose(chat)
	if !ok {
		return
	}
	ctx = whatsapp.To(ctx, chat)
	if msg.id != "" {
		s.WhatsApp.React(ctx, chat, msg.id, "⏳")
	}
	var err error
	if toSessions {
		if s.wa.groups.writer(about) == "" {
			return
		}
		err = s.waToSession(ctx, msg, about, text)
	} else {
		err = s.waToAgent(ctx, agent, msg, text, "")
	}
	s.waFailed(ctx, msg, err)
}

type waFromKey struct{}

// waTarget is where a bare `atc wa` from the calling session goes: the owner's DM for the assistant, a shell or a
// machine without groups; an agent's own group; Sessions for any other session, under its title. A guests'
// session has no bare target.
type waTarget struct {
	chat, label, sid string
	agent            string
}

func (s *Server) waTargetOf(caller string) (waTarget, error) {
	if caller == "" || s.wa == nil {
		return waTarget{}, nil
	}
	if caller == s.hubSID() || s.M.Store.Get(caller).Name == waName {
		return waTarget{}, nil
	}
	x, known := s.M.Session(caller)
	if caller == s.guests.session() || known && guestWork(x) {
		return waTarget{}, errors.New("a session working for guests reaches people only with --to or --group")
	}
	g := &s.wa.groups
	agent := s.M.Store.Get(caller).Agent
	if l := s.linkOf(caller); l != nil && l != s.hub && l != s.guests {
		agent = l.name
	}
	if agent != "" {
		if id := g.agentGroup(agent); id != "" {
			return waTarget{chat: id, agent: agent}, nil
		}
	}
	id := g.sessionsGroup()
	if id == "" {
		return waTarget{}, nil
	}
	label := cmp.Or(x.Title, s.M.Store.Get(caller).Name, "a session")
	if agent != "" {
		label = "@" + agent
	}
	return waTarget{chat: id, label: label, sid: caller}, nil
}
