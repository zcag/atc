package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/pages"
)

const showHelp = `atc show: put a page in front of the user, in the session they are reading.

  atc show <file|folder> [--as name] [--title T] [--note "what to look at"]
           [--at id] [--action name='command args']... [--open]

The user sees the page in atc next to this conversation (a button on the session's
header lists its pages), gets a push on their phone, and can open it full size.
It is live: atc serves the file where it is and redraws it every time it changes,
so to update a page, edit the file. Run show again only to point a page at another
file or to change its title, note or actions. Reports, handovers, diagrams, screenshots and
dashboards all go here; don't publish them anywhere else.

  --as name    which page this is; defaults to the file's name (a folder's for its
               index.html). Showing a name again replaces that page. Give each different
               thing its own name and keep it current, rather than a copy per change.
  --title T    defaults to the page's <title> or first # heading
  --note N     one line on what to look at or decide; it goes in the push
  --at id      open it at one section: the element with that id, scrolled to the top
               and briefly marked. The push, --open and the card in the transcript all
               land there. Show again without --at to point back at the top.
  --action name='command args'
               a command the page may run with atc.run (repeatable). Showing the page
               again replaces its actions, so repeat every --action you still want.
  --open       the assistant only: also open the page on the user's phone screen right
               away, over whatever is there (a call). Only when they asked to see it, or
               must; never as a way to get attention.

  atc open <session|@agent>/<page>[#id]
               the assistant only: open a page another session or agent already shows on
               the phone's screen, as --open does, at the section with that id when given
               (atc open @reports/summary#intro). It is that page itself, with its own state,
               so never show a copy of someone else's page. A page of your own is just
               <page>[#id]. Same rules as --open.

A folder shows its index.html, and files beside it (img/, css) load by relative
path, so keep screenshots as files instead of inlining them. HTML, images, markdown,
PDF, CSV/TSV, video and audio render. Make HTML work at phone width, in light and
dark (prefers-color-scheme). Keep it dense, like a dashboard (tables and compact
rows, not big cards), and on a phone reflow rather than cut: a longer page is fine,
a hidden column or truncated field is not.

Give every section of an HTML page an id (<section id="towel">), so it can be linked
to: a page's address is name#id. --at uses it, atc notify --page picks#towel opens the
page there, and a link from another page or a message is the Link atc show prints,
/#/p/<session title or @agent>/<name>#<id> (/#/p/@reports/summary#intro);
inside the page itself it is plain href="#towel". A section the page draws later
from atc.state is found once it appears, when the page loads /atc.js.

To look like atc, link its kit: <link rel="stylesheet" href="/atc.css">. It sets
atc's fonts and colors in light and dark (its tokens, from /tokens.css: --ink --dim
--faint --line --board --strip, the tones, --fs-xs..--fs-4xl, --r-sm..--r-pill, --shadow-1),
follows atc's theme and light/dark setting live when the page loads /atc.js, styles plain markup (h2, table, pre, details, lists), and is dense: 13px text, 6px table
rows, rules instead of boxes, square marks, color only for state. Put everything in
<main class="pg"> (.wide for 1280px instead of 980) and start with
<header class="head"><h1>the finding</h1><p class="lede">it in a sentence</p>
<p class="meta"><span>fact</span>...</p></header>. Then:
section[id] > h2 (a rule and the name; <small> for a right note, .sub a line under it);
.prose (prose in the reading face); .foot (where the numbers came from);
.stats of divs with b (the number, small for its unit), span (what it counts), em;
table with th.n/td.n (numbers, right, mono), td.m, td small, th[aria-sort], .dbar
style="--v:40", tfoot, .tscroll for a wide one; dl.facts (key and value);
.meter style="--v:61; --pace:43" with b, span, i (the bar) and small, .meters for several;
.callout (one sentence that must not be missed); details > summary (small on the right);
ul.rows > li with .main (b, small) and .aside; a.ref (a session, href="#/s/<id>"),
.ref.pr (.draft .merged) .issue .commit .file, .chip (a plain label), .refs;
.btn .primary, aria-busy, .done, :disabled, in .actions; pre (.c, mark),
figure.code > figcaption + pre, pre.diff > .h ins del (i for changed words);
ul.files > li style="--a:31; --d:6" with code ins del or .sz; figure > img + figcaption,
.pair (.phone) for before and after; .chart svg (.grid .ax .lim .line .area .proj .pace
.now .pt text.k) and .legend; .strip (an event strip, i style="--at:34", i.k, .axis);
ul.checks > li (.done .now .no); ol.timeline > li > time + span; .empty; .skel > i;
.changed[data-since]; .cols > aside (a side column), .grid2, .wide-only, .narrow-only.
A state is a letter in a shape, then a word, then color: .st with .needs (N, amber, the
only amber on a page: it waits on the user; once per page at most) .turn .work .live
.stop .park .past, and the same tone on .ref, .rows li, .timeline li, .callout, and
.needs on .stats div and .meter. Under 900px it is one column with 44px targets.
The classes from before still work, drawn the same way: .page, .sec with .n, .card
(.edge), .rows of .row, .cols with --cols, .stats of .stat (<span class="stat">Day
<b>28</b></span>), .meter with .fill and .tick, .tbl, details.disclose, .btn .quiet
.danger .sm .icon .wide, .pill, .tag, .dot, .chip with b and span, .empty (.done), .skel
as an empty div, .bar, .edit, and the tones t-needs t-hot t-turn t-work t-live t-stop.

  atc show --list              this session's pages
  atc show --off <name>        take a page down
  atc show --state <name>      the page's data, as JSON (see atc.state)
  echo '{"k":1}' | atc show --state <name> --set
                               write it: an object replaces only the top-level keys
                               it has, a key set to null is deleted, anything else
                               replaces the whole state

A page's state is its data: write your results there as JSON and let the page
only draw them, while the page keeps what the user does on it under its own keys.
Other tools read it too, with atc state <session> [page].

Pages that talk back load atc's bridge and use window.atc; every call returns a
promise, and outside atc they fall back to localStorage and the clipboard:

  <script src="/atc.js"></script>
  atc.state.get()          what the page saved, for this user on every device
  atc.state.set(obj)       save it (JSON, up to 256 KB), merged by top-level key
                           like --state: set a key to null to delete it
  atc.state.onChange(fn)   call fn whenever the state changes (an agent wrote it),
                           so the page redraws at once; a page that only draws
                           state should get() again in fn
  atc.send(text)           a note from the user straight to this session
  atc.copy(text)           copy to the clipboard, in the browser and the phone app
  atc.toast(text, label, fn)  a toast; with label and fn it has a button (Undo)
  atc.run(name, args)      run a declared action with args (strings) appended, in
                           the page's folder, 30s at most; gives {code, stdout, stderr}
                           (a nonzero code still resolves); fails outside atc

  atc show mail.html --action mark-read='mail-cli markread'
  atc.run("mark-read", [id])           runs: mail-cli markread <id>

The command is split on spaces (no quotes, no shell), and args are passed as separate
arguments, never through a shell, so ; $() and * in them are just text. A page shows
text you don't control (mail, web content) and can be made to call its actions with
any args: declare only commands whose worst case with arbitrary args is acceptable.

Links to other sites open outside atc on their own.

Inside a session atc knows which one it is; anywhere else add --session <session>.
Inside an agent's conversation pages belong to the agent, not the conversation: the
next one shows and reads the same pages and state (atc state @<name>).
`

