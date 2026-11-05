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

func TestNoAnswerIsNotAYes(t *testing.T) {
	a := asker{bufio.NewReader(strings.NewReader("")), false}
	if a.confirm("q") {
		t.Fatal("finished input must not accept anything")
	}
	if got := a.text("q", "old"); got != "old" {
		t.Fatal(got)
	}
	if !(asker{bufio.NewReader(strings.NewReader("\n")), false}).confirm("q") {
		t.Fatal("a pressed Enter is the default yes")
	}
}

func TestClaudeBinFindsTheInstallersFolder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ATC_CLAUDE_BIN", "")
	t.Setenv("PATH", t.TempDir())
	if _, found := claudeBin(); found {
		t.Fatal("found a claude that isn't there")
	}
	local := filepath.Join(home, ".local", "bin", "claude")
	os.MkdirAll(filepath.Dir(local), 0o755)
	os.WriteFile(local, []byte("#!/bin/sh\n"), 0o755)
	if bin, found := claudeBin(); !found || bin != local {
		t.Fatal(bin, found)
	}
	if localBinOnPath() {
		t.Fatal("that folder isn't on PATH")
	}
	t.Setenv("PATH", filepath.Dir(local))
	if !localBinOnPath() {
		t.Fatal("that folder is on PATH")
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
