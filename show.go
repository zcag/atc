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
           [--action name='command args']...

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
  --action name='command args'
               a command the page may run with atc.run (repeatable). Showing the page
               again replaces its actions, so repeat every --action you still want.

A folder shows its index.html, and files beside it (img/, css) load by relative
path, so keep screenshots as files instead of inlining them. HTML, images, markdown,
PDF, CSV/TSV, video and audio render. Make HTML work at phone width, in light and
dark (prefers-color-scheme). Keep it dense, like a dashboard (tables and compact
rows, not big cards), and on a phone reflow rather than cut: a longer page is fine,
a hidden column or truncated field is not.

To look like atc, link its kit: <link rel="stylesheet" href="/atc.css">. It sets
atc's fonts and colors in light and dark, styles plain markup, and is dense by
default (13.5px text, tight rows), so a page reads like a dashboard. Classes:
.page (the reading column, .wide for a dashboard); .head with h1, .lede, .meta;
.sec (a section header, .n for its count); .card (.edge adds a colored left bar);
.rows of .row with .main and .aside; .cols (columns on a wide screen, --cols);
.stats of .stat (a one-line summary strip: <span class="stat">Day <b>28</b></span>);
.meter with .fill and .tick (a thin progress bar with a pace mark); .tbl (a compact
table); details.disclose (a collapsible block); .btn with .primary .quiet .danger
.sm .icon .wide, .done (copied) and aria-busy; .pill, .tag, .dot; .chip (a link:
<b>#123</b><span>repo</span>); .callout; .empty (.done when all is clear); .skel;
.bar (actions stuck to the bottom); .edit on contenteditable. A tone class (t-needs
t-hot t-turn t-work t-live t-stop) colors .edge, .dot, .pill, .stat, .meter and
.callout.

  atc show <file> --app <name> show it as that app's page, from any script (no session)
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
  atc.send(text)           a note from the user to this session; they confirm it first
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
Inside a run of an app (a preset with "app": true) pages belong to the app, not the
run: the next run shows and reads the same pages and state (atc state app:<name>).
`

func show(args []string) error {
	var path, name, title, note, ref, mode string
	actions, set := map[string][]string{}, false
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
		case flag == "note":
			note, err = val()
		case flag == "session":
			ref, err = val()
		case flag == "app":
			var app string
			if app, err = val(); err == nil {
				ref = "app:" + app
			}
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
	if strings.HasPrefix(ref, "app:") {
		sid = ref
	} else if ref != "" {
		s, err := c.Find(ref, true)
		if err != nil {
			return err
		}
		sid = s.SessionID
	}
	if sid == "" {
		return fmt.Errorf("not inside a Claude session, so atc can't tell whose page this is; add --session <session> or --app <name>")
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
	r, err := c.Show(sid, map[string]any{"path": abs, "name": name, "title": title, "note": note, "actions": actions})
	if err != nil {
		return err
	}
	p := r.Page
	verb := "Showing"
	if !r.Created {
		verb = "Updated"
	}
	fmt.Printf("%s %q (%s) in atc, live from %s.\n", verb, cmp.Or(p.Title, p.Name), p.Name, tilde(p.Path))
	if r.Created {
		fmt.Println("Edit the file to update it; the user's view redraws on every change.")
	}
	for _, k := range slices.Sorted(maps.Keys(p.Actions)) {
		fmt.Printf("  atc.run(%q, args) runs %s\n", k, strings.Join(p.Actions[k], " "))
	}
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
	if !strings.HasPrefix(sid, "app:") {
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
