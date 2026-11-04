package settings

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func write(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func unset(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
}

func TestAbsentFileChangesNothing(t *testing.T) {
	before := os.Environ()
	s, err := Apply(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(before, os.Environ()) {
		t.Fatal("the environment changed without a settings.json")
	}
	f, _ := s.Load()
	if p := s.Pending(f); len(p) != 0 || s.IdentityChanged(f) {
		t.Fatalf("nothing should be pending: %v", p)
	}
}

func TestEnvironmentWins(t *testing.T) {
	unset(t, "ATC_A_FILE_ONLY", LanguageKey)
	t.Setenv("ATC_A_BOTH", "from env")
	t.Setenv("ATC_A_EMPTY", "")
	dir := t.TempDir()
	write(t, dir, `{"language":"tr","env":{"ATC_A_FILE_ONLY":"file","ATC_A_BOTH":"file","ATC_A_EMPTY":"file","PATH":"/evil"}}`)
	path := os.Getenv("PATH")
	s, err := Apply(dir)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := s.Load()
	for k, want := range map[string]string{"ATC_A_FILE_ONLY": "file", "ATC_A_BOTH": "from env", "ATC_A_EMPTY": "", "PATH": path, LanguageKey: "tr"} {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if s.Source(f, "ATC_A_BOTH") != "env" || s.Source(f, "ATC_A_FILE_ONLY") != "settings" || s.Source(f, "ATC_A_NOPE") != "" {
		t.Fatalf("sources: %q %q", s.Source(f, "ATC_A_BOTH"), s.Source(f, "ATC_A_FILE_ONLY"))
	}
}

func TestPendingFollowsTheFile(t *testing.T) {
	unset(t, "ATC_B_KEPT", "ATC_B_NEW", "ATC_B_GONE")
	t.Setenv("ATC_B_ENV", "env")
	dir := t.TempDir()
	write(t, dir, `{"env":{"ATC_B_KEPT":"1","ATC_B_GONE":"1"}}`)
	s, _ := Apply(dir)
	f, _ := s.Load()
	if p := s.Pending(f); len(p) != 0 {
		t.Fatalf("fresh start, pending %v", p)
	}
	delete(f.Env, "ATC_B_GONE")
	f.Env["ATC_B_NEW"], f.Env["ATC_B_ENV"] = "2", "ignored"
	f.User = "Ada"
	if err := s.Save(f); err != nil {
		t.Fatal(err)
	}
	g, _ := s.Load()
	if p := s.Pending(g); !slices.Equal(p, []string{"ATC_B_GONE", "ATC_B_NEW"}) {
		t.Fatalf("pending %v", p)
	}
	if !s.IdentityChanged(g) {
		t.Fatal("the name changed")
	}
	if s.Value(g, "ATC_B_NEW") != "2" || s.Value(g, "ATC_B_ENV") != "env" || s.Value(g, "ATC_B_GONE") != "" {
		t.Fatal("Value should read what a restart would see")
	}
	if st, _ := os.Stat(s.Path()); st.Mode().Perm() != 0o600 {
		t.Fatalf("settings.json holds secrets, mode %v", st.Mode())
	}
}

func TestBrokenFileIsReportedAndIgnored(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, `{not json`)
	if _, err := Apply(dir); err == nil {
		t.Fatal("a broken file should be reported")
	}
}

func TestEnvFile(t *testing.T) {
	unset(t, "ATC_C_A", "ATC_C_B")
	t.Setenv("ATC_C_SET", "kept")
	p := filepath.Join(t.TempDir(), "env")
	os.WriteFile(p, []byte("# note\nATC_C_A=1\n\nATC_C_B=\"two words\"\nATC_C_SET=no\n"), 0o600)
	EnvFile(p)
	if os.Getenv("ATC_C_A") != "1" || os.Getenv("ATC_C_B") != "two words" || os.Getenv("ATC_C_SET") != "kept" {
		t.Fatalf("%q %q %q", os.Getenv("ATC_C_A"), os.Getenv("ATC_C_B"), os.Getenv("ATC_C_SET"))
	}
}
