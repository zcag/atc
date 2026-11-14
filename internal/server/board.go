package server

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/pages"
)

// A project's board keeps what agents add apart from what the page writes: agents append to
// "proposed" here, under the store's lock, and the page folds new ones into its own "cards". Neither
// side ever rewrites the other's key, so a vote and an agent's card cannot overwrite each other.
type proposal struct {
	ID     string    `json:"id"`
	Title  string    `json:"title"`
	Note   string    `json:"note,omitempty"`
	Body   string    `json:"body,omitempty"`
	URL    string    `json:"url,omitempty"`
	Img    string    `json:"img,omitempty"`
	Source string    `json:"source"`
	Author string    `json:"author,omitempty"`
	At     time.Time `json:"created_at"`
}

func (s *Server) boardAdd(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Root    string
		Session string
		Cards   []proposal
	}
	if !decodeOr400(w, r, &req, "{root, session, cards: [{title, note, body, url, img}]}", func() bool {
		return filepath.IsAbs(req.Root) && len(req.Cards) > 0
	}) {
		return
	}
	root := pages.ProjectRoot(req.Root)
	owner := pages.ProjectOwner(root)
	p, err := s.Pages.Board(owner, filepath.Base(root))
	if err != nil {
		fail(w, err)
		return
	}
	who := s.author(req.Session)
	for i := range req.Cards {
		c := &req.Cards[i]
		if c.Title = strings.TrimSpace(c.Title); c.Title == "" {
			http.Error(w, "every card needs a title", http.StatusBadRequest)
			return
		}
		c.ID, c.Source, c.At = newID(), "agent", time.Now()
		c.Author = cmp.Or(c.Author, who)
		if filepath.IsAbs(c.Img) {
			if c.Img, err = keepImage(filepath.Dir(p.Path), c.ID, c.Img); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
	}
	err = s.Pages.Update(owner, pages.BoardName, func(old json.RawMessage) (json.RawMessage, error) {
		cur := map[string]json.RawMessage{}
		if len(old) > 0 && json.Unmarshal(old, &cur) != nil {
			return nil, errors.New("the board's state is not an object")
		}
		var list []json.RawMessage
		json.Unmarshal(cur["proposed"], &list)
		for _, c := range req.Cards {
			b, _ := json.Marshal(c)
			list = append(list, b)
		}
		cur["proposed"], _ = json.Marshal(list)
		return json.Marshal(cur)
	})
	if errors.Is(err, pages.ErrTooBig) {
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	s.refresh()
	ids := make([]string, len(req.Cards))
	for i, c := range req.Cards {
		ids[i] = c.ID
	}
	reply(w, map[string]any{"owner": owner, "root": root, "ids": ids, "link": s.PublicURL + s.aloneLink(owner, p.Name)})
}

// author is how a card says who added it: the agent's name, else the session's title.
func (s *Server) author(sid string) string {
	if sid == "" {
		return ""
	}
	sid = s.fullID(sid)
	if a := s.M.Store.Get(sid).Agent; a != "" {
		return agentRef + a
	}
	return s.M.Briefs(map[string]bool{sid: true})[sid].Title
}

// keepImage copies a card's picture next to the board, which is the only folder the page can load
// files from, and gives the path relative to it.
func keepImage(dir, id, src string) (string, error) {
	ext := strings.ToLower(filepath.Ext(src))
	if !slices.Contains([]string{".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".avif"}, ext) {
		return "", errors.New(src + " is not a picture")
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return "", err
	}
	rel := filepath.Join("img", id+ext)
	if err := os.MkdirAll(filepath.Join(dir, "img"), 0o755); err != nil {
		return "", err
	}
	return rel, os.WriteFile(filepath.Join(dir, rel), b, 0o644)
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

var projectOf sync.Map

// projectPages are the pages of the project a folder is in, which every session working there shows.
func (s *Server) projectPages(cwd string) []pages.Page {
	if cwd == "" {
		return nil
	}
	owner, ok := projectOf.Load(cwd)
	if !ok {
		owner, _ = projectOf.LoadOrStore(cwd, pages.ProjectOwner(pages.ProjectRoot(cwd)))
	}
	return s.Pages.Of(owner.(string))
}
