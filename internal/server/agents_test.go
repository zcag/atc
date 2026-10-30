package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func writeAgent(t *testing.T, root, name, manifest string, files ...string) string {
	dir := filepath.Join(root, name)
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "agent.json"), []byte(manifest), 0o644)
	for _, f := range files {
		os.WriteFile(filepath.Join(dir, f), []byte(f), 0o644)
	}
	return dir
}

func TestLoadAgents(t *testing.T) {
	root := t.TempDir()
	mail := writeAgent(t, root, "mail", `{"host":"here","title":"Mail","every":"5m","check":"./check.sh","reset":{"quiet":"1h","over":20000}}`, "brief.md", "settings.json")
	writeAgent(t, root, "nohost", `{"title":"x"}`)
	writeAgent(t, root, "badevery", `{"host":"here","every":"soon","prompt":"x"}`)
	writeAgent(t, root, "silent", `{"host":"here","every":"5m"}`)
	os.MkdirAll(filepath.Join(root, "not-an-agent"), 0o755)
	list := loadAgents(root)
	errs := map[string]string{}
	for _, a := range list {
		errs[a.Name] = a.Err
	}
	if len(list) != 4 || errs["mail"] != "" || errs["nohost"] == "" || errs["badevery"] == "" || errs["silent"] == "" {
		t.Fatalf("load: %+v", list)
	}
	a := list[slicesIndex(list, "mail")]
	if p, _ := a.policy(); p.Quiet != time.Hour || p.Small != 20000 || p.Cap != 150_000 {
		t.Errorf("policy: %+v", p)
	}
	args, _ := a.args()
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "You are the Mail agent (@mail") || !strings.HasSuffix(args[1], "brief.md") ||
		!strings.Contains(joined, "--settings "+filepath.Join(mail, "settings.json")) || strings.Contains(joined, "--mcp-config") {
		t.Errorf("args: %q", args)
	}
}

func slicesIndex(list []Agent, name string) int {
	for i, a := range list {
		if a.Name == name {
			return i
		}
	}
	return -1
}

func agentServer(t *testing.T) (*Server, *httptest.Server, string, *store.Store) {
	bin := fakeClaude(t)
	root := t.TempDir()
	writeAgent(t, root, "mail", `{"host":"here","title":"Mail","icon":"mail","prompt":"Check mail.","every":"5m","check":"echo new"}`, "brief.md")
	writeAgent(t, root, "far", `{"host":"there","prompt":"x"}`)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Web: fstest.MapFS{}, Token: "tok", Host: "here", AgentsDir: root, StateDir: t.TempDir()}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts, bin, st
}

func TestAgentConversation(t *testing.T) {
	s, ts, bin, st := agentServer(t)
	dir := filepath.Dir(bin)
	agents := func(js string) { os.WriteFile(filepath.Join(dir, "agents.json"), []byte(js), 0o644) }
	agents(`[{"id":"abcd1234","sessionId":"m1","kind":"background","pid":1,"state":"done","startedAt":1000}]`)

	if res, _ := do(t, "POST", ts.URL+"/api/agents/mail/message", "tok", `{"text":"hello"}`); res.StatusCode != 200 {
		t.Fatalf("message: %d", res.StatusCode)
	}
	args, _ := os.ReadFile(filepath.Join(dir, "started"))
	if !strings.Contains(string(args), "--name mail hello") {
		t.Errorf("first message starts its conversation: %s", args)
	}
	if m := st.Get("m1"); m.Agent != "mail" || m.Name != "Mail" || !m.Parked {
		t.Fatalf("new conversation tagged: %+v", m)
	}

	os.Remove(filepath.Join(dir, "started"))
	do(t, "POST", ts.URL+"/api/agents/mail/message", "tok", "a grafana alert body")
	if fileExists(filepath.Join(dir, "started")) {
		t.Error("a running conversation should get the message, not a new session")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "sent")); !strings.Contains(string(b), "a grafana alert body") {
		t.Errorf("sent: %q", b)
	}
	if !st.Get("m1").Parked {
		t.Error("a wake-up must leave the agent parked")
	}

	page := filepath.Join(dir, "inbox.html")
	os.WriteFile(page, []byte("<title>Inbox</title>"), 0o644)
	_, body := do(t, "POST", ts.URL+"/api/sessions/m1/pages", "tok", `{"path":"`+page+`"}`)
	var shown struct{ Page pages.Page }
	if json.Unmarshal([]byte(body), &shown); shown.Page.Session != "@mail" {
		t.Fatalf("page filed under %q, want @mail: %s", shown.Page.Session, body)
	}
	do(t, "PUT", ts.URL+"/api/sessions/@mail/pages/inbox/state", "tok", `{"badge":3,"headline":"Two need you"}`)

	var list []AgentView
	_, body = get(t, ts.URL+"/api/agents", "tok")
	json.Unmarshal([]byte(body), &list)
	if len(list) != 1 || list[0].Name != "mail" || list[0].Session != "m1" || !list[0].Parked || string(list[0].Badge) != "3" ||
		list[0].Headline != "Two need you" || list[0].Rule.Small != 80_000 || len(list[0].Pages) != 1 {
		t.Fatalf("agents: %s", body)
	}

	do(t, "POST", ts.URL+"/api/sessions/abcd1234/send", "tok", `{"text":"mark 3","from":"other-session"}`)
	if !st.Get("m1").Parked {
		t.Error("a message from another session must leave it parked")
	}
	do(t, "POST", ts.URL+"/api/sessions/abcd1234/send", "tok", `{"text":"mark 3"}`)
	if st.Get("m1").Parked {
		t.Error("the user typing to it is active work: it comes back into the list")
	}

	if res, _ := do(t, "POST", ts.URL+"/api/agents/far/message", "tok", `x`); res.StatusCode != 404 {
		t.Errorf("an agent of another machine with no peer: %d", res.StatusCode)
	}
	_ = s
}

