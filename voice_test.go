package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

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

// What a stranger installs must carry none of one person's setup; their values live in ~/.config/atc/voice.env.
func TestVoiceHasNoPersonalDefaults(t *testing.T) {
	personal := regexp.MustCompile(`100\.64\.0|15550100|555 01|DEVICE-SERIAL|/home/user|srv/call|voice_a|voice_b|the city`)
	fs.WalkDir(voiceFiles, "voice", func(p string, d fs.DirEntry, err error) error {
		if d.IsDir() && p == "voice/test" {
			return fs.SkipDir
		}
		if d.IsDir() || strings.HasSuffix(p, ".dex") {
			return nil
		}
		b, _ := voiceFiles.ReadFile(p)
		if m := personal.Find(b); m != nil {
			t.Errorf("%s has %q", p, m)
		}
		return nil
	})
}