func show(args []string) error {
	var path, name, title, note, at, ref, mode string
	actions, set, open := map[string][]string{}, false, false
	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, error) {
			if k, v, ok := strings.Cut(a, "="); ok && strings.HasPrefix(k, "-") {
				return v, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", a)
			}
			i++
			return args[i], nil
		}
		var err error
		switch flag, _, _ := strings.Cut(strings.TrimLeft(a, "-"), "="); {
		case !strings.HasPrefix(a, "-"):
			if path != "" {
				return fmt.Errorf("one file at a time; got %q and %q", path, a)
			}
			path = a
		case flag == "h" || flag == "help":
			fmt.Print(showHelp)
			return nil
		case flag == "as" || flag == "name":
			name, err = val()
		case flag == "title":
			title, err = val()
		case flag == "at":
			at, err = val()
		case flag == "note":
			note, err = val()
		case flag == "session":
			ref, err = val()
		case flag == "action":
			var v string
			if v, err = val(); err == nil {
				k, cmd, _ := strings.Cut(v, "=")
				if actions[k] = strings.Fields(cmd); k == "" || len(actions[k]) == 0 {
					err = fmt.Errorf("--action wants name='command args', got %q", v)
				}
			}
		case flag == "set":
			set = true
		case flag == "open":
			open = true
		case flag == "list" || flag == "l" || flag == "off" || flag == "state":
			mode = flag
		default:
			return fmt.Errorf("unknown flag %s (atc show -h)", a)
		}
		if err != nil {
			return err
		}
	}
	c := client.Load()
	sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
	if strings.HasPrefix(ref, "@") {
		sid = ref
	} else if ref != "" {
		s, err := c.Find(ref, true)
		if err != nil {
			return err
		}
		sid = s.SessionID
	}
	if sid == "" {
		return fmt.Errorf("not inside a Claude session, so atc can't tell whose page this is; add --session <session>")
	}
	switch mode {
	case "list", "l":
		list, err := c.Pages(sid)
		if err != nil {
			return err
		}
		if len(list) == 0 {
			fmt.Println("This session shows no pages.")
		}
		for _, p := range list {
			state := "updated " + p.Updated.Format("Jan 2 15:04")
			if p.Gone {
				state = "file is gone"
			}
			fmt.Printf("%-16s %s\n%16s %s · %s\n", p.Name, cmp.Or(p.Title, "(no title)"), "", tilde(p.Path), state)
		}
		return nil
	case "off", "state":
		name = cmp.Or(name, path)
		if name == "" {
			return fmt.Errorf("which page? atc show --%s <name> (atc show --list)", mode)
		}
		if mode == "off" {
			if err := c.HidePage(sid, name); err != nil {
				return err
			}
			fmt.Printf("Took down %s.\n", name)
			return nil
		}
		return pageState(c, sid, name, set)
	}
	if path == "" {
		fmt.Print(showHelp)
		os.Exit(2)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	r, err := c.Show(sid, map[string]any{"path": abs, "name": name, "title": title, "note": note, "at": at, "actions": actions, "open": open})
	if err != nil {
		return err
	}
	p := r.Page
	verb := "Showing"
	if !r.Created {
		verb = "Updated"
	}
	fmt.Printf("%s %q (%s) in atc, live from %s.\n", verb, cmp.Or(p.Title, p.Name), p.Ref(), tilde(p.Path))
	if strings.HasPrefix(r.Link, "http") {
		fmt.Println("Link:", r.Link)
	}
	if r.Created {
		fmt.Println("Edit the file to update it; the user's view redraws on every change.")
	}
	for _, k := range slices.Sorted(maps.Keys(p.Actions)) {
		fmt.Printf("  atc.run(%q, args) runs %s\n", k, strings.Join(p.Actions[k], " "))
	}
	return nil
}

