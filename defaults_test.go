package main

import (
	"bufio"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/server"
	"github.com/zcag/atc/internal/settings"
)

func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("ATC_CONFIG_DIR", "")
	stub := filepath.Join(home, "stub")
	os.MkdirAll(stub, 0o755)
	for _, name := range []string{"systemctl", "launchctl"} {
		os.WriteFile(filepath.Join(stub, name), []byte("#!/bin/sh\nexit 0\n"), 0o755)
	}
	t.Setenv("PATH", stub+string(os.PathListSeparator)+os.Getenv("PATH"))
	return home
}

func TestShippedPersonsEachHaveAVoiceEveryEngineCanUse(t *testing.T) {
	b, err := voiceFiles.ReadFile("voice/persons.json")
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		server.Persons
		Voices map[string]map[string]string `json:"voices"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	if len(d.Persons.Persons) != 3 {
		t.Fatalf("%d persons", len(d.Persons.Persons))
	}
	for _, p := range d.Persons.Persons {
		if p.Character == "" || p.Background == "" {
			t.Errorf("%s has no character or room", p.Name)
		}
		for lang, v := range p.Voices {
			if _, ok := d.Voices[v]; !ok {
				t.Errorf("%s speaks %s as %s, which the table doesn't define", p.Name, lang, v)
			}
		}
	}
	for lang, id := range d.Langs {
		if _, err := voiceFiles.ReadFile("voice/lang/" + lang + ".json"); err != nil {
			t.Errorf("no pack for %s", lang)
		}
		if !strings.Contains(string(b), `"id": "`+id+`"`) {
			t.Errorf("%s is the assistant in %s, and nobody", id, lang)
		}
	}
	for voice, engines := range d.Voices {
		for engine, value := range engines {
			if !speaks(engine, "en") && !speaks(engine, "tr") {
				t.Errorf("%s: unknown engine %s", voice, engine)
			}
			if strings.Contains(value, ".") {
				if _, err := voiceFiles.ReadFile("voice/voices/" + value); err != nil {
					t.Errorf("%s on %s is %s, which isn't shipped", voice, engine, value)
				}
			}
		}
	}
}

func TestEnginesFollowTheLanguages(t *testing.T) {
	for _, c := range []struct {
		have        string
		langs       []string
		want        string
		keep, wants map[string]string
	}{
		{"", []string{"en"}, "pocket-en", nil, map[string]string{"TALK_TTS_ENGINE": "pocket-en"}},
		{"", []string{"tr"}, "pocket,ahenk", nil, map[string]string{"TALK_TTS_ENGINE": "pocket"}},
		{"", []string{"tr", "en"}, "pocket,ahenk,pocket-en", nil, map[string]string{"TALK_TTS_ENGINE": "pocket", "TALK_TTS_ENGINE_EN": "pocket-en"}},
		{"pocket-en", []string{"tr"}, "pocket-en,pocket,ahenk", map[string]string{"TALK_TTS_ENGINE": "pocket-en"}, map[string]string{"TALK_TTS_ENGINE": "pocket"}},
		{"higgs", []string{"tr", "en"}, "higgs", map[string]string{"TALK_TTS_ENGINE": "higgs", "TALK_TTS_ENGINE_EN": "higgs"}, map[string]string{}},
		{"kokoro", []string{"en"}, "kokoro", map[string]string{"TALK_TTS_ENGINE": "kokoro"}, map[string]string{}},
		{"pocket", []string{"tr"}, "pocket,ahenk", map[string]string{"TALK_TTS_ENGINE": "pocket"}, map[string]string{}},
		{"pocket,higgs", []string{"tr", "en"}, "pocket,higgs", map[string]string{"TALK_TTS_ENGINE": "pocket", "TALK_TTS_ENGINE_EN": "higgs"}, map[string]string{}},
		{"pocket,remote", []string{"tr"}, "pocket,remote", map[string]string{"TALK_TTS_ENGINE": "pocket"}, map[string]string{}},
	} {
		got := wantedEngines(c.have, c.langs, "linux", "amd64")
		if got != c.want {
			t.Errorf("%q %v: engines %q, want %q", c.have, c.langs, got, c.want)
		}
		if keys := voiceEngineKeys(c.keep, got, c.langs); !maps.Equal(keys, c.wants) {
			t.Errorf("%q %v: keys %v, want %v", c.have, c.langs, keys, c.wants)
		}
	}
}

func TestVoiceEnginesBehind(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		want bool
	}{
		{map[string]string{"TALK_LANG": "tr", "TTS_ENGINES": "pocket"}, true},
		{map[string]string{"TALK_LANG": "tr", "TTS_ENGINES": "pocket,ahenk"}, false},
		{map[string]string{"TALK_LANG": "tr", "TTS_ENGINES": "pocket,higgs"}, false},
		{map[string]string{"TALK_LANG": "en", "TALK_ALSO": "tr", "TTS_ENGINES": "pocket-en,pocket"}, true},
		{map[string]string{"TALK_LANG": "en", "TTS_ENGINES": "pocket-en"}, false},
	} {
		if got := voiceEnginesBehind(c.env); got != c.want {
			t.Errorf("%v: %v", c.env, got)
		}
	}
}

func TestStarterAgentsStartWithNoSchedule(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "agents.d")
	s := &server.Server{AgentsDir: dir, Host: "box"}
	if err := s.SeedAgents(starterAgents); err != nil {
		t.Fatal(err)
	}
	names, _ := os.ReadDir(dir)
	if len(names) != 6 {
		t.Fatalf("%d agents", len(names))
	}
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(dir, n.Name(), "agent.json"))
		if err != nil {
			t.Fatal(err)
		}
		var a map[string]any
		json.Unmarshal(b, &a)
		if a["host"] != "box" || a["every"] != nil || a["from"] != nil || a["check"] != nil || a["prompt"] == "" {
			t.Errorf("%s: %s", n.Name(), b)
		}
		if _, err := os.Stat(filepath.Join(dir, n.Name(), "brief.md")); err != nil {
			t.Error(err)
		}
	}
	if st, err := os.Stat(filepath.Join(dir, "ops", "unresolved-alerts.sh")); err != nil || st.Mode()&0o100 == 0 {
		t.Errorf("the check script can't run: %v %v", st, err)
	}
	os.RemoveAll(filepath.Join(dir, "ops"))
	if err := s.SeedAgents(starterAgents); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ops")); err == nil {
		t.Fatal("a deleted agent came back")
	}
}

func TestVoiceInstallRefusesAnEngineThatCantSpeakTheLanguage(t *testing.T) {
	isolate(t)
	err := voiceInstall([]string{"--lang", "tr", "--engine", "kokoro"})
	if err == nil || !strings.Contains(err.Error(), "can speak tr") {
		t.Fatal(err)
	}
	if _, err := os.Stat(voiceEnvPath()); err == nil {
		t.Fatal("wrote voice.env anyway")
	}
}

func TestAssistantVoiceStartsAsTheShippedPerson(t *testing.T) {
	home := isolate(t)
	picks := filepath.Join(home, ".local/state/atc/voice/voice.json")
	read := func() map[string]string {
		got := map[string]string{}
		b, _ := os.ReadFile(picks)
		json.Unmarshal(b, &got)
		return got
	}
	if err := keepAssistantVoices(map[string]string{}, []string{"en", "tr"}); err != nil {
		t.Fatal(err)
	}
	if got := read(); got["en"] != "june" || got["tr"] != "june" {
		t.Fatal(got)
	}
	os.WriteFile(picks, []byte(`{"en":"tom"}`), 0o644)
	keepAssistantVoices(map[string]string{}, []string{"en", "tr"})
	if got := read(); got["en"] != "tom" || got["tr"] != "june" {
		t.Fatalf("a pick was overwritten: %v", got)
	}
	os.Remove(picks)
	keepAssistantVoices(map[string]string{"TALK_TTS_VOICE": "alba"}, []string{"en"})
	if got := read(); got["en"] != "" {
		t.Fatalf("voice.env's voice lost to the person's: %v", got)
	}
	os.MkdirAll(client.ConfigDir(), 0o755)
	os.WriteFile(filepath.Join(client.ConfigDir(), "persons.json"), []byte(`{"persons":[{"id":"a","voices":{"en":"mine"}}],"langs":{"en":"a"}}`), 0o644)
	keepAssistantVoices(map[string]string{}, []string{"en"})
	if got := read(); got["en"] != "mine" {
		t.Fatalf("saved persons ignored: %v", got)
	}
}

func TestSetUnsetKeepsWhatIsSet(t *testing.T) {
	isolate(t)
	t.Setenv("ATC_PUBLIC_URL", "")
	path := filepath.Join(client.ConfigDir(), "env")
	os.MkdirAll(client.ConfigDir(), 0o755)
	os.WriteFile(path, []byte("ATC_CALL_VOICES=http://mine\n"), 0o600)
	if err := setUnset(map[string]string{"ATC_CALL_VOICES": "http://ours", "ATC_CALL_LINE": "http://line"}); err != nil {
		t.Fatal(err)
	}
	got := readEnvFile(path)
	if got["ATC_CALL_VOICES"] != "http://mine" || got["ATC_CALL_LINE"] != "http://line" {
		t.Fatal(got)
	}
}

func TestSetupAutonomyAsksKeepsAndIsChangedByTheFlag(t *testing.T) {
	isolate(t)
	t.Setenv(settings.AutonomyKey, "")
	var err error
	if conf, err = settings.Apply(client.ConfigDir()); err != nil {
		t.Fatal(err)
	}
	saved := func() string { f, _ := conf.Load(); return f.Env[settings.AutonomyKey] }
	for _, c := range []struct {
		yes         bool
		input, flag string
		want        string
	}{
		{true, "", "", "daily"},
		{false, "limited\n", "", "limited"},
		{false, "\n", "", "limited"},
		{false, "FULL\n", "", "full"},
		{false, "lots\n", "", "daily"},
		{true, "", "full", "full"},
	} {
		setupAutonomy(asker{bufio.NewReader(strings.NewReader(c.input)), c.yes}, c.flag)
		if got := saved(); got != c.want {
			t.Errorf("%+v: saved %q", c, got)
		}
	}
}

func TestConsent(t *testing.T) {
	ask := func(yes bool, input string, given, byDefault bool) bool {
		return asker{bufio.NewReader(strings.NewReader(input)), yes}.consent("q", "--flag", given, byDefault)
	}
	for name, c := range map[string]struct {
		got, want bool
	}{
		"--yes alone is no": {ask(true, "", false, true), false},
		"the flag is yes":   {ask(true, "", true, false), true},
		"enter takes a yes": {ask(false, "\n", false, true), true},
		"enter leaves a no": {ask(false, "\n", false, false), false},
		"y overrides a no":  {ask(false, "y\n", false, false), true},
		"no answer is no":   {ask(false, "", false, true), false},
		"n overrides a yes": {ask(false, "n\n", false, true), false},
	} {
		if c.got != c.want {
			t.Error(name)
		}
	}
}

func TestTailscaleSetupRecordsTheAddressAndAsksAboutTrust(t *testing.T) {
	home := isolate(t)
	t.Setenv("ATC_PUBLIC_URL", "")
	t.Setenv("ATC_TRUST_TAILNET", "")
	t.Setenv("SSH_CONNECTION", "")
	os.WriteFile(filepath.Join(home, "stub", "tailscale"), []byte("#!/bin/sh\n[ \"$1\" = status ] && echo '{\"Self\":{\"DNSName\":\"box.tail.ts.net.\"}}'\nexit 0\n"), 0o755)
	env := filepath.Join(client.ConfigDir(), "env")
	setupReach(asker{bufio.NewReader(strings.NewReader("y\nn\n")), false}, false)
	got := readEnvFile(env)
	if got["ATC_PUBLIC_URL"] != "https://box.tail.ts.net" {
		t.Fatal(got)
	}
	if got["ATC_TRUST_TAILNET"] != "" {
		t.Fatal("trusted the tailnet after a no")
	}
	setupReach(asker{bufio.NewReader(strings.NewReader("y\ny\n")), false}, false)
	if got := readEnvFile(env); got["ATC_TRUST_TAILNET"] != "1" {
		t.Fatal(got)
	}
}

func TestOpencodeServiceIsOnRequestAndWritesItsUnit(t *testing.T) {
	home := isolate(t)
	t.Setenv("ATC_OPENCODE", "")
	t.Setenv("ATC_OPENCODE_BIN", "")
	for _, s := range services("") {
		if s.name == "opencode" {
			t.Fatal("opencode is installed by default")
		}
	}
	t.Setenv("PATH", filepath.Join(home, "stub"))
	if err := opencodeInstall(false); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(home, ".opencode/bin"), 0o755)
	os.WriteFile(filepath.Join(home, ".opencode/bin/opencode"), []byte("#!/bin/sh\n"), 0o755)
	if err := opencodeInstall(false); err != nil {
		t.Fatal(err)
	}
	unit, _ := os.ReadFile(filepath.Join(home, ".config/systemd/user/opencode.service"))
	if !strings.Contains(string(unit), "ExecStart="+home+"/.opencode/bin/opencode serve") {
		t.Fatalf("%s", unit)
	}
	for _, f := range []string{"opencode/opencode.json", "opencode/agent/atc.md"} {
		if _, err := os.Stat(filepath.Join(client.ConfigDir(), f)); err != nil {
			t.Error(err)
		}
	}
	if got := readEnvFile(filepath.Join(client.ConfigDir(), "env")); got["ATC_OPENCODE"] != "http://127.0.0.1:4096" {
		t.Fatal(got)
	}
}
