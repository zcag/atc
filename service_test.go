package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteEnvDefaultsKeepsWhatIsThere(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ATC_CONFIG_DIR", dir)
	t.Setenv("PATH", "")
	path := filepath.Join(dir, "env")
	if err := writeEnvDefaults(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != "ATC_HUB=http://127.0.0.1:8820\n" {
		t.Fatalf("new file: %q", b)
	}
	os.WriteFile(path, []byte("ATC_HUB=http://elsewhere:1\nATC_ADDR=:7272"), 0o600)
	if err := writeEnvDefaults(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); !strings.HasPrefix(string(b), "ATC_HUB=http://elsewhere:1\nATC_ADDR=:7272") || strings.Count(string(b), "ATC_HUB=") != 1 {
		t.Fatalf("kept file: %q", b)
	}
}

func TestEveryUnitIsEmbedded(t *testing.T) {
	for _, s := range services("") {
		if _, err := units.ReadFile("deploy/" + s.unit + ".service"); err != nil {
			t.Fatal(err)
		}
	}
	if got := services("hub"); len(got) != 1 || got[0].bin != "atc-hub" {
		t.Fatalf("%v", got)
	}
}

func TestEnvFileValue(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ATC_CONFIG_DIR", dir)
	os.WriteFile(filepath.Join(dir, "env"), []byte("A=1\nATC_DELTA_CALL=\"http://x:1\"\n"), 0o600)
	if got := envFileValue("ATC_DELTA_CALL"); got != "http://x:1" {
		t.Fatal(got)
	}
}
