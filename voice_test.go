package main

import (
	"bytes"
	"encoding/xml"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/settings"
)

func TestInstallLanguageIsTheUsersWhenThereIsAPack(t *testing.T) {
	for setting, want := range map[string]string{"": "en", "tr": "tr", " TR ": "tr", "de": "en", "../en": "en"} {
		t.Setenv(settings.LanguageKey, setting)
		if got := installLanguage(); got != want {
			t.Errorf("%q: got %q, want %q", setting, got, want)
		}
	}
}

func TestSetEnvFileKeepsOtherLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "voice.env")
	os.WriteFile(p, []byte("# mine\nTALK_LANG=tr\nKEEP=1\n"), 0o644)
	changed, err := setEnvFile(p, map[string]string{"TALK_LANG": "en", "UNITS": "a b"})
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	b, _ := os.ReadFile(p)
	if got := string(b); got != "# mine\nTALK_LANG=en\nKEEP=1\nUNITS=\"a b\"\n" {
		t.Fatalf("%q", got)
	}
	if env := readEnvFile(p); env["UNITS"] != "a b" || env["KEEP"] != "1" {
		t.Fatal(env)
	}
	if changed, _ := setEnvFile(p, map[string]string{"TALK_LANG": "en"}); changed {
		t.Fatal("same value reported as a change")
	}
}

func TestWriteVoiceFilesIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	changed, err := writeVoiceFiles(dir)
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	for _, f := range []string{"talk.py", "call.py", "ttsd.py", "fetch.py", "langpack.py", "deploy.sh", "lang/en.json", "lang/tr.json", "device/callbridge.dex", "systemd/delta-call.service"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Error(err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "test")); err == nil {
		t.Error("the tests were installed")
	}
	if st, _ := os.Stat(filepath.Join(dir, "talk.py")); st.Mode()&0o100 == 0 {
		t.Error("talk.py is not executable")
	}
	if changed, err := writeVoiceFiles(dir); err != nil || changed {
		t.Fatal(changed, err)
	}
}

func TestUnitCommandRunsTheUnit(t *testing.T) {
	home := t.TempDir()
	env := filepath.Join(home, "voice.env")
	if err := os.WriteFile(env, []byte("B=\"from file\"\nC=\"split me\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	unit := "[Service]\nEnvironment=A=%h/a b\nEnvironment=B=default\nEnvironment=PATH=/nowhere\nEnvironmentFile=-" + env + "\nEnvironmentFile=-%h/none\n" +
		"ExecStart=/bin/sh -c 'for w; do echo \"$$w\"; done' x ${A} ${B} $C \"$$HOME\"\n"
	out, err := exec.Command("sh", "-c", unitCommand(unit, home)).CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	want := home + "/a b\nfrom file\nsplit\nme\n" + home + "\n"
	if string(out) != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestVoicePlists(t *testing.T) {
	tpl, err := units.ReadFile("deploy/atc.plist")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := voiceFiles.ReadDir("voice/systemd")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name, isUnit := strings.CutSuffix(e.Name(), ".service")
		if !isUnit {
			continue
		}
		unit, _ := voiceFiles.ReadFile("voice/systemd/" + e.Name())
		command := unitCommand(string(unit), "/home/you")
		if !strings.Contains(command, "exec ") || strings.Contains(command, "%h") || strings.Contains(command, "$$") {
			t.Fatalf("%s: %s", name, command)
		}
		if out, err := exec.Command("sh", "-n", "-c", command).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v: %s", name, err, out)
		}
		s := service{name: name, bin: name, unit: name}
		plist := voicePlist(tpl, s, command)
		if err := xml.Unmarshal(plist, new(struct{})); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, want := range []string{"<string>" + macName(s) + "</string>", "<key>ProcessType</key>", "/tmp/" + name + ".log", "<key>StandardOutPath</key>", "&amp;&amp;"} {
			if !bytes.Contains(plist, []byte(want)) {
				t.Fatalf("%s has no %s:\n%s", name, want, plist)
			}
		}
		if bytes.Contains(plist, []byte("AbandonProcessGroup")) {
			t.Fatalf("%s keeps its children past a stop", name)
		}
	}
}

func TestEnginesPerMachine(t *testing.T) {
	if defaultEngine("en", "darwin", "arm64") != "pocket-en" || defaultEngine("en", "linux", "amd64") != "pocket-en" || defaultEngine("en", "darwin", "amd64") != "piper" || defaultEngine("tr", "linux", "amd64") != "pocket" {
		t.Fatal("default engine")
	}
	for _, c := range []struct {
		engines, goos, goarch string
		ok                    bool
	}{
		{"pocket-en", "darwin", "arm64", true}, {"pocket-en,pocket,kokoro,piper", "darwin", "arm64", true}, {"higgs", "linux", "amd64", true},
		{"piper", "darwin", "amd64", true}, {"kokoro", "darwin", "amd64", true}, {"pocket-en", "darwin", "amd64", false},
		{"piper,pocket", "darwin", "amd64", false},
	} {
		if err := engineRuns(c.engines, c.goos, c.goarch); (err == nil) != c.ok {
			t.Errorf("%s on %s/%s: %v", c.engines, c.goos, c.goarch, err)
		}
	}
}
