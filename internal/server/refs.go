package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/outputs"
)

const mostCommitBytes = 600 << 10

var (
	shaRef      = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
	rangeRef    = regexp.MustCompile(`^[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}$`)
	issueRepo   = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
	issueNumber = regexp.MustCompile(`^[0-9]{1,7}$`)
	githubRepo  = regexp.MustCompile(`^(?:git@github\.com:|ssh://git@github\.com/|https?://(?:[^@/]+@)?github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?/?$`)
)

func gitIn(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, stop := context.WithTimeout(ctx, 10*time.Second)
	defer stop()
	out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
	return string(out), err
}

// sessionRoots are the folders a session's relative references can mean: where it is now, where it started, and the
// top of the repo each is in. A folder a removed worktree left behind is not one.
func (s *Server) sessionRoots(ctx context.Context, sid string) []string {
	t, ok := s.M.Index.Find(sid)
	if !ok {
		return nil
	}
	var roots []string
	add := func(dir string) {
		if dir == "" {
			return
		}
		for _, r := range roots {
			if r == dir {
				return
			}
		}
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			roots = append(roots, dir)
		}
	}
	for _, dir := range []string{t.Cwd, t.StartCwd} {
		add(dir)
		if top, err := gitIn(ctx, dir, "rev-parse", "--show-toplevel"); dir != "" && err == nil {
			add(strings.TrimSpace(top))
		}
	}
	return roots
}

func regularFile(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}

// findFile turns what an agent wrote into a file: an absolute or ~ path, a path from one of the roots, or the one file
// git knows by that ending, since agents often leave off the leading folders.
func findFile(ctx context.Context, ref string, roots []string, home string) string {
	if rest, ok := strings.CutPrefix(ref, "~/"); ok {
		ref = filepath.Join(home, rest)
	}
	if filepath.IsAbs(ref) {
		if regularFile(ref) {
			return filepath.Clean(ref)
		}
		return ""
	}
	for _, root := range roots {
		if p := filepath.Join(root, ref); regularFile(p) {
			return p
		}
	}
	if strings.ContainsAny(ref, "*?[]:") {
		return ""
	}
	for _, root := range roots {
		out, err := gitIn(ctx, root, "ls-files", "--", ":(glob)**/"+strings.TrimPrefix(ref, "./"))
		if lines := strings.Fields(out); err == nil && len(lines) == 1 {
			return filepath.Join(root, lines[0])
		}
	}
	return ""
}

func inside(dir, path string) bool {
	return strings.HasPrefix(path, strings.TrimSuffix(dir, "/")+"/")
}

func hiddenSegment(segs []string, allowed func(string) bool) bool {
	for _, seg := range segs {
		if strings.HasPrefix(seg, ".") && !allowed(seg) {
			return true
		}
	}
	return false
}

// mayOpen is what a reference may reach, since opening it hands out a link that needs no login. In a project (not the
// home folder itself) that is any file but .git and hidden ones; elsewhere in home or in the temp folder, nothing
// under a hidden folder either, which is where keys and tokens live.
func mayOpen(path string, roots []string, home string) bool {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	if strings.HasPrefix(filepath.Base(real), ".") {
		return false
	}
	realHome := home
	if r, err := filepath.EvalSymlinks(home); err == nil {
		realHome = r
	}
	for _, root := range roots {
		r, err := filepath.EvalSymlinks(root)
		if err != nil || r == realHome || inside(r, realHome) || !inside(r, real) {
			continue
		}
		rel, _ := filepath.Rel(r, real)
		return !hiddenSegment(strings.Split(rel, "/"), func(seg string) bool { return seg != ".git" })
	}
	for _, base := range []string{realHome, os.TempDir()} {
		if r, err := filepath.EvalSymlinks(base); err == nil && inside(r, real) {
			rel, _ := filepath.Rel(r, real)
			return !hiddenSegment(strings.Split(rel, "/"), func(string) bool { return false })
		}
	}
	return false
}

func (s *Server) refFile(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	home, _ := os.UserHomeDir()
	roots := s.sessionRoots(r.Context(), sid)
	path := findFile(r.Context(), r.URL.Query().Get("path"), roots, home)
	if path == "" {
		http.Error(w, "That file isn't there any more, or isn't in this session's folder.", http.StatusNotFound)
		return
	}
	if !mayOpen(path, roots, home) {
		http.Error(w, "atc doesn't open files outside the project, or hidden ones.", http.StatusForbidden)
		return
	}
	st, err := os.Stat(path)
	if err != nil {
		fail(w, err)
		return
	}
	scope, kind := path, outputs.Kind(path)
	if kind == "html" {
		scope = linkScope(path)
	}
	reply(w, map[string]any{"path": path, "kind": kind, "size": st.Size(), "url": s.signedURL(sid, scope, path, time.Now().Add(12*time.Hour).Unix())})
}

type commit struct {
	SHA       string `json:"sha"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	Patch     string `json:"patch"`
	Truncated bool   `json:"truncated,omitempty"`
}

func commitIn(ctx context.Context, root, sha string) (commit, bool) {
	out, err := gitIn(ctx, root, "show", "--no-color", "--no-ext-diff", "--format=%H%x00%an%x00%aI%x00%s%x00%b%x00", sha+"^{commit}")
	if err != nil {
		return commit{}, false
	}
	p := strings.SplitN(out, "\x00", 6)
	if len(p) != 6 {
		return commit{}, false
	}
	c := commit{SHA: p[0], Author: p[1], Date: p[2], Subject: p[3], Body: strings.TrimSpace(p[4]), Patch: strings.TrimLeft(p[5], "\n")}
	if len(c.Patch) > mostCommitBytes {
		c.Patch, c.Truncated = c.Patch[:strings.LastIndexByte(c.Patch[:mostCommitBytes], '\n')+1], true
	}
	return c, true
}

func (s *Server) refCommit(w http.ResponseWriter, r *http.Request) {
	sha := r.URL.Query().Get("sha")
	if !shaRef.MatchString(sha) {
		http.Error(w, "not a commit", http.StatusBadRequest)
		return
	}
	for _, root := range s.sessionRoots(r.Context(), r.PathValue("sid")) {
		if c, ok := commitIn(r.Context(), root, sha); ok {
			reply(w, c)
			return
		}
	}
	http.Error(w, "This session's repo doesn't have that commit.", http.StatusNotFound)
}

type rangeCommit struct {
	SHA     string `json:"sha"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
}

