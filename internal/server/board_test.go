package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func boardServer(t *testing.T) (*httptest.Server, string) {
	bin := fakeClaude(t)
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	ps, _ := pages.Open(filepath.Join(t.TempDir(), "pages.json"))
	data := t.TempDir()
	ps.PinAt(filepath.Join(data, "pinned"))
	s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st},
		Term: &attach.Hub{Bin: bin}, Token: "tok", Host: "here", Pages: ps,
		Web: fstest.MapFS{"index.html": {Data: []byte("<!doctype html>atc")}}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	repo := t.TempDir()
	os.Mkdir(filepath.Join(repo, ".git"), 0o755)
	return ts, repo
}

func TestBoardAddsKeepEveryCard(t *testing.T) {
	ts, repo := boardServer(t)
	wt := filepath.Join(repo, ".claude", "worktrees", "x")
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			dir := repo
			if i%2 == 1 {
				dir = wt
			}
			body := fmt.Sprintf(`{"root":%q,"cards":[{"title":"card %d"}]}`, dir, i)
			if res, b := do(t, "POST", ts.URL+"/api/projects/board", "tok", body); res.StatusCode != 200 {
				t.Errorf("add: %d %s", res.StatusCode, b)
			}
		})
	}
	wg.Wait()
	owner := pages.ProjectOwner(repo)
	_, raw := get(t, ts.URL+"/api/sessions/"+owner+"/pages/board/state", "tok")
	var st struct {
		Board    struct{ Name string }
		Proposed []proposal
	}
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		t.Fatal(err, raw)
	}
	if len(st.Proposed) != 20 {
		t.Fatalf("a worktree and its repo share one board, and no add is lost: got %d cards", len(st.Proposed))
	}
	if st.Board.Name != filepath.Base(repo) || st.Proposed[0].Source != "agent" || st.Proposed[0].ID == "" {
		t.Fatalf("board %q, card %+v", st.Board.Name, st.Proposed[0])
	}
	_, list := get(t, ts.URL+"/api/sessions/"+owner+"/pages", "tok")
	if !strings.Contains(list, `"name":"board"`) {
		t.Fatalf("the project has no board page: %s", list)
	}
}

func TestSessionsInTheRepoShowItsPages(t *testing.T) {
	ps, _ := pages.Open("")
	data := t.TempDir()
	ps.PinAt(filepath.Join(data, "pinned"))
	repo := t.TempDir()
	os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	os.MkdirAll(filepath.Join(repo, "web"), 0o755)
	if _, err := ps.Board(pages.ProjectOwner(repo), "repo"); err != nil {
		t.Fatal(err)
	}
	st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
	s := &Server{M: &sessions.Manager{Index: history.New(t.TempDir()), Store: st}, Pages: ps}
	list := []sessions.Session{
		{SessionID: "11111111-0000-0000-0000-000000000000", Cwd: filepath.Join(repo, "web")},
		{SessionID: "22222222-0000-0000-0000-000000000000", Cwd: filepath.Join(repo, ".claude", "worktrees", "x")},
		{SessionID: "33333333-0000-0000-0000-000000000000", Cwd: t.TempDir()},
	}
	s.attachPages(list)
	for i, want := range []int{1, 1, 0} {
		if len(list[i].Shown) != want {
			t.Errorf("session in %s shows %d pages, want %d", list[i].Cwd, len(list[i].Shown), want)
		}
	}
	_, alerts := pageAlerts(map[string]time.Time{}, list, func(sessions.Session) bool { return false })
	if len(alerts) != 1 {
		t.Errorf("one project page shown on two sessions pushed %d times", len(alerts))
	}
}

func TestBoardKeepsPicturesBesideIt(t *testing.T) {
	ts, repo := boardServer(t)
	pic := filepath.Join(t.TempDir(), "lamp.png")
	os.WriteFile(pic, []byte("png"), 0o644)
	body := fmt.Sprintf(`{"root":%q,"cards":[{"title":"lamp","img":%q}]}`, repo, pic)
	if res, b := do(t, "POST", ts.URL+"/api/projects/board", "tok", body); res.StatusCode != 200 {
		t.Fatalf("add: %d %s", res.StatusCode, b)
	}
	secret := filepath.Join(t.TempDir(), "id_ed25519")
	os.WriteFile(secret, []byte("key"), 0o600)
	body = fmt.Sprintf(`{"root":%q,"cards":[{"title":"key","img":%q}]}`, repo, secret)
	if res, _ := do(t, "POST", ts.URL+"/api/projects/board", "tok", body); res.StatusCode != 400 {
		t.Fatalf("a file that is not a picture was copied next to a served page: %d", res.StatusCode)
	}
	_, raw := get(t, ts.URL+"/api/sessions/"+pages.ProjectOwner(repo)+"/pages/board/state", "tok")
	var st struct{ Proposed []proposal }
	json.Unmarshal([]byte(raw), &st)
	if len(st.Proposed) != 1 || !strings.HasPrefix(st.Proposed[0].Img, "img/") {
		t.Fatalf("cards: %+v", st.Proposed)
	}
}
