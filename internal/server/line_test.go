package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/zcag/atc/internal/store"
)

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
