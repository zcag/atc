package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, body string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	repo := filepath.Join(dir, "home", "proj", "app")
	write(t, filepath.Join(repo, "src", "store", "cache.go"), "package store\n")
	write(t, filepath.Join(repo, "README.md"), "# app\n")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=A", "-c", "user.email=a@example.com"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	run("init", "-q")
	run("add", ".")
	run("commit", "-qm", "First\n\nThe body.")
	return repo
}

func TestFindFile(t *testing.T) {
	repo := gitRepo(t)
	home := filepath.Dir(filepath.Dir(repo))
	roots := []string{repo}
	ctx := context.Background()
	want := filepath.Join(repo, "src", "store", "cache.go")
	for _, ref := range []string{"src/store/cache.go", "./src/store/cache.go", "store/cache.go", "cache.go", want, "~/proj/app/src/store/cache.go"} {
		if got := findFile(ctx, ref, roots, home); got != want {
			t.Errorf("%q found %q", ref, got)
		}
	}
	for _, ref := range []string{"nope.go", "*.go", "/nope/cache.go", "src/store"} {
		if got := findFile(ctx, ref, roots, home); got != "" {
			t.Errorf("%q should find nothing, found %q", ref, got)
		}
	}
}

func TestFindFileAmbiguousEnding(t *testing.T) {
	repo := gitRepo(t)
	write(t, filepath.Join(repo, "other", "cache.go"), "package other\n")
	cmd := exec.Command("git", "-C", repo, "add", ".")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if got := findFile(context.Background(), "cache.go", []string{repo}, filepath.Dir(repo)); got != "" {
		t.Errorf("two files end like that, found %q", got)
	}
}

func TestMayOpen(t *testing.T) {
	repo := gitRepo(t)
	home := filepath.Dir(filepath.Dir(repo))
	roots := []string{repo}
	key := write(t, filepath.Join(home, ".ssh", "id_rsa"), "secret")
	link := filepath.Join(repo, "innocent.txt")
	if err := os.Symlink(key, link); err != nil {
		t.Fatal(err)
	}
	gitConfig := filepath.Join(repo, ".git", "config")
	cases := []struct {
		path  string
		roots []string
		want  bool
	}{
		{filepath.Join(repo, "README.md"), roots, true},
		{write(t, filepath.Join(repo, ".github", "ci.yml"), "x"), roots, true},
		{write(t, filepath.Join(home, "notes", "a.txt"), "x"), roots, true},
		{gitConfig, roots, false},
		{write(t, filepath.Join(repo, ".env"), "x"), roots, false},
		{key, roots, false},
		{link, roots, false},
		{key, []string{home}, false},
		{filepath.Join(repo, "README.md"), []string{home}, true},
		{"/etc/hostname", roots, false},
	}
	for _, c := range cases {
		if got := mayOpen(c.path, c.roots, home); got != c.want {
			t.Errorf("mayOpen(%s, %v) = %v", c.path, c.roots, got)
		}
	}
}

func TestCommitIn(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	head, err := gitIn(ctx, repo, "rev-parse", "--short=10", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	c, ok := commitIn(ctx, repo, strings.TrimSpace(head))
	if !ok || c.Subject != "First" || c.Body != "The body." || c.Author != "A" {
		t.Fatalf("%+v %v", c, ok)
	}
	if !strings.HasPrefix(c.Patch, "diff --git") || !strings.Contains(c.Patch, "+package store") {
		t.Errorf("patch %q", c.Patch)
	}
	if _, ok := commitIn(ctx, repo, "deadbeef00"); ok {
		t.Error("an unknown commit was found")
	}
}

func TestRepoURL(t *testing.T) {
	for remote, want := range map[string]string{
		"git@github.com:o/r.git\n":            "https://github.com/o/r",
		"https://github.com/o/r":              "https://github.com/o/r",
		"https://github.com/o/r.git":          "https://github.com/o/r",
		"https://token@github.com/o/r.js.git": "https://github.com/o/r.js",
		"ssh://git@github.com/o/r.git":        "https://github.com/o/r",
		"git@gitlab.com:o/r.git":              "",
		"https://github.com.evil.io/o/r":      "",
	} {
		if got := repoURL(remote); got != want {
			t.Errorf("%q gave %q", remote, got)
		}
	}
}

func TestRangeIn(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	from, _ := gitIn(ctx, repo, "rev-parse", "--short=10", "HEAD")
	write(t, filepath.Join(repo, "b.txt"), "b\n")
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=A", "-c", "user.email=a@example.com", "commit", "-qm", "Second"}} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("%s", out)
		}
	}
	to, _ := gitIn(ctx, repo, "rev-parse", "--short=10", "HEAD")
	span := strings.TrimSpace(from) + ".." + strings.TrimSpace(to)
	for _, r := range []string{span, strings.Replace(span, "..", "...", 1)} {
		c, ok := rangeIn(ctx, repo, r)
		if !ok || len(c.Commits) != 1 || c.Commits[0].Subject != "Second" || !strings.Contains(c.Patch, "+b") {
			t.Errorf("%s: %+v %v", r, c, ok)
		}
	}
	if _, ok := rangeIn(ctx, repo, "deadbeef00..deadbeef01"); ok {
		t.Error("an unknown range was found")
	}
}

func TestParseIssue(t *testing.T) {
	for body, want := range map[string]issueInfo{
		`{"title":"T","state":"open"}`:                                                       {"T", "open", "issue"},
		`{"title":"T","state":"closed"}`:                                                     {"T", "closed", "issue"},
		`{"title":"T","state":"open","pull_request":{"merged_at":null}}`:                     {"T", "open", "pr"},
		`{"title":"T","state":"open","draft":true,"pull_request":{"merged_at":null}}`:        {"T", "draft", "pr"},
		`{"title":"T","state":"closed","pull_request":{"merged_at":"2026-01-01T00:00:00Z"}}`: {"T", "merged", "pr"},
		`{"title":"T","state":"closed","pull_request":{"merged_at":null}}`:                   {"T", "closed", "pr"},
	} {
		if got, ok := parseIssue([]byte(body)); !ok || got != want {
			t.Errorf("%s gave %+v", body, got)
		}
	}
	if _, ok := parseIssue([]byte(`{"message":"Not Found"}`)); ok {
		t.Error("an error body parsed")
	}
}
