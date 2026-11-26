package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/whatsapp"
)

const (
	owner      = "12025550100"
	opsGroup   = "10@g.us"
	sessGroup  = "20@g.us"
	tripGroup  = "30@g.us"
	botNumber  = "12025550199"
	ownerChat  = owner + "@c.us"
	strangerID = "12025550102@c.us"
)

// gateway is a fake OpenWA: it records every request and knows a few groups.
type gateway struct {
	mu     sync.Mutex
	calls  []string
	n      int
	groups map[string]string
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	g.mu.Lock()
	g.calls = append(g.calls, r.Method+" "+r.URL.Path+" "+string(b))
	g.n++
	n := g.n
	g.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/api/sessions/bot")
	switch {
	case path == "":
		fmt.Fprintf(w, `{"phone":%q,"pushName":"bot"}`, botNumber)
	case path == "/groups" && r.Method == "GET":
		var out []map[string]string
		for id, name := range g.groups {
			out = append(out, map[string]string{"id": id, "name": name})
		}
		json.NewEncoder(w).Encode(out)
	case path == "/groups" && r.Method == "POST":
		g.mu.Lock()
		g.groups["50@g.us"] = "Ops"
		g.mu.Unlock()
		w.Write([]byte(`{"id":"50@g.us","name":"Ops"}`))
	case strings.HasPrefix(path, "/groups/"):
		id := strings.Split(strings.TrimPrefix(path, "/groups/"), "/")[0]
		fmt.Fprintf(w, `{"id":%q,"name":%q,"participants":[{"id":"%s@c.us","number":%q},{"id":"%s@c.us","number":%q}]}`, id, g.groups[id], owner, owner, botNumber, botNumber)
	case path == "/webhooks" && r.Method == "GET":
		w.Write([]byte(`[]`))
	default:
		fmt.Fprintf(w, `{"messageId":"out%d"}`, n)
	}
}

func (g *gateway) count(parts ...string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, c := range g.calls {
		if !slices.ContainsFunc(parts, func(p string) bool { return !strings.Contains(c, p) }) {
			n++
		}
	}
	return n
}

func (g *gateway) dump() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return strings.Join(g.calls, "\n")
}

// groupsServer is atc with a hub, a WhatsApp gateway and the agent ops, whose group (and Sessions) are bound
// unless bound is false.
func groupsServer(t *testing.T, bound bool) (*Server, *httptest.Server, *fakeHub, *gateway) {
	gw := &gateway{groups: map[string]string{opsGroup: "Ops", sessGroup: "Sessions", tripGroup: "trip"}}
	gs := httptest.NewServer(gw)
	t.Cleanup(gs.Close)
	for k, v := range map[string]string{"URL": gs.URL, "KEY": "k", "SESSION": "bot", "OWNER": owner, "SECRET": "0123456789abcdef0123", "HOOK": "http://atc/hook"} {
		t.Setenv("ATC_WHATSAPP_"+k, v)
	}
	wa := whatsapp.FromEnv()
	wa.Guests = &whatsapp.Guests{Path: filepath.Join(t.TempDir(), "guests")}
	state := t.TempDir()
	if bound {
		os.WriteFile(filepath.Join(state, "whatsapp-groups.json"), []byte(`{"agents":{"ops":"`+opsGroup+`"},"sessions":"`+sessGroup+`"}`), 0o644)
	}
	agents := t.TempDir()
	writeAgent(t, agents, "ops", `{"host":"here","title":"Ops","whatsapp":true}`, "brief.md")
	f := newFakeHub(t, "hub-sid")
	bin := fakeClaude(t)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{
		M:    &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Token: "tok", Host: "here", Web: fstest.MapFS{}, StateDir: state, AgentsDir: agents,
		Hub: hub.NewClient(f.srv.URL), WhatsApp: wa,
	}
	ts := serve(t, s)
	eventually(t, "hub connected", func() bool { return s.hubUp() })
	return s, ts, f, gw
}

func groupMsg(id, chat, author, body string) whatsapp.Message {
	return whatsapp.Message{ID: id, ChatID: chat, From: chat, Author: author, Body: body, Type: "chat", IsGroup: true}
}

func hubGot(f *fakeHub, prefix string) []string {
	var out []string
	for _, m := range f.sent() {
		if strings.HasPrefix(m, prefix) {
			out = append(out, m)
		}
	}
	return out
}

