package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

// trustingClaude behaves as the real one was measured to: --bg refuses a folder until the config
// records a yes for it, and refuses the home folder whatever the config says.
func trustingClaude(t *testing.T) (bin, home string) {
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	dir := t.TempDir()
	bin = filepath.Join(dir, "claude")
	os.WriteFile(bin, []byte(`#!/bin/sh
case "$1" in
agents)
  if [ -f "`+dir+`/started" ]; then echo '[{"id":"abcd1234","sessionId":"m1","kind":"background","pid":1,"state":"done","startedAt":1000}]'; else echo '[]'; fi ;;
--bg)
  if [ "$PWD" = "$HOME" ]; then echo "Workspace not trusted. The home directory is trusted one session at a time"; exit 1
  elif grep -qF "\"$(pwd -P)\"" "$HOME/.claude.json" 2>/dev/null; then echo "$@" > "`+dir+`/started"; echo "backgrounded · abcd1234"
  else echo "Workspace not trusted. Run claude once"; exit 1; fi ;;
esac
`), 0o755)
	return bin, home
}

func startIn(t *testing.T, base, dir string) (*http.Response, string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"dir": dir, "prompt": "the first message"})
	return do(t, "POST", base+"/api/sessions", "tok", string(b))
}

func TestAStartInANewFolderRecordsTrust(t *testing.T) {
	bin, home := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"numStartups": 7, "projects": {"/elsewhere": {"allowedTools": ["x"]}}}`), 0o600)
	dir := t.TempDir()
	if res, body := startIn(t, ts.URL, dir); res.StatusCode != 200 {
		t.Fatalf("start in an untrusted folder: %d %s", res.StatusCode, body)
	}
	if args, _ := os.ReadFile(filepath.Join(filepath.Dir(bin), "started")); !strings.Contains(string(args), "the first message") {
		t.Errorf("start args: %s", args)
	}
	b, _ := os.ReadFile(filepath.Join(home, ".claude.json"))
	var cfg struct {
		NumStartups int `json:"numStartups"`
		Projects    map[string]struct {
			Accepted bool     `json:"hasTrustDialogAccepted"`
			Tools    []string `json:"allowedTools"`
		} `json:"projects"`
	}
	json.Unmarshal(b, &cfg)
	real, _ := filepath.EvalSymlinks(dir)
	if !cfg.Projects[real].Accepted || cfg.NumStartups != 7 || len(cfg.Projects["/elsewhere"].Tools) != 1 {
		t.Errorf("config after the start: %s", b)
	}
}

func TestAssistantWithoutAHubStartsInItsOwnFolder(t *testing.T) {
	bin, home := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	if res, body := do(t, "POST", ts.URL+"/api/assist", "tok", ""); res.StatusCode != 200 {
		t.Fatalf("assist: %d %s", res.StatusCode, body)
	}
	if !exists(filepath.Join(home, ".local/share/atc/assistant")) {
		t.Error("its folder was not made")
	}
}

func TestHomeFolderCantStart(t *testing.T) {
	bin, home := trustingClaude(t)
	ts := serverWith(t, bin, nil, Voice{})
	res, body := startIn(t, ts.URL, home)
	if res.StatusCode != http.StatusBadRequest || !strings.Contains(body, "Pick a project folder") {
		t.Errorf("start in home: %d %s", res.StatusCode, body)
	}
	if _, body := get(t, ts.URL+"/api/trust?dir="+url.QueryEscape(home), "tok"); !strings.Contains(body, `"home"`) {
		t.Errorf("state: %s", body)
	}
	if _, body := get(t, ts.URL+"/api/trust?dir="+url.QueryEscape(t.TempDir()), "tok"); !strings.Contains(body, `""`) {
		t.Errorf("state of another folder: %s", body)
	}
}

func TestAScheduledAgentInANewFolderWakes(t *testing.T) {
	bin, _ := trustingClaude(t)
	root, _ := filepath.EvalSymlinks(t.TempDir())
	writeAgent(t, root, "mail", `{"host":"here","prompt":"Check mail.","every":"5m"}`)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Web: fstest.MapFS{}, Token: "tok", Host: "here", AgentsDir: root, StateDir: t.TempDir()}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	a, _ := s.agentNamed("mail")
	s.tick(a)
	if _, err := os.Stat(filepath.Join(filepath.Dir(bin), "started")); err != nil {
		t.Fatal("the wake-up did not start it")
	}
}
