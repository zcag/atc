package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupStatusLine(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	path := filepath.Join(dir, "settings.json")
	yes := asker{bufio.NewReader(strings.NewReader("")), true}

	os.WriteFile(path, []byte(`{"theme":"dark"}`), 0o600)
	if err := setupStatusLine(yes); err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	b, _ := os.ReadFile(path)
	json.Unmarshal(b, &cfg)
	if cfg["theme"] != "dark" || cfg["statusLine"].(map[string]any)["command"] != "atc limits -tap" {
		t.Fatalf("%s", b)
	}

	own := `{"statusLine":{"type":"command","command":"mine.sh"}}`
	os.WriteFile(path, []byte(own), 0o600)
	if err := setupStatusLine(yes); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != own {
		t.Fatalf("someone's own status line changed: %s", b)
	}

	os.WriteFile(path, []byte(`{broken`), 0o600)
	if err := setupStatusLine(yes); err == nil {
		t.Fatal("a file it can't read must not be overwritten")
	}
}

func TestAskerKeepsTheDefault(t *testing.T) {
	a := asker{bufio.NewReader(strings.NewReader("\nnew\nn\n")), false}
	if got := a.text("q", "old"); got != "old" {
		t.Fatal(got)
	}
	if got := a.text("q", "old"); got != "new" {
		t.Fatal(got)
	}
	if a.confirm("q") {
		t.Fatal("n is no")
	}
}