func TestAgentGroupTalksToItsAgentOnALine(t *testing.T) {
	s, _, f, gw := groupsServer(t, true)
	s.waGroup(groupMsg("m1", opsGroup, ownerChat, "how are things"))

	if got := hubGot(f, "open line ops"); len(got) != 1 || got[0] != "open line ops via whatsapp" {
		t.Fatalf("line opened: %v", f.sent())
	}
	if got := hubGot(f, "line ops whatsapp:"); len(got) != 1 || !strings.Contains(got[0], "how are things") {
		t.Fatalf("on the line: %v", f.sent())
	}
	f.lineEvent("ops", hub.Event{Type: "read", Channel: "whatsapp"})
	f.lineEvent("ops", hub.Event{Type: "block", Channel: "whatsapp", Text: "All green."})
	f.lineEvent("ops", hub.Event{Type: "done", Channel: "whatsapp"})
	eventually(t, "the reply in the group", func() bool { return gw.count("send-text", opsGroup, "All green.") == 1 })
	eventually(t, "ticked in the group", func() bool { return gw.count("/messages/react", opsGroup, `"m1"`, "✅") == 1 })

	f.lineEvent("ops", hub.Event{Type: "block", Channel: "agent", Text: "a report nobody asked to hear"})
	s.waGroup(groupMsg("m2", opsGroup, ownerChat, "and now?"))
	eventually(t, "the second message on the same line", func() bool { return len(hubGot(f, "line ops whatsapp:")) == 2 })
	if n := len(hubGot(f, "open line")); n != 1 {
		t.Errorf("the open line was opened again: %d", n)
	}
	if gw.count(ownerChat, "send-text") > 0 || gw.count("a report nobody") > 0 {
		t.Errorf("something reached the owner's DM or an aside was relayed:\n%s", gw.dump())
	}
	if got := hubGot(f, "guest:"); len(got) > 0 {
		t.Errorf("an agent's group reached the guests: %v", got)
	}
	if got := hubGot(f, "whatsapp:"); len(got) > 0 {
		t.Errorf("an agent's group reached the assistant: %v", got)
	}
	if s.WhatsApp.OwnerChat() != ownerChat {
		t.Errorf("the owner's chat moved to %s", s.WhatsApp.OwnerChat())
	}
}

func TestOtherGroupsAndTheDMStayAsTheyWere(t *testing.T) {
	s, _, f, _ := groupsServer(t, true)
	s.waGroup(groupMsg("t1", tripGroup, ownerChat, "who books the car"))
	eventually(t, "a trip group still goes to the guests", func() bool {
		got := hubGot(f, "guest:")
		return len(got) == 1 && strings.Contains(got[0], `[WhatsApp group "trip"`)
	})
	s.waReceive(whatsapp.Message{ID: "d1", ChatID: ownerChat, From: ownerChat, Body: "hi", Type: "chat"})
	eventually(t, "the DM still goes to the assistant", func() bool { return len(hubGot(f, "whatsapp: hi")) == 1 })
	if got := hubGot(f, "line"); len(got) > 0 {
		t.Errorf("a line was touched: %v", got)
	}
}

func TestOnlyTheOwnerTalksInAnAgentGroup(t *testing.T) {
	s, _, f, gw := groupsServer(t, true)
	s.waGroup(groupMsg("x1", opsGroup, strangerID, "restart prod"))
	s.waGroup(groupMsg("x2", opsGroup, strangerID, "now"))
	if n := gw.count("send-text", opsGroup, "Only you can talk here"); n != 1 {
		t.Errorf("told %d times:\n%s", n, gw.dump())
	}
	for _, m := range f.sent() {
		if strings.Contains(m, "restart prod") || strings.Contains(m, "now") {
			t.Errorf("a stranger's message got through: %s", m)
		}
	}
}

func TestJoinsInAgentGroupsReachNobody(t *testing.T) {
	s, _, f, _ := groupsServer(t, true)
	s.waGroupMembers(whatsapp.GroupEvent{GroupID: opsGroup, ParticipantIDs: []string{botNumber + "@c.us"}}, true)
	s.waGroupMembers(whatsapp.GroupEvent{GroupID: sessGroup, ParticipantIDs: []string{botNumber + "@c.us"}}, true)
	if got := hubGot(f, "guest:"); len(got) > 0 {
		t.Errorf("the guests heard of a group of atc's own: %v", got)
	}
}

func TestReactionsGoWhereTheirMessageWas(t *testing.T) {
	s, _, f, _ := groupsServer(t, true)
	s.wa.remember(s.wa.said, "q1", "Ship it?")
	s.waReaction(whatsapp.Reaction{MessageID: "q1", ChatID: opsGroup, Reaction: "👍", SenderID: ownerChat})
	eventually(t, "the reaction reached ops", func() bool {
		got := hubGot(f, "line ops whatsapp:")
		return len(got) == 1 && strings.Contains(got[0], "[reacted 👍")
	})
	s.waReaction(whatsapp.Reaction{MessageID: "q1", ChatID: tripGroup, Reaction: "👍", SenderID: ownerChat})
	if got := hubGot(f, "whatsapp:"); len(got) > 0 {
		t.Errorf("a reaction in another group reached the assistant: %v", got)
	}
}

