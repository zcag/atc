package pages

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectRoot(t *testing.T) {
	repo := t.TempDir()
	os.Mkdir(filepath.Join(repo, ".git"), 0o755)
	deep := filepath.Join(repo, "web", "x")
	os.MkdirAll(deep, 0o755)
	for _, dir := range []string{repo, deep, filepath.Join(repo, ".claude", "worktrees", "feature", "web")} {
		if got := ProjectRoot(dir); got != repo {
			t.Errorf("%s: root %s, want %s", dir, got, repo)
		}
	}
	if o := ProjectOwner(repo); !IsProject(o) || o != ProjectOwner(repo+"/") || o == ProjectOwner(deep) {
		t.Errorf("owner %q", o)
	}
}
