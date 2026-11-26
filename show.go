package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/when"
)

const showMore = `The user sees the page in atc next to this conversation (a button on the session's
header lists its pages), gets a push on their phone, and can open it full size.
It is live: atc serves the file where it is and redraws it every time it changes,
so to update a page, edit the file. Run show again only to point a page at another
file or to change its title, note or actions. Reports, handovers, diagrams, screenshots and
dashboards all go here; don't publish them anywhere else.

A page shown here belongs to this session. When it is something the user will come back
to (it keeps updating over time, or they will look things up in it later), make it a
pinned page instead: atc pages -h.


A page of another session or agent opens on the phone with atc open (atc open -h).

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
--faint --line --board --strip, the tones, --fs-micro..--fs-display, --s1..--s7, --r1..--r3 and --pill, --pop;
the older --fs-xs..--fs-4xl, --r-sm..--r-pill and --shadow-1 still work),
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

With --project the page belongs to the project (the repo this folder is in; a worktree counts as
its main checkout) instead of this session: every session working there shows it, and it and
its state stay when this session ends. For what is true of the project beyond today's work.
It works with --list, --off and --state, and atc state --project [page] reads it from anywhere
in the repo.

A project also has a board of things to decide: atc board -h.
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
		case flag == "project":
			ref = projectRef
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
	if ref == projectRef {
		sid = here()
	} else if strings.HasPrefix(ref, "@") {
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
			state := "updated " + when.Stamp(p.Updated.Local(), time.Now())
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
		usageExit("show")
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

const pagesMore = `A page from atc show belongs to its session: the work in front of the user, a report,
a diff, a result. It lives where its file is and goes when that does.

A pinned page belongs to no session. It is for what the user comes back to: a page
that keeps updating over time (a tracker, a small site, a dashboard) or a sheet they
will look things up in later. It is a folder atc keeps and never deletes, it sits at
the top of atc's Pages screen, and it has a short link, /p/<name>. Pin only what is
meant to last; one-off results stay on the session.

new makes a pinned page and prints its folder: write index.html (or index.md) there, with any
files beside it; it shows once index.html exists. To update the page, edit the files there,
from this session or any later one: that folder is the only copy. An existing name gives its
folder. unpin takes it off the Pinned list and keeps the folder, listed under Unpinned; pin
brings it back. rm deletes an unpinned page and its folder for good, only on the user's ask.
show also shows it in this session, as atc show does: it lands in the session's pages with a
push and stays the one pinned page (same state, same link); taking it down there only takes it
off the session. state is its atc.state, as atc show --state.

Making a session page a pinned one is a move you do yourself: atc pages new, write the
page into that folder (copy its images too, and fix any path that pointed outside it),
check it shows, then take the old one down with atc show --off. Names are lowercase
letters, digits and dashes. Everything in atc show -h about writing pages, atc.css and
/atc.js applies here as well.
`

func pagesCmd(args []string) error {
	c := client.Load()
	op, name := "", ""
	if len(args) > 0 {
		op = args[0]
	}
	if len(args) > 1 {
		name = args[1]
	}
	need := func() error {
		if name == "" {
			return fmt.Errorf("which page? atc pages %s <name>", op)
		}
		return nil
	}
	switch op {
	case "-h", "--help", "help":
		printHelp("pages")
		return nil
	case "", "ls", "list":
		list, err := c.Pins()
		if err != nil {
			return err
		}
		if len(list) == 0 {
			fmt.Println("No pinned pages yet: atc pages new <name>.")
		}
		for _, p := range list {
			state := "pinned"
			if p.Unpinned {
				state = "unpinned"
			}
			fmt.Printf("%-24s %s\n%24s %s, %s · updated %s\n", p.Name, cmp.Or(p.Title, "(no title)"), "", state, tilde(filepath.Dir(p.Path)), when.Stamp(p.Updated.Local(), time.Now()))
		}
		return nil
	case "new":
		if err := need(); err != nil {
			return err
		}
		r, err := c.NewPin(name)
		if err != nil {
			return err
		}
		if r.Created {
			fmt.Printf("Made pinned page %s: write index.html in %s.\n", name, r.Dir)
		} else {
			fmt.Printf("%s is already pinned; its folder is %s.\n", name, r.Dir)
		}
		if strings.HasPrefix(r.Link, "http") {
			fmt.Println("Link:", r.Link)
		}
		return nil
	case "pin", "unpin":
		if err := need(); err != nil {
			return err
		}
		if err := c.SetPinned(name, op == "pin"); err != nil {
			return err
		}
		fmt.Printf("%sned %s.\n", strings.ToUpper(op[:1])+op[1:], name)
		return nil
	case "rm":
		if err := need(); err != nil {
			return err
		}
		if err := c.DeletePin(name); err != nil {
			return err
		}
		fmt.Printf("Deleted %s.\n", name)
		return nil
	case "show":
		if err := need(); err != nil {
			return err
		}
		sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
		if sid == "" {
			return fmt.Errorf("not inside a Claude session, so atc can't tell which session shows it")
		}
		list, err := c.Pins()
		if err != nil {
			return err
		}
		i := slices.IndexFunc(list, func(p pages.Page) bool { return p.Name == name })
		if i < 0 {
			return fmt.Errorf("no pinned page %s with an index.html yet (atc pages)", name)
		}
		note := ""
		if j := slices.Index(args, "--note"); j >= 0 && j+1 < len(args) {
			note = args[j+1]
		}
		r, err := c.Show(sid, map[string]any{"path": filepath.Dir(list[i].Path), "note": note})
		if err != nil {
			return err
		}
		fmt.Printf("Showing pinned page %s in this session.\n", r.Page.Name)
		if strings.HasPrefix(r.Link, "http") {
			fmt.Println("Link:", r.Link)
		}
		return nil
	case "state":
		if err := need(); err != nil {
			return err
		}
		return pageState(c, pages.Pinned, name, slices.Contains(args, "--set") || slices.Contains(args, "-set"))
	}
	return fmt.Errorf("unknown: atc pages %s (atc pages -h)", op)
}

func openPage(args []string) error {
	if len(args) != 1 || strings.HasPrefix(args[0], "-") {
		usageExit("open")
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
	fmt.Printf("Opened %s on the phone.\n", r.Link)
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
	if err := c.SetPageState(sid, name, b); err != nil {
		return err
	}
	fmt.Printf("Saved the state of %s.\n", name)
	return nil
}

func stateCmd(args []string) error {
	fs := flags("state")
	set := fs.Bool("set", false, "merge the JSON on stdin into the state")
	project := fs.Bool("project", false, "the project this folder is in, instead of a session")
	fs.Parse(args)
	argv := fs.Args()
	if *project {
		argv = append([]string{here()}, argv...)
	}
	if len(argv) < 1 || len(argv) > 2 {
		return usageErr("state")
	}
	c := client.Load()
	sid, title := argv[0], argv[0]
	if !strings.HasPrefix(sid, "@") && !pages.IsProject(sid) {
		s, err := c.Find(sid, true)
		if err != nil {
			return err
		}
		sid, title = s.SessionID, s.Title
	}
	name := ""
	if len(argv) > 1 {
		name = argv[1]
	}
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
