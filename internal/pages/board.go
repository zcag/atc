package pages

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// BoardName is the page every project can have: a pit board of things to decide, which agents add to
// and the user sifts. Its page is a stub atc writes once; what it draws comes from atc's own /board.js,
// so it improves with atc.
const BoardName = "board"

const boardHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board</title>
<link rel="stylesheet" href="/atc.css">
<script src="/atc.js"></script>
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}pit-board{flex:1;min-height:0}</style>
</head>
<body>
<pit-board></pit-board>
<script type="module" src="/board.js"></script>
</body>
</html>
`

// Board makes sure a project has its board page, and gives it.
func (st *Store) Board(owner, name string) (Page, error) {
	if !IsProject(owner) {
		return Page{}, errors.New("a board belongs to a project")
	}
	if st.pins == "" {
		return Page{}, errors.New("atc keeps no page folders here")
	}
	path := filepath.Join(filepath.Dir(st.pins), "projects", owner, BoardName, "index.html")
	if !exists(path) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return Page{}, err
		}
		if err := os.WriteFile(path, []byte(boardHTML), 0o644); err != nil {
			return Page{}, err
		}
	}
	st.mu.Lock()
	has := slices.ContainsFunc(st.s.Pages[owner], func(p Page) bool { return p.Name == BoardName })
	st.mu.Unlock()
	if !has {
		if _, _, err := st.Show(Page{Session: owner, Name: BoardName, Title: name + " board", Path: path, Shown: time.Now()}); err != nil {
			return Page{}, err
		}
		meta, _ := json.Marshal(map[string]any{"board": map[string]string{"name": name, "description": "what to decide on this project"}})
		if err := st.SetState(owner, BoardName, meta); err != nil {
			return Page{}, err
		}
	}
	p, _ := st.Get(owner, BoardName)
	return p, nil
}
