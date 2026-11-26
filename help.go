package main

import (
	"cmp"
	"errors"
	"flag"
	"fmt"
	"os"
	"slices"
	"strings"
)

type help struct {
	what     string
	usage    []string
	flags    [][2]string
	examples []string
	more     string
}

const helpWidth = 92

func wrap(s string, width int) []string {
	var lines []string
	line := ""
	for _, w := range strings.Fields(s) {
		if line != "" && len(line)+1+len(w) > width {
			lines = append(lines, line)
			line = ""
		}
		line = strings.TrimSpace(line + " " + w)
	}
	return append(lines, line)
}

func (h help) forms() []string {
	if len(h.usage) == 0 {
		return []string{""}
	}
	return h.usage
}

func (h help) text(name string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "atc %s: %s\n\nUsage\n", name, h.what)
	for _, u := range h.forms() {
		fmt.Fprintf(&b, "  %s\n", strings.TrimSpace("atc "+name+" "+u))
	}
	flags := append(slices.Clone(h.flags), [2]string{"-h, --help", "show this help"})
	col := 0
	for _, f := range flags {
		if len(f[0]) <= 22 {
			col = max(col, len(f[0]))
		}
	}
	b.WriteString("\nFlags\n")
	for _, f := range flags {
		desc := wrap(f[1], helpWidth-col-4)
		if len(f[0]) > col {
			fmt.Fprintf(&b, "  %s\n", f[0])
		} else {
			fmt.Fprintf(&b, "  %-*s  %s\n", col, f[0], desc[0])
			desc = desc[1:]
		}
		for _, d := range desc {
			fmt.Fprintf(&b, "  %*s  %s\n", col, "", d)
		}
	}
	if len(h.examples) > 0 {
		b.WriteString("\nExamples\n")
		for _, e := range h.examples {
			fmt.Fprintf(&b, "  %s\n", e)
		}
	}
	if h.more != "" {
		b.WriteString("\n")
		for _, l := range strings.Split(strings.TrimSpace(h.more), "\n") {
			if len(l) > helpWidth {
				l = strings.Join(wrap(l, helpWidth), "\n")
			}
			b.WriteString(l + "\n")
		}
	}
	return b.String()
}

var aliases = map[string]string{"list": "ls", "guests": "guest", "groups": "group", "profiles": "profile"}

func helpFor(cmd string) (string, bool) {
	cmd = cmp.Or(aliases[cmd], cmd)
	h, ok := helps[cmd]
	if !ok {
		return "", false
	}
	return h.text(cmd), true
}

func helpAsked(args []string) bool {
	for _, a := range args {
		switch a {
		case "--":
			return false
		case "-h", "--help", "-help":
			return true
		}
	}
	return false
}

func printHelp(cmd string) {
	if t, ok := helpFor(cmd); ok {
		fmt.Print(t)
	}
}

func usageErr(cmd string) error {
	cmd = cmp.Or(aliases[cmd], cmd)
	h := helps[cmd]
	var forms []string
	for _, u := range h.forms() {
		forms = append(forms, strings.TrimSpace("atc "+cmd+" "+u))
	}
	return errors.New("usage: " + strings.Join(forms, "\n       ") + "\n(atc " + cmd + " -h for more)")
}

func flags(cmd string) *flag.FlagSet {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	fs.Usage = flagUsage(cmd)
	return fs
}

func flagUsage(cmd string) func() {
	return func() { fmt.Fprintln(os.Stderr, "atc:", usageErr(cmd)) }
}

func usageExit(cmd string) {
	fmt.Fprintln(os.Stderr, "atc:", usageErr(cmd))
	os.Exit(2)
}

var sections = []struct {
	title string
	cmds  []string
}{
	{"Sessions", []string{"ls", "attach", "new", "send", "resume", "stop", "rm", "rename", "pin", "unpin", "park", "unpark", "backlog", "history", "summary", "outputs", "mcp"}},
	{"Pages and boards", []string{"show", "pages", "board", "open", "state", "browser"}},
	{"Phone, messages and calls", []string{"notify", "wa", "guest", "group", "call", "hub", "voice", "app"}},
	{"Usage and machines", []string{"usage", "limits", "top", "why", "profile"}},
	{"Setup and server", []string{"setup", "doctor", "service", "prompts", "serve", "login", "pair", "peer", "token", "version"}},
}

