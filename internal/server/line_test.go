package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/settings"
	"github.com/zcag/atc/internal/store"
)

func TestAgentLineFollowsTheLevel(t *testing.T) {
	s, ts, _, _ := agentServer(t)
	writeAgent(t, s.AgentsDir, "talker", `{"host":"here","talk":true,"check":"./due.sh"}`, "settings.json")
	folder := filepath.Join(s.AgentsDir, "talker")
	args := func() string {
		res, b := do(t, "POST", ts.URL+"/api/agents/talker/line", "tok", "")
		if res.StatusCode != 200 {
			t.Fatalf("line: %d %s", res.StatusCode, b)
		}
		var spec struct{ Args []string }
		json.Unmarshal([]byte(b), &spec)
		return strings.Join(spec.Args, " ")
	}
	for _, c := range []struct {
		level string
		has   []string
		not   []string
	}{
		{"", []string{"--mcp-config", "mcp__atc", "--allowedTools", "Read,", "Edit(/" + folder + "/**)", "--settings " + folder + "/settings.json",
			"Edit(/" + folder + "/settings.json)", "Edit(/" + folder + "/agent.json)", "Edit(/" + folder + "/due.sh)"}, []string{skipPermissions}},
		{"limited", []string{"--mcp-config", "mcp__atc", "Bash(atc show *)", "--settings " + folder + "/settings.json"}, []string{skipPermissions, "Read,", "Edit(/" + folder + "/**)"}},
		{"full", []string{"--mcp-config", skipPermissions, "--settings " + folder + "/settings.json"}, []string{"--allowedTools", "Edit("}},
	} {
		t.Setenv(settings.AutonomyKey, c.level)
		got := args()
		for _, w := range c.has {
			if !strings.Contains(got, w) {
				t.Errorf("%q: no %q in %s", c.level, w, got)
			}
		}
		for _, w := range c.not {
			if strings.Contains(got, w) {
				t.Errorf("%q: %q in %s", c.level, w, got)
			}
		}
	}

	s.M.CLI.Args = []string{skipPermissions}
	t.Setenv(settings.AutonomyKey, "limited")
	if got := args(); strings.Contains(got, "--allowedTools") || strings.Contains(got, "--mcp-config") {
		t.Errorf("ATC_CLAUDE_ARGS turning permissions off leaves the flags as they were: %s", got)
	}
}

func TestAgentFolderBehindALink(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	real := filepath.Join(root, "real")
	os.MkdirAll(real, 0o755)
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(Agent{Folder: link}.autonomyOnLine(""), " ")
	for _, d := range []string{link, real} {
		if !strings.Contains(got, "Edit(/"+d+"/**)") || !strings.Contains(got, "Edit(/"+d+"/settings.json)") {
			t.Errorf("no rules for %s: %s", d, got)
		}
	}
}

func TestAgentLine(t *testing.T) {
	s, ts, bin, st := agentServer(t)
	writeAgent(t, s.AgentsDir, "talker", `{"host":"here","title":"Talker","talk":true,"person":"p1"}`, "brief.md")
	os.WriteFile(filepath.Join(filepath.Dir(bin), "agents.json"), []byte(`[{"id":"abcd1234","sessionId":"m1","kind":"background","pid":1,"state":"working","startedAt":1000}]`), 0o644)
	st.Update("m1", func(m *store.Meta) { m.Agent = "talker" })

	if res, _ := do(t, "POST", ts.URL+"/api/agents/mail/line", "tok", ""); res.StatusCode != 403 {
		t.Errorf("an agent without talk: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/agents/nobody/line", "tok", ""); res.StatusCode != 404 {
		t.Errorf("no such agent: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", ts.URL+"/api/agents/talker/line", "tok", ""); res.StatusCode != 409 {
		t.Errorf("a working agent stays where it is: %d", res.StatusCode)
	}

	os.WriteFile(filepath.Join(filepath.Dir(bin), "agents.json"), []byte(`[]`), 0o644)
	res, b := do(t, "POST", ts.URL+"/api/agents/talker/line", "tok", "")
	if res.StatusCode != 200 {
		t.Fatalf("an idle agent: %d", res.StatusCode)
	}
	var spec struct {
		Session, Dir, Title, Person string
		Args                        []string
	}
	json.Unmarshal([]byte(b), &spec)
	if spec.Session == "" || spec.Title != "Talker" || spec.Person != "p1" || !slices.Contains(spec.Args, "--disallowedTools") {
		t.Fatalf("spec: %s", b)
	}
	if m := st.Get(spec.Session); m.Agent != "talker" || m.Parked {
		t.Errorf("its session is tagged and out of parked: %+v", m)
	}
}