type commitRange struct {
	Commits   []rangeCommit `json:"commits"`
	Patch     string        `json:"patch"`
	Truncated bool          `json:"truncated,omitempty"`
}

// rangeIn reads what a push moved a branch across. A force push's old and new share no straight line, so the list is what
// is new and the diff is end to end.
func rangeIn(ctx context.Context, root, r string) (commitRange, bool) {
	from, to, _ := strings.Cut(strings.Replace(r, "...", "..", 1), "..")
	out, err := gitIn(ctx, root, "log", "--max-count=100", "--format=%h%x00%an%x00%aI%x00%s", from+".."+to)
	if err != nil {
		return commitRange{}, false
	}
	c := commitRange{Commits: []rangeCommit{}}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if p := strings.SplitN(line, "\x00", 4); len(p) == 4 {
			c.Commits = append(c.Commits, rangeCommit{p[0], p[1], p[2], p[3]})
		}
	}
	if c.Patch, err = gitIn(ctx, root, "diff", "--no-color", "--no-ext-diff", from, to); err != nil {
		return commitRange{}, false
	}
	if len(c.Patch) > mostCommitBytes {
		c.Patch, c.Truncated = c.Patch[:strings.LastIndexByte(c.Patch[:mostCommitBytes], '\n')+1], true
	}
	return c, true
}

func (s *Server) refRange(w http.ResponseWriter, r *http.Request) {
	span := r.URL.Query().Get("range")
	if !rangeRef.MatchString(span) {
		http.Error(w, "not a range", http.StatusBadRequest)
		return
	}
	for _, root := range s.sessionRoots(r.Context(), r.PathValue("sid")) {
		if c, ok := rangeIn(r.Context(), root, span); ok {
			reply(w, c)
			return
		}
	}
	http.Error(w, "This session's repo doesn't have those commits.", http.StatusNotFound)
}

type issueInfo struct {
	Title string `json:"title"`
	State string `json:"state"`
	Kind  string `json:"kind"`
}

type issueHit struct {
	info issueInfo
	ok   bool
	at   time.Time
}

var (
	issueCache   = map[string]issueHit{}
	issueCacheMu sync.Mutex
)

func parseIssue(b []byte) (issueInfo, bool) {
	var x struct {
		Title string `json:"title"`
		State string `json:"state"`
		Draft bool   `json:"draft"`
		PR    *struct {
			MergedAt *string `json:"merged_at"`
		} `json:"pull_request"`
	}
	if json.Unmarshal(b, &x) != nil || x.Title == "" {
		return issueInfo{}, false
	}
	info := issueInfo{Title: x.Title, State: x.State, Kind: "issue"}
	if x.PR != nil {
		info.Kind = "pr"
		if x.PR.MergedAt != nil {
			info.State = "merged"
		} else if x.Draft && x.State == "open" {
			info.State = "draft"
		}
	}
	return info, true
}

// issueOf asks gh once per few minutes. A failure is remembered too, so hovering a list of references to a repo gh can't
// see doesn't start a process for each.
func issueOf(ctx context.Context, repo, n string) (issueInfo, bool) {
	key := repo + "#" + n
	issueCacheMu.Lock()
	hit, have := issueCache[key]
	issueCacheMu.Unlock()
	if have && time.Since(hit.at) < 5*time.Minute {
		return hit.info, hit.ok
	}
	ctx, stop := context.WithTimeout(ctx, 8*time.Second)
	defer stop()
	out, err := exec.CommandContext(ctx, "gh", "api", "repos/"+repo+"/issues/"+n).Output()
	hit = issueHit{at: time.Now()}
	if err == nil {
		hit.info, hit.ok = parseIssue(out)
	}
	issueCacheMu.Lock()
	if len(issueCache) > 2000 {
		clear(issueCache)
	}
	issueCache[key] = hit
	issueCacheMu.Unlock()
	return hit.info, hit.ok
}

func (s *Server) refIssue(w http.ResponseWriter, r *http.Request) {
	repo, n := r.URL.Query().Get("repo"), r.URL.Query().Get("n")
	if !issueRepo.MatchString(repo) || strings.Contains(repo, "..") || !issueNumber.MatchString(n) {
		http.Error(w, "not an issue", http.StatusBadRequest)
		return
	}
	info, ok := issueOf(r.Context(), repo, n)
	if !ok {
		http.Error(w, "gh can't read that issue", http.StatusNotFound)
		return
	}
	reply(w, info)
}

func repoURL(remote string) string {
	if m := githubRepo.FindStringSubmatch(strings.TrimSpace(remote)); m != nil {
		return "https://github.com/" + m[1]
	}
	return ""
}

func (s *Server) refRepo(w http.ResponseWriter, r *http.Request) {
	for _, root := range s.sessionRoots(r.Context(), r.PathValue("sid")) {
		if out, err := gitIn(r.Context(), root, "remote", "get-url", "origin"); err == nil {
			reply(w, map[string]string{"repo": repoURL(out)})
			return
		}
	}
	reply(w, map[string]string{"repo": ""})
}