func TestAgentTick(t *testing.T) {
	s, _, bin, st := agentServer(t)
	dir := filepath.Dir(bin)
	agents := func(state string) {
		os.WriteFile(filepath.Join(dir, "agents.json"), []byte(`[{"id":"abcd1234","sessionId":"m1","kind":"background","pid":1,"state":"`+state+`"}]`), 0o644)
	}
	agents("done")
	a, _ := s.agentNamed("mail")
	s.tick(a)
	if args, _ := os.ReadFile(filepath.Join(dir, "started")); !strings.Contains(string(args), "[wake-up from your schedule, every 5m]\nCheck mail.\n\nnew") {
		t.Fatalf("args: %s", args)
	}
	if st.Get("m1").Agent != "mail" {
		t.Fatal("not tagged")
	}
	agents("working")
	os.Remove(filepath.Join(dir, "sent"))
	if s.tick(a); fileExists(filepath.Join(dir, "sent")) {
		t.Error("woke a conversation that is mid-turn")
	}
	a.Check = "true"
	agents("done")
	if s.tick(a); fileExists(filepath.Join(dir, "sent")) {
		t.Error("an empty check woke it")
	}
}

func TestFirstMessage(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "new.txt"), nil, 0o644)
	ctx := context.Background()
	for _, c := range []struct {
		check, prompt, want string
		run                 bool
	}{
		{"", "Tidy up.", "Tidy up.", true},
		{"ls", "", "new.txt", true},
		{"ls", "File these.", "File these.\n\nnew.txt", true},
		{"true", "File these.", "", false},
		{"echo hi; exit 1", "File these.", "", false},
	} {
		msg, why := Agent{Name: "p", Folder: dir, Check: c.check, Prompt: c.prompt}.firstMessage(ctx)
		if msg != c.want || (why == "") != c.run {
			t.Errorf("%q: got %q, %q", c.check, msg, why)
		}
	}
}

func TestBadge(t *testing.T) {
	for in, want := range map[string]string{`{"badge":4}`: "4", `{"badge":"new"}`: `"new"`, `{"badge":"a much too long badge"}`: "", `{"badge":{"n":1}}`: "", `[1]`: "", `{"x":1}`: ""} {
		if got := string(badge(json.RawMessage(in))); got != want {
			t.Errorf("%s: got %q, want %q", in, got, want)
		}
	}
}

func TestParkedComesBackWhenItNeedsYou(t *testing.T) {
	list := []sessions.Session{
		{SessionID: "a", Parked: true, State: sessions.YourTurn},
		{SessionID: "b", Parked: true, State: sessions.NeedsYou},
		{SessionID: "c", State: sessions.YourTurn},
	}
	var ids []string
	for _, w := range widgetList(list) {
		ids = append(ids, w.SID)
	}
	if strings.Join(ids, ",") != "b,c" {
		t.Errorf("widget shows %v, want a parked session only while it needs you", ids)
	}
	prev := map[string]string{"a": sessions.Working, "b": sessions.Working, "c": sessions.Working}
	ms, _ := alerts(prev, list, func(sessions.Session) bool { return false })
	var tags []string
	for _, m := range ms {
		tags = append(tags, m.Tag)
	}
	if strings.Join(tags, ",") != "b,c" {
		t.Errorf("pushed %v: a parked turn must not push, its needs-you must", tags)
	}
}
