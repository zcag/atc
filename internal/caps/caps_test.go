package caps

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func script(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func envOf(bin string, vals map[string]string) Env {
	return Env{Bin: bin, Get: func(k string) string { return vals[k] }}
}

func rowOf(t *testing.T, rows []Row, id string) Row {
	t.Helper()
	for _, r := range rows {
		if r.ID == id {
			return r
		}
	}
	t.Fatalf("no row %s", id)
	return Row{}
}

func TestRegistryHoldsTogether(t *testing.T) {
	ids, keys := map[string]bool{}, map[string]bool{}
	for _, c := range All() {
		if ids[c.ID] {
			t.Errorf("%s appears twice", c.ID)
		}
		ids[c.ID] = true
		if c.Title == "" || !slices.Contains(Groups, c.Group) || c.Why == "" {
			t.Errorf("%s: needs a title, a known group and a why", c.ID)
		}
		if c.Fix.Command == "" && c.Fix.Text == "" {
			t.Errorf("%s: no fix", c.ID)
		}
		if c.Check == nil && len(c.Needs) == 0 {
			t.Errorf("%s: nothing decides how it stands", c.ID)
		}
		for _, f := range c.Fields {
			if keys[f.Key] {
				t.Errorf("%s appears twice", f.Key)
			}
			keys[f.Key] = true
		}
	}
	for _, c := range All() {
		for _, n := range c.Needs {
			if !ids[n] {
				t.Errorf("%s needs unknown %s", c.ID, n)
			}
		}
	}
	for _, g := range Groups {
		if !slices.ContainsFunc(All(), func(c Cap) bool { return c.Group == g }) {
			t.Errorf("group %s is empty", g)
		}
	}
}

func TestClaude(t *testing.T) {
	ctx := context.Background()
	ok := `case "$1" in --version) echo "2.1.318 (Claude Code)";; agents) echo '[]';; auth) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}';; esac`
	cases := []struct {
		name, bin string
		claude    Status
		signin    Status
		detail    string
	}{
		{"fine", script(t, ok), OK, OK, "2.1.318"},
		{"not installed", filepath.Join(t.TempDir(), "nope"), Missing, Missing, "Not installed"},
		{"too old", script(t, `echo "2.1.100 (Claude Code)"`), Broken, OK, MinClaude},
		{"newer is fine", script(t, `case "$1" in --version) echo "9.0.0";; esac`), OK, OK, "9.0.0"},
		{"agents fails", script(t, `case "$1" in --version) echo "2.1.318";; agents) echo boom; exit 1;; esac`), Broken, OK, "boom"},
		{"signed out", script(t, `case "$1" in --version) echo "2.1.318";; agents) echo '[]';; auth) echo '{"loggedIn":false,"authMethod":"none"}'; exit 1;; esac`), OK, Missing, "2.1.318"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rows := new(Runner).Rows(ctx, envOf(c.bin, nil), func(x Cap) bool { return x.Group == Core })
			got := rowOf(t, rows, "claude")
			if got.Status != c.claude || !strings.Contains(got.Detail, c.detail) {
				t.Errorf("claude: %s %q", got.Status, got.Detail)
			}
			if !got.Warn && got.Status != OK {
				t.Error("something required that is not ok should warn")
			}
			if s := rowOf(t, rows, "signin"); s.Status != c.signin {
				t.Errorf("signin: %s %q", s.Status, s.Detail)
			}
		})
	}
}

func TestHubWaitsForClaude(t *testing.T) {
	ctx := context.Background()
	hub := map[string]string{"ATC_HUB": "http://127.0.0.1:1"}
	rows := new(Runner).Rows(ctx, envOf(filepath.Join(t.TempDir(), "nope"), hub), nil)
	if r := rowOf(t, rows, "hub"); r.Status != Missing || !strings.Contains(r.Detail, "Waits for Claude Code") {
		t.Errorf("without Claude Code: %s %q", r.Status, r.Detail)
	}
	rows = new(Runner).Rows(ctx, envOf("true", hub), nil)
	if r := rowOf(t, rows, "hub"); r.Status != Broken || !strings.Contains(r.Detail, "nothing is listening") {
		t.Errorf("with Claude Code: %s %q", r.Status, r.Detail)
	}
}

func TestOptionalIsQuietUntilSetUp(t *testing.T) {
	bad := httptest.NewServer(http.NotFoundHandler())
	badURL := bad.URL
	bad.Close()
	ctx := context.Background()
	rows := new(Runner).Rows(ctx, envOf("true", nil), func(c Cap) bool { return c.Group != Core })
	for _, r := range rows {
		if r.Status == Broken || r.Warn {
			t.Errorf("%s never set up should be quiet: %s %q", r.ID, r.Status, r.Detail)
		}
	}
	rows = new(Runner).Rows(ctx, envOf("true", map[string]string{"ATC_BROWSER": badURL, "ATC_STT_URL": badURL + "/v1?key=sekret"}), nil)
	for _, id := range []string{"browser", "stt"} {
		r := rowOf(t, rows, id)
		if r.Status != Broken || !r.Warn || !strings.Contains(r.Detail, "nothing is listening") {
			t.Errorf("%s: %s %q", id, r.Status, r.Detail)
		}
		if strings.Contains(r.Detail, "sekret") {
			t.Errorf("%s leaks its address's query: %q", id, r.Detail)
		}
	}
}