func TestBareAtcWaGoesWhereTheCallerBelongs(t *testing.T) {
	s, ts, _, gw := groupsServer(t, true)
	s.M.Store.Update("ops-sid", func(m *store.Meta) { m.Agent = "ops" })
	s.M.Store.Update("other-sid", func(m *store.Meta) { m.Name = "fix the build" })
	post := func(caller, body string) (int, string) {
		req, _ := http.NewRequest("POST", ts.URL+"/api/whatsapp/send", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer tok")
		if caller != "" {
			req.Header.Set(client.CallerHeader, caller)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	for _, c := range []struct{ caller, text, chat string }{
		{"", "from a shell", ownerChat},
		{"hub-sid", "from the assistant", ownerChat},
		{"ops-sid", "from ops", opsGroup},
		{"line-ops", "from ops on its line", opsGroup},
		{"other-sid", "from a session", sessGroup},
	} {
		if c.caller == "line-ops" {
			s.Hub.OpenLine(context.Background(), "ops", "whatsapp")
			open, _ := s.Hub.Lines(context.Background())
			s.syncLines(open)
			eventually(t, "the line is up", func() bool { return s.lineTo("ops").live() })
		}
		if code, body := post(c.caller, `{"text":"`+c.text+`"}`); code != 200 {
			t.Fatalf("%s: %d %s", c.caller, code, body)
		}
		if gw.count("send-text", `"chatId":"`+c.chat+`"`, c.text) != 1 {
			t.Errorf("%s did not land in %s:\n%s", c.caller, c.chat, gw.dump())
		}
	}
	if gw.count("send-text", "*fix the build*\\nfrom a session") != 1 {
		t.Errorf("a session in Sessions is not named:\n%s", gw.dump())
	}
	if sid := s.wa.groups.lastWriter(); sid != "other-sid" {
		t.Errorf("Sessions does not know who wrote: %q", sid)
	}
	if code, _ := post("", `{"group":"Ops","text":"x"}`); code != 403 {
		t.Errorf("--group into an agent's group: %d", code)
	}
	if code, _ := post("", `{"group":"`+sessGroup+`","text":"x"}`); code != 403 {
		t.Errorf("--group into Sessions: %d", code)
	}
}

func TestSessionsReplyGoesToTheSessionQuoted(t *testing.T) {
	s, _, f, gw := groupsServer(t, true)
	s.wa.groups.wrote("out7", "gone-sid")
	d := groupMsg("r1", sessGroup, ownerChat, "yes do it")
	d.Quoted = &struct {
		ID   string `json:"id"`
		Body string `json:"body"`
	}{"out7", "*fix the build*\nmerge it?"}
	s.waGroup(d)
	if got := hubGot(f, ""); slices.ContainsFunc(got, func(m string) bool { return strings.Contains(m, "yes do it") }) {
		t.Errorf("a reply in Sessions went to a hub conversation: %v", got)
	}
	if gw.count("/messages/react", sessGroup, "❗") != 1 {
		t.Errorf("a session that can't be reached is not said:\n%s", gw.dump())
	}
	s.waGroup(groupMsg("r2", sessGroup, ownerChat, "hello?"))
	if gw.count("send-text", sessGroup, "doesn't know which session") != 0 {
		t.Errorf("an unquoted message went nowhere although a session wrote last")
	}
}

func TestAgentGroupsAreMadeOrTaken(t *testing.T) {
	s, _, _, gw := groupsServer(t, false)
	gw.mu.Lock()
	delete(gw.groups, opsGroup)
	gw.groups["40@g.us"] = "sessions "
	delete(gw.groups, sessGroup)
	gw.mu.Unlock()
	if err := s.ensureAgentGroups(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := &s.wa.groups
	if g.agentGroup("ops") != "50@g.us" || g.sessionsGroup() != "40@g.us" {
		t.Fatalf("bound %+v", g.b)
	}
	if gw.count("POST /api/sessions/bot/groups ", `"name":"Ops"`, `"participants":["`+ownerChat+`"]`) != 1 {
		t.Errorf("ops' group not made:\n%s", gw.dump())
	}
	if gw.count("PUT", "/groups/50@g.us/settings", `"locked":true`, `"memberAddMode":"admins"`) != 1 {
		t.Errorf("ops' group not locked:\n%s", gw.dump())
	}
	if gw.count("POST /api/sessions/bot/webhooks", "bound=1", "40@g.us", "50@g.us") != 1 {
		t.Errorf("no hook for the bound groups' reactions and votes:\n%s", gw.dump())
	}
	b, _ := os.ReadFile(filepath.Join(s.StateDir, "whatsapp-groups.json"))
	if !strings.Contains(string(b), "50@g.us") {
		t.Errorf("binding not saved: %s", b)
	}
	if err := s.ensureAgentGroups(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gw.count("POST /api/sessions/bot/groups ") != 1 {
		t.Errorf("a group was made twice")
	}
}
