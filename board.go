package main

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/pages"
)

const boardHelp = `atc board: the project's board of things to decide.

Every project (the repo this folder is in; a worktree counts as its main checkout) can
have one board: a pit board on a page every session in that repo shows. Agents put
cards on it; the user goes through them one card at a time (→ in, ← out, ↑ maybe,
↓ unsure, on a phone by swiping), reorders what is in, and buries what is done. The
board and its decisions stay when your session ends.

Use it when the user has a choice to make between things you found (options to buy,
picks from a list, photos to keep, ideas worth doing), or for ideas about the project
worth keeping beyond today. A card says it came from you; you never decide for them.

  atc board add <title> [--note N] [--body B] [--url U] [--img FILE|URL] [--as NAME]
                    one card. --note is one line under the title, --body the case for
                    it, --img a picture (a local file is copied next to the board).
                    It is signed with your agent's name or your session's title, or NAME.
  atc board add -   cards from stdin, a JSON array of {title, note, body, url, img}
  atc board         every card with its lane and note, best first: in (in the user's
                    order), maybe, unsure, then what is still waiting (unsorted) and out;
                    a card buried as built says "out done", handed off "out handed"
  atc board --lane in --json
                    only one lane, or JSON with the bodies and links too
  --project DIR     another project than the one this folder is in

The first add makes the board and shows it on the sessions working in the repo. Read
it again to see what the user decided; tell them with atc notify when a batch is
waiting, if they are not looking. Its state, as JSON: atc state --project board.
`

const projectRef = "+project"

func here() string {
	wd, _ := os.Getwd()
	return pages.ProjectOwner(pages.ProjectRoot(wd))
}

type boardCard struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Note   string `json:"note,omitempty"`
	Body   string `json:"body,omitempty"`
	URL    string `json:"url,omitempty"`
	Lane   string `json:"lane"`
	Reason string `json:"reason,omitempty"`
	Source string `json:"source,omitempty"`
	Author string `json:"author,omitempty"`
}

var laneOrder = []string{"in", "maybe", "unsure", "unsorted", "out"}

func boardCmd(args []string) error {
	sub := "ls"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	var dir, lane string
	var asJSON bool
	var card client.BoardCard
	var titles []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "-" || !strings.HasPrefix(a, "-") {
			titles = append(titles, a)
			continue
		}
		flag, v, has := strings.Cut(strings.TrimLeft(a, "-"), "=")
		val := func() (string, error) {
			if has {
				return v, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", a)
			}
			i++
			return args[i], nil
		}
		var err error
		switch flag {
		case "h", "help":
			fmt.Print(boardHelp)
			return nil
		case "json":
			asJSON = true
		case "project":
			dir, err = val()
		case "lane":
			lane, err = val()
		case "note":
			card.Note, err = val()
		case "body":
			card.Body, err = val()
		case "url":
			card.URL, err = val()
		case "img":
			card.Img, err = val()
		case "as":
			card.Author, err = val()
		default:
			return fmt.Errorf("unknown flag %s (atc board -h)", a)
		}
		if err != nil {
			return err
		}
	}
	if dir == "" {
		dir, _ = os.Getwd()
	}
	dir, _ = filepath.Abs(dir)
	c := client.Load()
	switch sub {
	case "add":
		var cards []client.BoardCard
		switch {
		case len(titles) == 1 && titles[0] == "-":
			b, err := io.ReadAll(os.Stdin)
			if err != nil {
				return err
			}
			if err := json.Unmarshal(b, &cards); err != nil {
				return fmt.Errorf("stdin is a JSON array of {title, note, body, url, img}: %v", err)
			}
		case len(titles) == 1:
			card.Title = titles[0]
			cards = []client.BoardCard{card}
		default:
			return fmt.Errorf("one title, quoted, or - for a JSON array on stdin (atc board -h)")
		}
		for i := range cards {
			if img := cards[i].Img; img != "" && !strings.Contains(img, "://") {
				cards[i].Img, _ = filepath.Abs(img)
			}
		}
		r, err := c.BoardAdd(dir, os.Getenv("CLAUDE_CODE_SESSION_ID"), cards)
		if err != nil {
			return err
		}
		fmt.Printf("Added %d to %s's board: %s\n", len(r.IDs), filepath.Base(r.Root), r.Link)
		return nil
	case "ls", "list":
		raw, err := c.PageState(pages.ProjectOwner(pages.ProjectRoot(dir)), pages.BoardName)
		if err != nil || len(raw) == 0 || string(raw) == "null" {
			return fmt.Errorf("%s has no board yet; atc board add makes one", filepath.Base(pages.ProjectRoot(dir)))
		}
		cards := boardCards(raw)
		if lane != "" {
			var only []boardCard
			for _, x := range cards {
				if x.Lane == lane {
					only = append(only, x)
				}
			}
			cards = only
		}
		if asJSON {
			b, _ := json.MarshalIndent(cards, "", "  ")
			fmt.Println(string(b))
			return nil
		}
		if len(cards) == 0 {
			fmt.Println("Nothing on the board" + map[bool]string{true: " in " + lane}[lane != ""] + ".")
		}
		for _, x := range cards {
			who := ""
			if x.Source == "agent" {
				who = "  (" + cmp.Or(x.Author, "an agent") + " suggested)"
			}
			l := x.Lane
			if x.Reason != "" {
				l += " " + x.Reason
			}
			fmt.Printf("%-12s %s%s\n", l, x.Title, who)
			if x.Note != "" {
				fmt.Printf("%-12s %s\n", "", x.Note)
			}
		}
		return nil
	}
	return fmt.Errorf("atc board has add and ls (atc board -h)")
}

// boardCards is the board as the user sees it: what the page holds, plus what agents added that the
// page has not folded in yet (still waiting, so unsorted), in lane order, each lane in its own order.
func boardCards(raw json.RawMessage) []boardCard {
	var st struct {
		Cards []struct {
			boardCard
			Pos float64 `json:"pos"`
		} `json:"cards"`
		Proposed []boardCard `json:"proposed"`
		Seen     []string    `json:"seen"`
	}
	json.Unmarshal(raw, &st)
	seen := map[string]bool{}
	for _, id := range st.Seen {
		seen[id] = true
	}
	type placed struct {
		boardCard
		pos float64
	}
	var all []placed
	for _, x := range st.Cards {
		seen[x.ID] = true
		all = append(all, placed{x.boardCard, x.Pos})
	}
	for i, x := range st.Proposed {
		if !seen[x.ID] {
			x.Lane = "unsorted"
			all = append(all, placed{x, 1e9 + float64(i)})
		}
	}
	rank := func(l string) int { return cmp.Or(slices.Index(laneOrder, l)+1, len(laneOrder)+1) }
	slices.SortStableFunc(all, func(a, b placed) int {
		return cmp.Or(cmp.Compare(rank(a.Lane), rank(b.Lane)), cmp.Compare(a.pos, b.pos))
	})
	out := make([]boardCard, len(all))
	for i, x := range all {
		out[i] = x.boardCard
	}
	return out
}