func TestCallsNeedsItsParts(t *testing.T) {
	mux := http.NewServeMux()
	talkers := 1
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"alive": true, "talkers": map[string]int{"app": talkers}})
	})
	mux.HandleFunc("/api/voices", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"en":{"voices":["a","b"]}}`)) })
	mux.HandleFunc("/v1/voices", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) })
	ts := httptest.NewServer(mux)
	defer ts.Close()
	calls := func(c Cap) bool { return c.Group == Calls }
	ctx := context.Background()

	rows := new(Runner).Rows(ctx, envOf("true", nil), calls)
	r := rowOf(t, rows, "calls")
	if r.Status != Missing || r.Warn || !strings.Contains(r.Detail, "Talker") || !strings.Contains(r.Detail, "Voice engine") {
		t.Fatalf("calls with nothing: %s %q", r.Status, r.Detail)
	}
	if !slices.ContainsFunc(r.Needs, func(n Need) bool { return n.ID == "talker" && n.Status == Missing }) {
		t.Fatalf("needs %+v", r.Needs)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	voiceEnv := filepath.Join(home, ".config/atc/voice.env")
	if err := os.MkdirAll(filepath.Dir(voiceEnv), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(voiceEnv, []byte("TTS_PORT=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	all := map[string]string{"ATC_HUB": ts.URL, "ATC_CALL_LINE": ts.URL}
	rows = new(Runner).Rows(ctx, envOf("true", all), calls)
	if r = rowOf(t, rows, "voice-engine"); r.Status != Broken || !strings.Contains(r.Detail, "silent") {
		t.Fatalf("no voice engine: %s %q", r.Status, r.Detail)
	}
	if r = rowOf(t, rows, "calls"); r.Status != Broken || !strings.Contains(r.Detail, "Voice engine") {
		t.Fatalf("calls without a voice engine: %s %q", r.Status, r.Detail)
	}
	if err := os.WriteFile(voiceEnv, []byte("TALK_TTS="+ts.URL+"/v1/audio/speech\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r = rowOf(t, new(Runner).Rows(ctx, envOf("true", all), calls), "calls"); r.Status != OK {
		t.Fatalf("calls with everything, no voice picker: %s %q %+v", r.Status, r.Detail, r.Needs)
	}
	if err := os.WriteFile(voiceEnv, []byte("TALK_TTS="+ts.URL+"/v1/audio/speech\nTTS_ENGINES=remote\nTTS_REMOTE_URL=http://127.0.0.1:1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r = rowOf(t, new(Runner).Rows(ctx, envOf("true", all), calls), "voice-engine"); r.Status != Broken || !strings.Contains(r.Detail, "Your voice server") {
		t.Fatalf("own voice server down: %s %q", r.Status, r.Detail)
	}
	if err := os.WriteFile(voiceEnv, []byte("TALK_TTS="+ts.URL+"/v1/audio/speech\nTTS_ENGINES=pocket,remote\nTTS_REMOTE_URL="+ts.URL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r = rowOf(t, new(Runner).Rows(ctx, envOf("true", all), calls), "voice-engine"); r.Status != OK || !strings.Contains(r.Detail, "Your voice server") && !strings.Contains(r.Detail, "your voice server") {
		t.Fatalf("own voice server up: %s %q", r.Status, r.Detail)
	}
	all["ATC_CALL_LINE"] = "http://other-machine:8807"
	if r = rowOf(t, new(Runner).Rows(ctx, envOf("true", all), calls), "voice-engine"); r.Status != OK {
		t.Fatalf("voice engine with the line elsewhere: %s %q", r.Status, r.Detail)
	}
	all["ATC_CALL_LINE"] = ts.URL
	talkers = 0
	rows = new(Runner).Rows(ctx, envOf("true", all), calls)
	if r = rowOf(t, rows, "talker"); r.Status != Broken {
		t.Fatalf("no talker: %s %q", r.Status, r.Detail)
	}
	if r = rowOf(t, rows, "calls"); r.Status != Broken || !strings.Contains(r.Detail, "Talker") {
		t.Fatalf("calls without a talker: %s %q", r.Status, r.Detail)
	}
}

func TestWhatsAppStates(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "right" {
			w.WriteHeader(401)
			return
		}
		w.Write([]byte(`{"status":"ready"}`))
	}))
	defer ts.Close()
	full := func(key string) Env {
		return envOf("true", map[string]string{"ATC_WHATSAPP_URL": ts.URL, "ATC_WHATSAPP_KEY": key, "ATC_WHATSAPP_SESSION": "s", "ATC_WHATSAPP_OWNER": "1", "ATC_WHATSAPP_SECRET": "0123456789abcdef"})
	}
	ctx := context.Background()
	if r := checkWhatsApp(ctx, full("right")); r.Status != OK {
		t.Fatal(r)
	}
	if r := checkWhatsApp(ctx, full("wrong")); r.Status != Broken || strings.Contains(r.Detail, "wrong") {
		t.Fatal(r)
	}
	if r := checkWhatsApp(ctx, envOf("true", map[string]string{"ATC_WHATSAPP_URL": ts.URL})); r.Status != Broken || !strings.Contains(r.Detail, "ATC_WHATSAPP_KEY") {
		t.Fatal(r)
	}
	if r := checkWhatsApp(ctx, envOf("true", nil)); r.Status != Missing {
		t.Fatal(r)
	}
}

func TestChecksNeverBlockTheList(t *testing.T) {
	hang := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-hang }))
	defer ts.Close()
	defer close(hang)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	vals := map[string]string{"ATC_BROWSER": ts.URL, "ATC_HUB": ts.URL, "ATC_OPENCODE": ts.URL}
	rows := new(Runner).Rows(ctx, envOf("true", vals), nil)
	if time.Since(start) > 2*time.Second {
		t.Fatalf("took %v", time.Since(start))
	}
	if r := rowOf(t, rows, "browser"); r.Status != Broken {
		t.Fatal(r.Status, r.Detail)
	}
}

func TestResultsAreCachedBriefly(t *testing.T) {
	hits := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer ts.Close()
	var rn Runner
	env := envOf("true", map[string]string{"ATC_STT_URL": ts.URL})
	pick := func(c Cap) bool { return c.ID == "stt" }
	rn.Rows(context.Background(), env, pick)
	rn.Rows(context.Background(), env, pick)
	if hits != 1 {
		t.Fatalf("%d probes, want the second list from the cache", hits)
	}
	rn.Test(context.Background(), env, "stt", nil)
	if hits != 2 {
		t.Fatalf("%d probes, a test should run now", hits)
	}
}

func TestTestTriesAValueWithoutKeepingIt(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer ts.Close()
	var rn Runner
	env := envOf("true", nil)
	r, ok := rn.Test(context.Background(), env, "stt", map[string]string{"ATC_STT_URL": ts.URL})
	if !ok || r.Status != OK {
		t.Fatalf("%v %+v", ok, r)
	}
	if r = rowOf(t, rn.Rows(context.Background(), env, nil), "stt"); r.Status != Missing {
		t.Fatalf("a tried value stuck: %s", r.Status)
	}
	if _, ok := rn.Test(context.Background(), env, "nope", nil); ok {
		t.Fatal("unknown id")
	}
}

func TestSecretsAreNotInARow(t *testing.T) {
	env := envOf("true", map[string]string{"ATC_WHATSAPP_KEY": "sekret", "ATC_WHATSAPP_URL": "http://me:sekret@gw/x?key=sekret"})
	r := rowOf(t, new(Runner).Rows(context.Background(), env, func(c Cap) bool { return c.ID == "whatsapp" }), "whatsapp")
	b, _ := json.Marshal(r)
	if strings.Contains(string(b), "sekret") {
		t.Fatalf("leaked: %s", b)
	}
	i := slices.IndexFunc(r.Fields, func(f FieldState) bool { return f.Key == "ATC_WHATSAPP_KEY" })
	if !r.Fields[i].Set {
		t.Fatal("a secret should say it is set")
	}
}

func TestSetupPromptSaysWhatToDo(t *testing.T) {
	r := rowOf(t, new(Runner).Rows(context.Background(), envOf("true", nil), func(c Cap) bool { return c.ID == "browser" }), "browser")
	for _, want := range []string{r.Title, r.Detail, "ATC_BROWSER", "atc doctor", r.Fix.Text} {
		if !strings.Contains(r.Setup, want) {
			t.Errorf("no %q in %q", want, r.Setup)
		}
	}
}

func TestOlder(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"2.1.138", "2.1.139", true}, {"2.1.139", "2.1.139", false}, {"2.2.0", "2.1.139", false}, {"3.0", "2.1.139", false}, {"2.1", "2.1.139", true}} {
		if older(c.a, c.b) != c.want {
			t.Errorf("older(%s, %s)", c.a, c.b)
		}
	}
}

func TestAgentFolders(t *testing.T) {
	home, dir := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	dir, _ = filepath.EvalSymlinks(dir)
	env := Env{Agents: []AgentFolder{{Name: "mail", Dir: filepath.Join(dir, "mail"), Scheduled: true}, {Name: "idle", Dir: filepath.Join(dir, "nowhere", "idle")}}}
	if r := checkAgentFolders(context.Background(), Env{}); r.Status != Missing {
		t.Errorf("no agents: %+v", r)
	}
	if r := checkAgentFolders(context.Background(), env); r.Status != Broken || !strings.Contains(r.Detail, "@mail") {
		t.Errorf("untrusted: %+v", r)
	}
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"projects":{"`+dir+`":{"hasTrustDialogAccepted":true}}}`), 0o600)
	if r := checkAgentFolders(context.Background(), env); r.Status != OK {
		t.Errorf("trusted parent: %+v", r)
	}
}