var tops = map[string]string{
	"pages": "pages [new|pin|unpin|rm|show|state]", "board": "board [add]", "guest": "guest [add|rm|call]",
	"group": "group [quiet|on]", "hub": "hub [status|reset]", "voice": "voice [install|status|uninstall]",
	"app": "app update|characters", "profile": "profile [add|rm|move]", "service": "service install|uninstall|status",
	"peer": "peer add", "browser": "browser mcp",
}

func topUsage() string {
	var b strings.Builder
	b.WriteString("atc: every Claude Code session on a machine, in one place.\n\nUsage\n  atc                       browse, start and attach in a terminal UI\n  atc <command> [flags]\n")
	const col = 20
	for _, s := range sections {
		fmt.Fprintf(&b, "\n%s\n", s.title)
		for _, c := range s.cmds {
			name := cmp.Or(tops[c], c)
			what := wrap(strings.TrimSuffix(helps[c].what, "."), helpWidth-col-8)
			if len(name) > col {
				fmt.Fprintf(&b, "  atc %s\n", name)
			} else {
				fmt.Fprintf(&b, "  atc %-*s  %s\n", col, name, what[0])
				what = what[1:]
			}
			for _, w := range what {
				fmt.Fprintf(&b, "      %*s  %s\n", col, "", w)
			}
		}
	}
	b.WriteString("\n<session> is a row number from atc ls, a short id, a session id prefix, or a unique\npiece of the title. atc <command> -h shows a command's flags and examples.\n")
	return b.String()
}

const sessionArg = "<session> is a row number from atc ls, a short id, a session id prefix, or a unique piece of the title."

var jsonFlag2 = [2]string{"--json", "print JSON, for scripts"}

func verbHelp(what, eg string, flags ...[2]string) help {
	return help{what: what, usage: []string{"<session>"}, flags: flags, examples: []string{eg}, more: sessionArg}
}

