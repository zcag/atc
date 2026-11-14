package pages

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
)

const projectPrefix = "+proj-"

// ProjectRoot is the repo a folder belongs to: the nearest folder up with a .git, and a worktree under
// .claude/worktrees counts as its main checkout, so every session on one repo shares one project.
func ProjectRoot(dir string) string {
	dir = filepath.Clean(dir)
	if main, _, ok := strings.Cut(dir, "/.claude/worktrees/"); ok {
		dir = main
	}
	for d := dir; ; d = filepath.Dir(d) {
		if exists(filepath.Join(d, ".git")) {
			return d
		}
		if d == filepath.Dir(d) {
			return dir
		}
	}
}

// ProjectOwner is the owner key a project's pages and state are kept under. It goes in URLs, so it
// is a slug of the folder's name plus a short hash of its path.
func ProjectOwner(root string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(root)))
	return projectPrefix + cmpOr(Slug(filepath.Base(root)), "root") + "-" + hex.EncodeToString(sum[:3])
}

func IsProject(owner string) bool { return strings.HasPrefix(owner, projectPrefix) }
