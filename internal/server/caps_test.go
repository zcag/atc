package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/zcag/atc/internal/caps"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/settings"
	"github.com/zcag/atc/internal/store"
)

func capsServer(t *testing.T, bin, host string, peers []Peer) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	set, err := settings.Apply(dir)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := store.Open(filepath.Join(dir, "meta.json"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Web:   fstest.MapFS{"index.html": {Data: []byte("<!doctype html>atc")}},
		Token: "tok", Host: host, Peers: peers, Settings: set, StateDir: dir, Version: "1.2.3"}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, dir
}

func capsOf(t *testing.T, url string) CapsReport {
	t.Helper()
	res, body := get(t, url, "tok")
	if res.StatusCode != 200 {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	var rep CapsReport
	if err := json.Unmarshal([]byte(body), &rep); err != nil {
		t.Fatal(err, body)
	}
	return rep
}

func row(t *testing.T, m CapsMachine, id string) caps.Row {
	t.Helper()
	i := slices.IndexFunc(m.Rows, func(r caps.Row) bool { return r.ID == id })
	if i < 0 {
		t.Fatalf("no row %s", id)
	}
	return m.Rows[i]
}

func TestCapsNeedsTheToken(t *testing.T) {
	ts, _ := capsServer(t, fakeClaude(t), "here", nil)
	if res, _ := get(t, ts.URL+"/api/caps", ""); res.StatusCode != 401 {
		t.Fatalf("list %d", res.StatusCode)
	}
	if res, _ := do(t, "PUT", ts.URL+"/api/settings", "", `{"user":"x"}`); res.StatusCode != 401 {
		t.Fatalf("settings %d", res.StatusCode)
	}
}

func TestCapsListsAndNamesTheFix(t *testing.T) {
	ts, _ := capsServer(t, filepath.Join(t.TempDir(), "nope"), "here", nil)
	m := capsOf(t, ts.URL+"/api/caps").Machines[0]
	if m.Host != "here" || m.Version != "1.2.3" {
		t.Fatalf("%+v", m)
	}
	c := row(t, m, "claude")
	if c.Status != caps.Missing || !c.Warn || c.Fix.Command == "" || c.Setup == "" {
		t.Fatalf("%+v", c)
	}
	if core := capsOf(t, ts.URL+"/api/caps?group=core").Machines[0]; slices.ContainsFunc(core.Rows, func(r caps.Row) bool { return r.Group != caps.Core }) {
		t.Fatal("group=core should only hold Core")
	}
	res, _ := get(t, ts.URL+"/api/sessions?local=1", "tok")
	if res.StatusCode != 503 {
		t.Fatalf("sessions without claude: %d", res.StatusCode)
	}
}

func TestCapsFollowsPeers(t *testing.T) {
	far, _ := capsServer(t, fakeClaude(t), "far", nil)
	dead := httptest.NewServer(nil)
	deadURL := dead.URL
	dead.Close()
	ts, _ := capsServer(t, fakeClaude(t), "here", []Peer{{Name: "laptop", URL: far.URL, Token: "tok"}, {Name: "gone", URL: deadURL, Token: "tok"}})
	rep := capsOf(t, ts.URL+"/api/caps")
	if len(rep.Machines) != 3 || rep.Machines[0].Host != "here" || rep.Machines[1].Host != "laptop" || rep.Machines[2].Host != "gone" {
		t.Fatalf("%+v", rep.Machines)
	}
	if len(rep.Machines[1].Rows) == 0 || rep.Machines[2].Error == "" {
		t.Fatalf("laptop %d rows, gone %q", len(rep.Machines[1].Rows), rep.Machines[2].Error)
	}
	if strings.Contains(rep.Machines[2].Error, "tok") {
		t.Fatal(rep.Machines[2].Error)
	}
	if local := capsOf(t, ts.URL+"/api/caps?local=1"); len(local.Machines) != 1 {
		t.Fatalf("%d machines with local=1", len(local.Machines))
	}
}

func TestPutSettings(t *testing.T) {
	const secretKey, urlKey = "ATC_WHATSAPP_KEY", "ATC_BROWSER"
	t.Setenv(secretKey, "")
	os.Unsetenv(secretKey)
	t.Setenv(urlKey, "")
	os.Unsetenv(urlKey)
	ts, dir := capsServer(t, fakeClaude(t), "here", nil)

	res, body := do(t, "PUT", ts.URL+"/api/settings", "tok", `{"env":{"ATC_NOT_A_SETTING":"x"}}`)
	if res.StatusCode != 400 {
		t.Fatalf("unknown key: %d %s", res.StatusCode, body)
	}
	if res, _ = do(t, "PUT", ts.URL+"/api/settings", "tok", `{"env":{"ATC_BROWSER":"not a url"}}`); res.StatusCode != 400 {
		t.Fatalf("bad url: %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err == nil {
		t.Fatal("a refused write left a file")
	}

	res, body = do(t, "PUT", ts.URL+"/api/settings", "tok", `{"user":"Ada","env":{"ATC_WHATSAPP_KEY":"sekret","ATC_BROWSER":"http://127.0.0.1:1"}}`)
	if res.StatusCode != 200 {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	var out struct {
		Restart []string `json:"restart"`
	}
	json.Unmarshal([]byte(body), &out)
	if !slices.Equal(out.Restart, []string{"atc", "atc-hub"}) {
		t.Fatalf("a name reaches the hub's prompts too: %s", body)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if !strings.Contains(string(b), "sekret") || !strings.Contains(string(b), "Ada") {
		t.Fatalf("%s", b)
	}

	_, list := get(t, ts.URL+"/api/caps", "tok")
	if strings.Contains(list, "sekret") {
		t.Fatal("the list returned a secret in clear")
	}
	m := capsOf(t, ts.URL+"/api/caps").Machines[0]
	if m.Identity.User != "Ada" || len(m.Restart) != 2 {
		t.Fatalf("%+v", m)
	}
	if r := row(t, m, "browser"); r.Status != caps.Broken || r.Fields[0].Source != "settings" {
		t.Fatalf("a saved value should be checked at once: %+v", r)
	}
	wa := row(t, m, "whatsapp")
	i := slices.IndexFunc(wa.Fields, func(f caps.FieldState) bool { return f.Key == secretKey })
	if !wa.Fields[i].Set || wa.Fields[i].Value != "" {
		t.Fatalf("%+v", wa.Fields[i])
	}

	do(t, "PUT", ts.URL+"/api/settings", "tok", `{"env":{"ATC_BROWSER":null}}`)
	b, _ = os.ReadFile(filepath.Join(dir, "settings.json"))
	if strings.Contains(string(b), "ATC_BROWSER") || !strings.Contains(string(b), "sekret") {
		t.Fatalf("null removes that key and nothing else: %s", b)
	}
	if r := row(t, capsOf(t, ts.URL+"/api/caps").Machines[0], "browser"); r.Status != caps.Missing {
		t.Fatalf("after removing: %+v", r)
	}
}

func TestPutSettingsSaysTheEnvironmentWins(t *testing.T) {
	t.Setenv("ATC_BROWSER", "http://127.0.0.1:2")
	ts, _ := capsServer(t, fakeClaude(t), "here", nil)
	_, body := do(t, "PUT", ts.URL+"/api/settings", "tok", `{"env":{"ATC_BROWSER":"http://127.0.0.1:3"}}`)
	var out struct {
		Overridden []string `json:"overridden"`
		Restart    []string `json:"restart"`
	}
	json.Unmarshal([]byte(body), &out)
	if !slices.Equal(out.Overridden, []string{"ATC_BROWSER"}) || len(out.Restart) != 0 {
		t.Fatalf("%s", body)
	}
}

func TestPutSettingsLeavesABrokenFileAlone(t *testing.T) {
	ts, dir := capsServer(t, fakeClaude(t), "here", nil)
	p := filepath.Join(dir, "settings.json")
	os.WriteFile(p, []byte("{broken"), 0o600)
	if res, _ := do(t, "PUT", ts.URL+"/api/settings", "tok", `{"user":"x"}`); res.StatusCode != 409 {
		t.Fatalf("%d", res.StatusCode)
	}
	if b, _ := os.ReadFile(p); string(b) != "{broken" {
		t.Fatalf("%s", b)
	}
	if m := capsOf(t, ts.URL+"/api/caps").Machines[0]; m.SettingsError == "" {
		t.Fatal("the page should hear about it")
	}
}

func TestCapsTest(t *testing.T) {
	up := httptest.NewServer(nil)
	defer up.Close()
	t.Setenv("ATC_STT_URL", "")
	os.Unsetenv("ATC_STT_URL")
	ts, _ := capsServer(t, fakeClaude(t), "here", nil)
	res, body := do(t, "POST", ts.URL+"/api/caps/stt/test", "tok", `{"values":{"ATC_STT_URL":"`+up.URL+`"}}`)
	var r caps.Row
	json.Unmarshal([]byte(body), &r)
	if res.StatusCode != 200 || r.Status != caps.OK {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	if _, body = do(t, "POST", ts.URL+"/api/caps/stt/test", "tok", ``); !strings.Contains(body, `"missing"`) {
		t.Fatalf("a tried value should not stick: %s", body)
	}
	if res, _ = do(t, "POST", ts.URL+"/api/caps/nope/test", "tok", ``); res.StatusCode != 404 {
		t.Fatalf("unknown row: %d", res.StatusCode)
	}
	if res, _ = do(t, "POST", ts.URL+"/api/caps/stt/test", "tok", `{"values":{"ATC_NOPE":"x"}}`); res.StatusCode != 400 {
		t.Fatalf("unknown key: %d", res.StatusCode)
	}
}

func TestCapsAlone(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "peers.json"), []byte(`[{"name":"far","url":"http://127.0.0.1:1","token":"t"}]`), 0o600)
	set, _ := settings.Apply(dir)
	rep := CapsAlone(t.Context(), set, "here", "1", fakeClaude(t), "http://127.0.0.1:1")
	m := rep.Machines[0]
	if s := row(t, m, "server"); s.Status != caps.Broken || !s.Warn {
		t.Fatalf("%+v", s)
	}
	if p := row(t, m, "peers"); p.Status != caps.Broken {
		t.Fatalf("%+v", p)
	}
	if _, err := os.Stat(filepath.Join(dir, "devices.json")); err == nil {
		t.Fatal("doctor should leave no files behind")
	}
}