var helps = map[string]help{
	"serve": {
		what:  "serve the web UI and the API for this machine's sessions.",
		usage: []string{"[--addr HOST:PORT] [--root DIR]... [--no-auth]"},
		flags: [][2]string{
			{"--addr HOST:PORT", "where to listen ($ATC_ADDR); by default every interface, answering only private addresses"},
			{"--root DIR", "a folder whose subfolders are offered for new sessions; repeat for more, or $ATC_ROOTS separated by :"},
			{"--no-auth", "serve without a token, only behind something that authenticates"},
		},
		examples: []string{"atc serve", "atc serve --addr 127.0.0.1:7272 --root ~/src"},
		more: `New sessions get the flags in $ATC_CLAUDE_ARGS. A finished turn's final message is summarized
with claude -p and haiku ($ATC_SUMMARY_MODEL), or an OpenAI-compatible model at $ATC_SUMMARY_URL;
ATC_SUMMARY=off turns it off. Usually it runs as a service: atc service install.`,
	},
	"token": {
		what:     "print this machine's server token.",
		examples: []string{"atc token"},
		more:     "Another machine logs in with it: atc login <url> <token>. atc pair is the safer way to let a device in.",
	},
	"version": {what: "print this build.", examples: []string{"atc version"}},
	"doctor": {
		what:     "what each atc feature needs, how it stands, and the fix.",
		usage:    []string{"[--json]"},
		flags:    [][2]string{jsonFlag2},
		examples: []string{"atc doctor", "atc doctor --json | jq '.[] | select(.status != \"ok\")'"},
		more: `It runs the same checks Settings shows: the status, what is wrong in plain words, and the fix.
It asks the running server, with its environment and machines; with none running it does the
same checks here, over the same files.

Exits 1 only if something required is missing or something set up stopped working on the
machine it asked. Optional features that were never set up are fine.`,
	},
	"login": {
		what:     "save which atc server this machine talks to.",
		usage:    []string{"<url> <token>", "<pairing>"},
		examples: []string{"atc login https://devbox:7272 3f9c...", "atc login 'atc1:...'"},
		more:     "A pairing is the text atc pair prints: this machine gets a token of its own, which Settings › Devices can revoke.",
	},
	"pair": {
		what:     "let one new device in: a QR code and a text, one use, for 10 minutes.",
		usage:    []string{"[--url URL] [--json]"},
		flags:    [][2]string{{"--url URL", "the address the new device will reach, when the one atc finds is not it"}, {"--json", "print the pairing text as JSON"}},
		examples: []string{"atc pair", "atc pair --url https://devbox.example:7272"},
		more:     "Scan it in the Android app, or on another machine run atc login or atc peer add with the text.",
	},
	"peer": {
		what:     "add another machine's atc, so this server lists its sessions too.",
		usage:    []string{"add [--name NAME] <pairing>"},
		flags:    [][2]string{{"--name NAME", "what to call it; by default the name it reports"}},
		examples: []string{"atc peer add 'atc1:...'", "atc peer add --name laptop 'atc1:...'"},
		more:     "The pairing is what atc pair prints on the other machine. It goes in peers.json; restart atc to pick it up.",
	},
	"ls": {
		what:     "live sessions, most urgent first.",
		usage:    []string{"[--json]"},
		flags:    [][2]string{{"--json", "print the full rows as JSON"}},
		examples: []string{"atc ls", "atc ls --json | jq -r '.[].title'"},
	},
	"history": {
		what:     "past conversations, newest first.",
		usage:    []string{"[--json] [query...]"},
		flags:    [][2]string{{"--json", "print the full rows as JSON"}},
		examples: []string{"atc history", "atc history upload test"},
		more:     "A row's id works wherever a <session> goes: atc resume 3f2a9c1e.",
	},
	"new": {
		what:  "start a session.",
		usage: []string{"[--name NAME] [--host MACHINE] [--profile NAME] [--report] [dir] [prompt...]", "--preset PRESET [prompt...]"},
		flags: [][2]string{
			{"-n, --name NAME", "the session's name"},
			{"--host MACHINE", "the machine to start it on, when the server lists several"},
			{"--profile NAME", "the Claude account to run it on (atc profile); by default the one its folder belongs to"},
			{"--report", "from inside a Claude session: ask the new session to report back to it"},
			{"-p, --preset NAME", "start from a preset (presets.json in the server's config folder)"},
		},
		examples: []string{"atc new", "atc new ~/src/app fix the failing test", "atc new --host laptop -n 'Bump Go' ~/src/infra"},
		more: `dir is the current folder by default, with your home written as ~, so it maps onto the same
path under the server's home.`,
	},
	"attach": {
		what:     "take over this terminal with a session; Ctrl+Z detaches.",
		usage:    []string{"<session>"},
		examples: []string{"atc attach 2", "atc attach 'upload test'"},
		more:     "A stopped session asks to be resumed first. " + sessionArg,
	},
	"send": {
		what:  "type a message into a session, resuming it if it stopped.",
		usage: []string{"[--report] [--wake] [--approved] <session> [text...]"},
		flags: [][2]string{
			{"--report", "from inside a Claude session: ask the other to report back to this one"},
			{"--wake", "from inside a Claude session: resume it although it stopped and does not wait on this one"},
			{"--approved", "from the assistant only: this relays the user's own go-ahead, so it counts as their approval"},
		},
		examples: []string{"atc send 2 run the tests again", "make test 2>&1 | atc send 'upload test'", "atc send @reports what changed today?"},
		more: `It reads stdin when no text is given. @name wakes that agent, starting its conversation if
needed. Without --report the work is handed off and the other does not report back. A stopped
session is resumed for it only when it waits on its report, or with --wake. ` + sessionArg,
	},
	"mcp": {
		what:     "tools for Claude to see and drive your other sessions, as an MCP server over stdio.",
		examples: []string{"claude mcp add atc -- atc mcp"},
	},
	"resume": verbHelp("bring a stopped or past session back.", "atc resume 3"),
	"stop":   verbHelp("stop a session; its conversation is kept.", "atc stop 3"),
	"rm":     verbHelp("delete a background session.", "atc rm 3"),
	"rename": {
		what:     "give a session a name of your own.",
		usage:    []string{"<session> <name...>"},
		examples: []string{"atc rename 4 CSV export"},
		more:     sessionArg,
	},
	"pin":   verbHelp("keep a session at the top of the list.", "atc pin 2"),
	"unpin": verbHelp("let a pinned session take its place by state again.", "atc unpin 2"),
	"park": {
		what:     "put a session away until it is needed again: the bottom of the list, no notifications.",
		usage:    []string{"[session]"},
		examples: []string{"atc park 7", "atc park 'Fix flaky upload test'"},
		more:     "Inside a session, without one, it parks that session. " + sessionArg,
	},
	"unpark": {
		what:     "bring a parked session back to the list.",
		usage:    []string{"[session]"},
		examples: []string{"atc unpark 7"},
		more:     "Inside a session, without one, it unparks that session. " + sessionArg,
	},
	"backlog": {
		what:     "send a session to the backlog, or list the backlog.",
		usage:    []string{"", "<session> [title...]"},
		examples: []string{"atc backlog", "atc backlog 3", "atc backlog 3 try the new parser later"},
		more: `A session on the backlog is stopped (memory freed; a working one when its turn ends), off the
list, and kept as an item that resumes the same conversation. ` + sessionArg,
	},
	"summary": {
		what:     "a session's final message in short: a status line, the gist and an overview.",
		usage:    []string{"[--json] [--again] <session>"},
		flags:    [][2]string{jsonFlag2, {"--again", "summarize it anew"}},
		examples: []string{"atc summary 2"},
		more:     sessionArg,
	},
	"outputs": {
		what:     "what a session produced: running servers, files, links and the code it touched.",
		usage:    []string{"[--json] <session>"},
		flags:    [][2]string{jsonFlag2},
		examples: []string{"atc outputs 2"},
		more:     "Each file comes with a link that opens it in a browser. " + sessionArg,
	},
	"usage": {
		what:     "plan limits and tokens per day; with a session, its tokens, models, turns and time.",
		usage:    []string{"[--json] [session]"},
		flags:    [][2]string{jsonFlag2},
		examples: []string{"atc usage", "atc usage 2"},
		more:     "A session's cost is an estimate at Claude API list prices.",
	},
	"limits": {
		what:  "plan limits, one line each.",
		usage: []string{"[--json] [--short]", "--tap"},
		flags: [][2]string{jsonFlag2, {"--short", "one line, for a status line or prompt"},
			{"--tap", "record the limits from Claude Code's status line input on stdin, so atc shows them without asking Anthropic"}},
		examples: []string{"atc limits", "atc limits --short"},
	},
	"top": {
		what:     "memory, CPU and disk per session, and what outlived its session.",
		usage:    []string{"[--json] [--host MACHINE] [session]"},
		flags:    [][2]string{jsonFlag2, {"--host MACHINE", "which machine; by default the server's own"}},
		examples: []string{"atc top", "atc top 2"},
		more:     "With a session, its processes.",
	},
	"why": {
		what:     "why a session stopped, with the log lines it rests on.",
		usage:    []string{"[--json] [--raw] [--host MACHINE] [session|incident]"},
		flags:    [][2]string{jsonFlag2, {"--raw", "print each log line the evidence rests on"}, {"--host MACHINE", "which machine's incidents; by default the server's own"}},
		examples: []string{"atc why", "atc why 3", "atc why oom-1a2b3c"},
		more:     "With nothing, the week's memory incidents.",
	},
	"profile": {
		what:     "the Claude accounts sessions run on, and whether each is signed in.",
		usage:    []string{"", "add [--dir DIR] <name> <folder>...", "add [--dir DIR] <name> --ephemeral", "login <name>", "rm <name>", "move <session> <name>"},
		flags: [][2]string{{"--dir DIR", "add: the account's Claude config folder (default ~/.claude-<name>)"},
			{"--ephemeral", "add: an account for private sessions, which keep nothing"}},
		examples: []string{"atc profile", "atc profile add work ~/work", "atc profile add private --ephemeral", "atc profile move 3 work"},
		more: `add      a Claude account for the sessions under those folders: a config folder of its own with
         its own sign-in, transcripts and daemon, sharing your settings, CLAUDE.md, skills,
         commands, agents, plugins and MCP servers. Run it again to bring over MCP servers
         added since.
         With --ephemeral, an account for private sessions instead: whatever they write is
         kept in memory ($XDG_RUNTIME_DIR) and erased when they end or the machine restarts.
         Its folder keeps only a CLAUDE.md and settings of its own (no memory, no MCP servers,
         writes only in the session's folder) and the token it signs in with.
login    sign an ephemeral account in: runs claude setup-token and keeps the token
rm       sessions under its folders go back to the default account; its folder and transcripts
         are left as they are
move     put a session on another account, with its whole conversation: a session resumes on
         the account that keeps its transcript, so this moves the transcript, and an open
         session resumes there

Profiles live in profiles.json in atc's config folder; atc reads it when it starts.`,
	},
	"setup": {
		what:  "a guided first run: who you are, limits, tools, and reaching atc from other devices.",
		usage: []string{"[--yes] [--calls] [--trust-tailnet] [--autonomy LEVEL] [--user NAME] [--assistant NAME] [--language CODE]"},
		flags: [][2]string{
			{"--yes", "accept every suggestion without asking, except --calls and --trust-tailnet"},
			{"--calls", "set up calls without asking; about 2 GB, so --yes alone doesn't"},
			{"--trust-tailnet", "let your own Tailscale devices in without a token; it widens who gets in, so --yes alone doesn't"},
			{"--autonomy LEVEL", "what the assistant may do alone: limited, daily (what --yes takes) or full"},
			{"--user NAME", "your name, as the assistant calls you"},
			{"--assistant NAME", "the assistant's name"},
			{"--language CODE", "the language the assistant speaks"},
		},
		examples: []string{"atc setup", "atc setup --yes --user Ada"},
		more: `It walks through what a new install needs: who you are, Claude Code's status line (how atc
learns your plan limits), atc's tools for your sessions, how to reach atc from other devices,
the call characters and calls. Safe to run again: what is set stays, and nothing changes
without asking.`,
	},
	"service": {
		what:     "run atc and the assistant's hub as services of your user.",
		usage:    []string{"install|uninstall|status [--only atc|hub|opencode]"},
		flags:    [][2]string{{"--only NAME", "one of them; by default atc and hub. opencode is only ever on request: a headless opencode server on 127.0.0.1:4096 with its own config folder, for opencode sessions next to Claude's"}},
		examples: []string{"atc service install", "atc service status", "atc service install --only hub"},
		more: `install    copy this binary to ~/.local/bin and run the services: systemd on Linux, launchd on
           macOS. Safe to run again to upgrade: sessions keep running, and a restart waits for
           a call to end.
uninstall  stop and remove the services; your settings and sessions stay
status     whether each one runs`,
	},
	"prompts": {
		what:     "every text the assistant is told, with your own files in ~/.config/atc/modes applied.",
		usage:    []string{"[--check | --update]"},
		flags:    [][2]string{{"--check", "compare with prompts.golden in that folder and show what changed; exit 1 if anything did"}, {"--update", "accept the current text as prompts.golden"}},
		examples: []string{"atc prompts", "atc prompts --check"},
	},
	"app": {
		what:     "download the latest Android app and call characters for this server to offer.",
		usage:    []string{"update", "characters"},
		examples: []string{"atc app update"},
		more: `update      downloads the app and the characters from atc's releases into the folder this server
            offers them from (ATC_APP_DIR, by default ~/.local/share/atc/app), so phones can
            install it from /app/ and update from it
characters  downloads only the characters and rooms, about 10 MB`,
	},
	"browser": {
		what:     "the shared browser, one session's tabs at a time.",
		usage:    []string{"mcp [playwright-mcp flags...]"},
		examples: []string{"claude mcp add -s user browser -- atc browser mcp"},
		more: `mcp is Playwright's MCP server, connected to the browser atc shares (ATC_BROWSER on the
server) as this session: it sees and drives only the tabs this session opened, and the user
can watch and take over those tabs in atc. Playwright starts on the session's first browser
call; until then atc answers from its last tool list. Use it as the command of a browser MCP
server.`,
	},
	"open": {
		what:     "the assistant only: open a page any session or agent shows on the user's phone screen.",
		usage:    []string{"<session|@agent>/<page>[#id]", "<page>[#id]"},
		examples: []string{"atc open @reports/summary#intro", "atc open 3/handover"},
		more: `It is that page itself, with its own state, so never show a copy of someone else's page. A page
of your own is just <page>[#id]. Same rules as atc show --open: only when they asked to see it,
or must. atc show -h has the rest.`,
	},
	"state": {
		what:     "a page's state, as JSON.",
		usage:    []string{"[--set] <session> [page]", "[--set] --project [page]"},
		flags:    [][2]string{{"--set", "merge the JSON on stdin into it by top-level key (null deletes a key)"}, {"--project", "the project this folder is in, instead of a session"}},
		examples: []string{"atc state 3", "atc state @reports summary", `echo '{"done":true}' | atc state --set 3 picks`},
		more:     "page can be left out when the session shows one. @name in place of <session> is an agent's pages. " + sessionArg,
	},
	"notify": {
		what:  "tell the user something, as a push on their phone.",
		usage: []string{"[--urgent] [--reply TEXT]... [--page NAME[#id]] [--session S] [message...]"},
		flags: [][2]string{
			{"--urgent", "always buzz, whatever they are doing; keep it for things that can't wait"},
			{"--reply TEXT", "a button on the push that sends TEXT back to this session when tapped; repeat for more, up to three. The user can also type a reply"},
			{"--page NAME[#id]", "tapping it opens this session's page (atc show), at the section with that id when given"},
			{"--session S", "the session it is from, outside a session"},
		},
		examples: []string{"atc notify the deploy is done", "atc notify --reply 'ship it' --reply wait 'the release is ready'", "echo 'build failed' | atc notify --urgent"},
		more: `From inside a session the push carries the session's title and opens it when tapped. It
reads the message from stdin when none is given. By default it follows atc's own rules, the
same as a finished turn: no push while the user is looking at this session or using atc
anywhere, or while the session is parked.`,
	},
	"wa": {
		what: "send the user something on WhatsApp, from the account atc answers them on.",
		usage: []string{"[--file PATH]... [--render PAGE.html]... [--caption TEXT] [--voice TEXT] [text...]",
			"--poll QUESTION --option A --option B... [--multi]", "--to NAME [--file PATH]... [--voice TEXT] [text...]",
			"--group GROUP [--file PATH]... [--voice TEXT] [text...]"},
		flags: [][2]string{
			{"--file PATH", "a file: images and videos show inline, audio plays, anything else arrives as a document (PDF, CSV, a zip). Repeat for more"},
			{"--render PAGE", "an HTML file drawn as an image, 480px wide: a chart, a diagram, a layout text can't hold. Repeat for more"},
			{"--caption TEXT", "a caption under the files and rendered pages"},
			{"--voice TEXT", "a voice note, TEXT spoken by atc's text-to-speech"},
			{"--poll QUESTION", `a poll they answer with a tap, with 2 to 12 --option (each up to 100 characters); their vote comes back into the whatsapp session as a "[poll vote]" message`},
			{"--option TEXT", "one answer of the poll"},
			{"--multi", "let them pick several answers"},
			{"--to NAME", "send to that guest instead of the user (no polls)"},
			{"--group GROUP", "send to that group, by name or id (no polls)"},
		},
		examples: []string{"atc wa the report is ready", "atc wa --file report.pdf --caption 'this week'", "atc wa --poll 'Lunch?' --option yes --option no"},
		more: `It reaches the user, with --to one of the guests atc listens to (atc guest), or with --group a
WhatsApp group the user is in (atc group); anyone else is refused. Without either it goes where
you belong: the assistant to the user's chat, an agent with a group of its own to that group,
any other session to the Sessions group under its title, where a reply quoting it comes back to
you. Where your replies are delivered already (the assistant's chat, an agent talking in its
group), use this for what a reply can't carry. text is Markdown, converted to WhatsApp's own
markup; it reads stdin when nothing else is given. The files must be on the machine atc runs on.`,
	},
	"guest": {
		what:     "the people besides the user who may write to atc's WhatsApp.",
		usage:    []string{"", "add NAME NUMBER", "rm NAME", "call NAME [WHAT]"},
		examples: []string{"atc guest", "atc guest add Ada +15550100", "atc guest call Ada Ada"},
		more: `add   let NAME write in (NUMBER in full, with country code)
rm    stop listening to NAME
call  what a call greets NAME by, a first name; none to clear

A guest's message reaches the assistant on its guest channel, which answers with
atc wa --to NAME. Add someone only when the user asks for it in their own words.
The list lives on the machine atc's WhatsApp runs on, in ~/.config/atc/guests.`,
	},
	"group": {
		what:     "the WhatsApp groups atc's account is in.",
		usage:    []string{"", "quiet GROUP", "on GROUP"},
		examples: []string{"atc group", "atc group quiet 'Family'"},
		more: `Without a command it lists them: in (atc takes part), quiet, without you, or @name and sessions
for the groups of atc's own. quiet keeps atc out of GROUP although you are in it (by name or
id); on lets it take part again.

atc takes part in every group you are in: the guests' conversation reads each message and
answers with atc wa --group when it judges it should. Being added to a group you are in is
enough; nobody else there needs to be a guest. The groups of atc's own (an agent's, and
Sessions, see docs/whatsapp.md) are never the guests': only their owner talks there.`,
	},
	"call": {
		what:  "ring the user, with the assistant on the line.",
		usage: []string{"[--reason TEXT] [--wait] [--timeout 45s] [--app | --phone | --whatsapp]"},
		flags: [][2]string{
			{"--reason TEXT", "why you are calling and what to tell them"},
			{"--wait", "wait for the outcome and print it: answered, no-answer or busy"},
			{"--timeout D", "how long it rings (default 45s)"},
			{"--app", "only the atc app, no fallback to the phone line"},
			{"--phone", "only the phone line"},
			{"--whatsapp", "a WhatsApp voice call from the assistant's account instead; only when the user asks for one"},
		},
		examples: []string{"atc call --reason 'the release needs your go-ahead'", "atc call --wait --timeout 30s"},
		more: `It rings the atc app on their phone (a call over atc, like a WhatsApp call); when the app does
not ring within a few seconds (no data, phone off), the phone line, when there is one, calls
their own number instead, never another: $ATC_CALL_NUMBER on the hub's machine, by default the
first number in $ATC_WHATSAPP_OWNER. The phone shows the call as from $ATC_CALL_LINE_NUMBER.
When they pick up, the assistant speaks first and knows the reason; from another session, it
also knows who asked and passes their answer back to you with send. Without --wait it returns
at once; a call nobody picks up comes back to your session as a message saying so.`,
	},
	"hub": {
		what:  "the assistant's one conversation, shared by atc, WhatsApp and phone calls.",
		usage: []string{"[--addr 127.0.0.1:8820] [--model opus] [--effort medium] [--state DIR] [--dir DIR]", "status", "reset"},
		flags: [][2]string{
			{"--addr HOST:PORT", "where to listen ($ATC_HUB_ADDR, default 127.0.0.1:8820)"},
			{"--model NAME", "Claude model (default opus)"},
			{"--effort LEVEL", "Claude effort (default medium)"},
			{"--state DIR", "where the session id and handover notes live"},
			{"--dir DIR", "the folder a new session starts in"},
			{"--guest-state DIR", "the guests' conversation's session id and handover notes"},
			{"--quiet D, --small N", "quiet this long and past this many tokens: start over (default 6h, 80000)"},
			{"--cap-quiet D, --cap N", "quiet this long and past this many: start over (default 10m, 150000)"},
		},
		examples: []string{"atc hub status", "atc hub reset"},
		more: `It runs Claude as a stream-json process that each channel talks into, so a reply streams to
whoever asked while the others wait or join. It runs as its own service (atc-hub.service), so
restarting atc never cuts a call. atc finds it at $ATC_HUB. status says how it stands; reset
starts over, which has the session write a handover note that opens the next one.

Guests (atc guest) get a conversation of their own beside it (@guests, working in ~/guests):
the guest and guest-call channels go there, and its API is under /guests/.

Calls go through the call line at $ATC_CALL_LINE and only ever to $ATC_CALL_NUMBER (default:
the first number in $ATC_WHATSAPP_OWNER). Its words (prompts, how to talk on each channel)
override from ~/.config/atc/modes/; atc prompts prints them.`,
	},
	"voice": {
		what: "calls with the assistant, on this machine; the app calls it over atc, no phone needed.",
		usage: []string{"install [--lang en] [--also tr] [--engine pocket-en] [--tts-url URL] [--voice alba] [--assistant NAME] [--user NAME] [--phone]",
			"status", "uninstall [--purge] [--force]"},
		flags: [][2]string{
			{"--lang, --also", "the call's first language, and others it can switch to (voice/lang/)"},
			{"--engine NAME", "by default what each language needs: pocket-en (CPU) for English, pocket and ahenk (CPU) for Turkish. Also piper or kokoro (English, CPU); higgs needs a GPU and setup by hand. An Intel Mac has no torch for pocket and pocket-en, so piper is its default (docs/calls.md, On a Mac)"},
			{"--tts-url URL", "your own voice server instead of an engine here: anything with OpenAI's /v1/audio/speech and raw PCM (voice/README.md lists its model, rate and key settings)"},
			{"--voice NAME", "the engine's voice; empty is its default"},
			{"--assistant NAME", "the assistant's name in calls"},
			{"--user NAME", "your name in calls"},
			{"--phone", "also run the phone-on-USB line (voice/device/), otherwise only the app line"},
			{"--purge", "uninstall: also remove models, the venv, recordings and voice.env"},
			{"--force", "uninstall: do it during a call"},
		},
		examples: []string{"atc voice install", "atc voice status", "atc voice install --lang tr --also en"},
		more: `install writes the call stack to ~/.local/share/atc/voice, downloads its models
(~/.cache/atc/voice) and voice engine, and starts the services. It runs again safely; a restart
waits for any call to end. Flags are kept in ~/.config/atc/voice.env, with every other setting
(voice/README.md lists them). uninstall stops and removes the services and the stack's files.`,
	},
	"show": {
		what:  "put a page in front of the user, in the session they are reading.",
		usage: []string{"<file|folder> [--as NAME] [--title T] [--note N] [--at ID] [--action NAME='command args']... [--open]", "--list", "--off NAME", "--state NAME [--set]"},
		flags: [][2]string{
			{"--as NAME", "which page this is; defaults to the file's name (a folder's for its index.html). Showing a name again replaces that page. Give each different thing its own name and keep it current, rather than a copy per change"},
			{"--title T", "defaults to the page's <title> or first # heading"},
			{"--note N", "one line on what to look at or decide; it goes in the push"},
			{"--at ID", "open it at one section: the element with that id, scrolled to the top and briefly marked. The push, --open and the card in the transcript all land there. Show again without --at to point back at the top"},
			{"--action NAME='command args'", "a command the page may run with atc.run (repeatable). Showing the page again replaces its actions, so repeat every --action you still want"},
			{"--open", "the assistant only: also open the page on the user's phone screen right away, over whatever is there (a call). Only when they asked to see it, or must; never as a way to get attention"},
			{"--list", "this session's pages"},
			{"--off NAME", "take a page down"},
			{"--state NAME", "the page's data, as JSON (see atc.state); with --set, write it from stdin: an object replaces only the top-level keys"},
			{"--session S", "the session it belongs to, outside a session"},
			{"--project", "keep it with the project this folder is in, for every session in that repo"},
		},
		examples: []string{"atc show report.html --note 'the two red rows'", "atc show ./site --as dashboard", `echo '{"k":1}' | atc show --state picks --set`},
		more:     showMore,
	},
	"pages": {
		what:     "pinned pages, the ones the user keeps.",
		usage:    []string{"", "new <name>", "unpin <name>", "pin <name>", "rm <name>", "show <name> [--note N]", "state <name> [--set]"},
		flags:    [][2]string{{"--note N", "show: one line on what to look at"}, {"--set", "state: write the state from stdin, as atc show --state"}},
		examples: []string{"atc pages", "atc pages new tracker", "atc pages show tracker --note 'two new rows'"},
		more:     pagesMore,
	},
	"board": {
		what:  "the project's board of things to decide.",
		usage: []string{"[--lane LANE] [--json] [--project DIR]", "add <title> [--note N] [--body B] [--url U] [--img FILE|URL] [--as NAME]", "add -"},
		flags: [][2]string{
			{"--note N", "add: one line under the title"},
			{"--body B", "add: the case for it"},
			{"--url U", "add: a link"},
			{"--img FILE|URL", "add: a picture; a local file is copied next to the board"},
			{"--as NAME", "add: sign it as NAME instead of your agent's name or session's title"},
			{"--lane LANE", "only one lane: in, maybe, unsure, unsorted or out"},
			{"--json", "print JSON, with the bodies and links too"},
			{"--project DIR", "another project than the one this folder is in"},
		},
		examples: []string{"atc board", "atc board add 'Use SQLite' --note 'one file, no server'", `echo '[{"title":"A"},{"title":"B"}]' | atc board add -`},
		more:     boardMore,
	},
}
