package modes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func reset(t *testing.T) {
	t.Cleanup(func() { Dir, User, Assistant = "", "", "" })
}

func TestNoPlaceholderIsLeft(t *testing.T) {
	reset(t)
	if strings.Contains(Rendered(), "{{") {
		t.Fatal("neutral names should fill in every placeholder")
	}
	User, Assistant = "Ada", "Bob"
	if r := Rendered(); strings.Contains(r, "{{") || strings.Contains(strings.NewReplacer("relays the user's own go-ahead", "", "the user, verified by atc", "").Replace(r), "the user") || !strings.Contains(r, "Ada") || !strings.Contains(r, "Bob") {
		t.Fatal("the names should reach the built-in text")
	}
}

func TestNeutralNames(t *testing.T) {
	reset(t)
	if got := Text("atc"); !strings.Contains(got, "The user is typing") {
		t.Fatalf("a sentence should start with a capital: %q", got)
	}
	if got := Line("call.no_answer"); !strings.Contains(got, "you called the user") {
		t.Fatal(got)
	}
}

func TestUsersOwnFilesAreNotTouched(t *testing.T) {
	reset(t)
	Dir, User = t.TempDir(), "Ada"
	os.WriteFile(filepath.Join(Dir, "atc.md"), []byte("Hello {{user}}, the user."), 0o644)
	os.WriteFile(filepath.Join(Dir, "lines.json"), []byte(`{"call.reason":"{{user}} mine"}`), 0o644)
	if got := Text("atc"); got != "Hello {{user}}, the user." {
		t.Fatal(got)
	}
	if got := Line("call.reason"); got != "{{user}} mine" {
		t.Fatal(got)
	}
	if got := Line("call.no_answer"); !strings.Contains(got, "you called Ada") {
		t.Fatal(got)
	}
}

func TestPercentInANameStaysOutOfFormats(t *testing.T) {
	reset(t)
	User = "100%s"
	if strings.Contains(Line("call.no_answer"), "100%s") {
		t.Fatal("this line is a format string")
	}
}