func openPage(args []string) error {
	if len(args) != 1 || strings.HasPrefix(args[0], "-") {
		fmt.Print("usage: atc open <session|@agent>/<page>[#id]   (atc show -h)\n")
		os.Exit(2)
	}
	ref, at, _ := strings.Cut(args[0], "#")
	owner, name := "", ref
	if i := strings.LastIndex(ref, "/"); i >= 0 {
		owner, name = ref[:i], ref[i+1:]
	}
	c := client.Load()
	sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
	if sid == "" {
		return fmt.Errorf("only the assistant opens pages on the phone, from inside its session")
	}
	if owner != "" && !strings.HasPrefix(owner, "@") {
		s, err := c.Find(owner, true)
		if err != nil {
			return err
		}
		owner = s.SessionID
	}
	r, err := c.OpenPage(sid, map[string]any{"session": owner, "name": name, "at": at})
	if err != nil {
		return err
	}
	fmt.Printf("Opened on the phone: %s\n", r.Link)
	return nil
}

func pageState(c *client.Client, sid, name string, write bool) error {
	if !write {
		st, err := c.PageState(sid, name)
		if err == nil {
			fmt.Println(string(st))
		}
		return err
	}
	b, err := io.ReadAll(io.LimitReader(os.Stdin, pages.MaxState+1))
	if err != nil {
		return err
	}
	if b = bytes.TrimSpace(b); !json.Valid(b) {
		return fmt.Errorf("state is JSON; stdin is not")
	}
	return c.SetPageState(sid, name, b)
}

func stateCmd(args []string) error {
	fs := flag.NewFlagSet("state", flag.ExitOnError)
	set := fs.Bool("set", false, "merge the JSON on stdin into the state")
	fs.Parse(args)
	if fs.NArg() < 1 || fs.NArg() > 2 {
		return fmt.Errorf("usage: atc state [-set] <session> [page]")
	}
	c := client.Load()
	sid, title := fs.Arg(0), fs.Arg(0)
	if !strings.HasPrefix(sid, "@") {
		s, err := c.Find(sid, true)
		if err != nil {
			return err
		}
		sid, title = s.SessionID, s.Title
	}
	name := fs.Arg(1)
	if name == "" {
		list, err := c.Pages(sid)
		if err != nil {
			return err
		}
		switch len(list) {
		case 0:
			return fmt.Errorf("%q shows no pages", title)
		case 1:
			name = list[0].Name
		default:
			msg := fmt.Sprintf("%q shows %d pages; name one:", title, len(list))
			for _, p := range list {
				msg += "\n  " + p.Name
			}
			return fmt.Errorf("%s", msg)
		}
	}
	return pageState(c, sid, name, *set)
}

func tilde(p string) string {
	if h, _ := os.UserHomeDir(); h != "" && strings.HasPrefix(p, h+"/") {
		return "~" + p[len(h):]
	}
	return p
}
