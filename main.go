package main

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/llm"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/report"
	"github.com/zcag/atc/internal/server"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/summary"
	"github.com/zcag/atc/internal/tools"
	"github.com/zcag/atc/internal/tui"
	limits "github.com/zcag/atc/internal/usage"
	"github.com/zcag/atc/web"
)

const usage = `atc: every Claude Code session on a machine, in one place.

SERVER
  atc serve [-addr host:port] [-root DIR]... [-no-auth]
      Serves the web UI and API. New sessions get the flags in $ATC_CLAUDE_ARGS.
      A finished turn's final message is summarized with claude -p and haiku
      ($ATC_SUMMARY_MODEL), or an OpenAI-compatible model at $ATC_SUMMARY_URL;
      ATC_SUMMARY=off turns it off.
  atc token                      print this machine's server token

CLIENT (talks to $ATC_URL, a saved login, or the local server)
  atc                            browse, start and attach in a terminal UI
  atc login <url> <token>        save where the server is
  atc ls [-json]                 live sessions, most urgent first
  atc attach <session>           take over this terminal; Ctrl+Z detaches
  atc history [-json] [query]    past conversations, newest first
  atc new [-n name] [-host machine] [dir] [prompt...]
  atc new -p preset [prompt...]  start from a preset (presets.json in the server's config folder)
      dir defaults to the current dir, with your home written as ~ so it
      maps onto the same path under the server's home
  atc send <session> [text...]   type a message into a running session; reads
                                 stdin when no text is given (cmd | atc send 2)
  atc mcp                        tools for Claude to see and drive your other sessions
                                 (MCP over stdio): claude mcp add atc -- atc mcp
  atc resume <session>           bring a stopped or past session back
  atc stop <session>             stop it; the conversation is kept
  atc rm <session>               delete a background session
  atc rename <session> <name>    atc pin|unpin <session>
  atc park|unpark <session>      move it out of the way: bottom of the list, no notifications
  atc summary [-json] [-again] <session>
                                 its final message in short: a status line, the gist and
                                 an overview; -again summarizes it anew
  atc show <file> [--as name] [--title T] [--note N]
                                 from inside a session: show the user a page (HTML, image,
                                 markdown, PDF) beside the conversation, live as the file
                                 changes; atc show -h for the full reference
  atc outputs [-json] <session>  what it produced: running servers, files (with a link to
                                 open each in a browser), links, code it touched
  atc usage [-json] [session]    plan limits and tokens per day; with a session, its tokens,
                                 models, turns and working time, with an estimated API cost
  atc limits [-json] [-short]    plan limits, one line each; -short fits a status line
  atc limits -tap                record the limits from Claude Code's status line input (stdin),
                                 so atc shows them without asking Anthropic

<session> is a row number from ls, a short id, a session id prefix, or a
unique piece of the title.
`

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		if !term.IsTerminal(int(os.Stdout.Fd())) {
			fmt.Print(usage)
			os.Exit(2)
		}
		if err := tui.Run(client.Load()); err != nil {
			log.Fatalf("atc: %v", err)
		}
		return
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = serve(args)
	case "token":
		var tok string
		if tok, err = serverToken(); err == nil {
			fmt.Println(tok)
		}
	case "login":
		if len(args) != 2 {
			log.Fatal("usage: atc login <url> <token>")
		}
		err = client.SaveLogin(args[0], args[1])
	case "ls", "list":
		err = ls(args)
	case "history":
		err = hist(args)
	case "new":
		err = newSession(args)
	case "attach":
		err = attachTo(args)
	case "send":
		err = sendTo(args)
	case "mcp":
		err = tools.Run(context.Background(), client.Load())
	case "show":
		err = show(args)
	case "outputs":
		err = showOutputs(args)
	case "summary":
		err = showSummary(args)
	case "usage":
		err = showUsage(args)
	case "limits":
		err = showLimits(args)
	case "resume", "stop", "rm", "rename", "pin", "unpin", "park", "unpark":
		err = act(cmd, args)
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "atc: unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		log.Fatalf("atc: %v", err)
	}
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", cmp.Or(os.Getenv("ATC_ADDR"), client.DefaultAddr), "listen address ($ATC_ADDR)")
	noAuth := fs.Bool("no-auth", false, "serve without a token (only behind something that authenticates)")
	var roots multi
	fs.Var(&roots, "root", "dir whose subdirs are offered for new sessions (repeatable, or $ATC_ROOTS separated by :)")
	fs.Parse(args)
	if len(roots) == 0 && os.Getenv("ATC_ROOTS") != "" {
		roots = strings.Split(os.Getenv("ATC_ROOTS"), ":")
	}

	home, _ := os.UserHomeDir()
	if len(roots) == 0 {
		roots = multi{home}
		if st, err := os.Stat(filepath.Join(home, "proj")); err == nil && st.IsDir() {
			roots = multi{filepath.Join(home, "proj"), home}
		}
	}
	bin := os.Getenv("ATC_CLAUDE_BIN")
	if bin == "" {
		bin = "claude"
	}
	st, err := store.Open(filepath.Join(client.ConfigDir(), "meta.json"))
	if err != nil {
		return err
	}
	cli := claude.CLI{Bin: bin, Args: strings.Fields(os.Getenv("ATC_CLAUDE_ARGS"))}
	sum, err := summarizer(cli)
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	index := history.New(filepath.Join(claude.ConfigDir(), "projects"))
	index.Forks, index.Price = claude.Forks, server.Priced
	srv := &server.Server{
		Term: &attach.Hub{Bin: bin},
		Web:  web.FS,
		Host: strings.Split(host, ".")[0],
		M: &sessions.Manager{
			CLI:     cli,
			Index:   index,
			Store:   st,
			Summary: sum,
		},
		Roots: roots,
		Voice: server.VoiceFromEnv(),

		AppDir:    os.Getenv("ATC_APP_DIR"),
		StateDir:  client.ConfigDir(),
		AssistDir: os.Getenv("ATC_ASSIST_DIR"),

		TrustTailnet:   tailscaleBin(os.Getenv("ATC_TRUST_TAILNET")),
		TrustedProxies: server.ParseProxies(os.Getenv("ATC_TRUSTED_PROXIES")),
	}
	if u := os.Getenv("ATC_OPENCODE"); u != "" {
		srv.M.OC = opencode.New(u, cmp.Or(os.Getenv("ATC_OPENCODE_BIN"), "opencode"))
		if sum != nil {
			sum.Read = map[string]func(sid, reply string) (string, error){opencode.Harness: srv.M.OC.Reply}
		}
	}
	if f := os.Getenv("ATC_FEATURED"); f != "" {
		if srv.Featured, err = regexp.Compile(f); err != nil {
			return fmt.Errorf("ATC_FEATURED: %w", err)
		}
	}
	if srv.Presets, err = server.LoadPresets(filepath.Join(client.ConfigDir(), "presets.json")); err != nil {
		return err
	}
	if srv.Engines, err = server.LoadEngines(filepath.Join(client.ConfigDir(), "engines.json")); err != nil {
		return err
	}
	if srv.Peers, err = server.LoadPeers(filepath.Join(client.ConfigDir(), "peers.json")); err != nil {
		return err
	}
	if srv.Push, err = push.Open(filepath.Join(client.ConfigDir(), "devices.json")); err != nil {
		return err
	}
	if srv.Pages, err = pages.Open(filepath.Join(client.ConfigDir(), "pages.json")); err != nil {
		return err
	}
	if !*noAuth {
		if srv.Token, err = serverToken(); err != nil {
			return err
		}
	}
	log.Printf("atc listening on http://%s", *addr)
	if srv.Token != "" && term.IsTerminal(int(os.Stderr.Fd())) {
		log.Printf("open http://%s/?token=%s to log in a browser", *addr, srv.Token)
	} else if srv.Token != "" {
		log.Printf("run `atc token` for the login token")
	}
	return http.ListenAndServe(*addr, srv.Handler())
}

func summarizer(cli claude.CLI) (*summary.Summarizer, error) {
	if os.Getenv("ATC_SUMMARY") == "off" {
		return nil, nil
	}
	path := filepath.Join(client.ConfigDir(), "summaries.json")
	if url := os.Getenv("ATC_SUMMARY_URL"); url != "" {
		model := os.Getenv("ATC_SUMMARY_MODEL")
		return summary.Open(path, model, func(ctx context.Context, system, user string) (string, error) {
			return llm.Chat(ctx, url, model, system, user, 900, true)
		})
	}
	model := cmp.Or(os.Getenv("ATC_SUMMARY_MODEL"), "haiku")
	return summary.Open(path, model, func(ctx context.Context, system, user string) (string, error) {
		return cli.Print(ctx, model, system, user)
	})
}

func tailscaleBin(v string) string {
	if v != "1" && v != "true" {
		return ""
	}
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	return "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
}

func serverToken() (string, error) {
	p := client.ServerTokenPath()
	if b, err := os.ReadFile(p); err == nil {
		return strings.TrimSpace(string(b)), nil
	}
	b := make([]byte, 24)
	rand.Read(b)
	tok := hex.EncodeToString(b)
	os.MkdirAll(filepath.Dir(p), 0o700)
	return tok, os.WriteFile(p, []byte(tok+"\n"), 0o600)
}

func jsonFlag(name string, args []string) (*flag.FlagSet, *bool) {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	return fs, fs.Bool("json", false, "print JSON")
}

func ls(args []string) error {
	fs, asJSON := jsonFlag("ls", args)
	fs.Parse(args)
	list, err := client.Load().Live()
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(list)
	}
	if len(list) == 0 {
		fmt.Println("no sessions")
	}
	printRows(list)
	return nil
}

func hist(args []string) error {
	fs, asJSON := jsonFlag("history", args)
	fs.Parse(args)
	list, err := client.Load().History(strings.Join(fs.Args(), " "), "", 30)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(list)
	}
	printRows(list)
	return nil
}

func newSession(args []string) error {
	fs := flag.NewFlagSet("new", flag.ExitOnError)
	name := fs.String("n", "", "session name")
	host := fs.String("host", "", "machine to start it on, when the server lists several")
	preset := fs.String("p", "", "start from a named preset")
	fs.Parse(args)
	rest := fs.Args()
	c := client.Load()
	live, _ := c.Live()
	if *preset != "" {
		id, dir, err := c.StartPreset(*preset, client.Signed(live, true, strings.Join(rest, " ")))
		if err == nil {
			fmt.Printf("started %s (%s) in %s\n", id, *preset, dir)
		}
		return err
	}
	dir := ""
	if len(rest) > 0 && (strings.HasPrefix(rest[0], "/") || strings.HasPrefix(rest[0], "~")) {
		dir, rest = rest[0], rest[1:]
	}
	if dir == "" {
		dir = tildePWD()
	}
	id, err := c.StartOn(*host, dir, *name, client.Signed(live, true, strings.Join(rest, " ")), false)
	if err != nil {
		return err
	}
	fmt.Printf("started %s in %s\n", id, dir)
	return nil
}

func tildePWD() string {
	wd, _ := os.Getwd()
	home, _ := os.UserHomeDir()
	if wd == home {
		return "~"
	}
	if rel, ok := strings.CutPrefix(wd, home+"/"); ok {
		return "~/" + rel
	}
	return wd
}

func act(cmd string, args []string) error {
	if len(args) < 1 || (cmd == "rename") != (len(args) >= 2) {
		return fmt.Errorf("usage: atc %s <session>%s", cmd, map[bool]string{true: " <name>"}[cmd == "rename"])
	}
	c := client.Load()
	s, err := c.Find(args[0], cmd != "stop" && cmd != "rm")
	if err != nil {
		return err
	}
	switch cmd {
	case "resume":
		id, err := c.Resume(s.SessionID)
		if err == nil {
			fmt.Printf("resumed %s as %s\n", s.Title, id)
		}
		return err
	case "stop", "rm":
		if s.ID == "" {
			return fmt.Errorf("%q is not a background session", s.Title)
		}
		if cmd == "stop" {
			return c.Stop(s.ID)
		}
		return c.Remove(s.ID)
	case "rename":
		return c.Patch(s.SessionID, map[string]any{"name": strings.Join(args[1:], " ")})
	case "park", "unpark":
		return c.Patch(s.SessionID, map[string]any{"parked": cmd == "park"})
	default:
		return c.Patch(s.SessionID, map[string]any{"pinned": cmd == "pin"})
	}
}

func printJSON(v any) error { return json.NewEncoder(os.Stdout).Encode(v) }

func printLines(lines []string) {
	for _, l := range lines {
		fmt.Println(l)
	}
}

func showOutputs(args []string) error {
	fs, asJSON := jsonFlag("outputs", args)
	fs.Parse(args)
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: atc outputs [-json] <session>")
	}
	c := client.Load()
	s, err := c.Find(fs.Arg(0), true)
	if err != nil {
		return err
	}
	o, err := c.Outputs(s.SessionID)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(o)
	}
	printLines(report.Outputs(o, s.Host, time.Now()))
	return nil
}

func showSummary(args []string) error {
	fs, asJSON := jsonFlag("summary", args)
	again := fs.Bool("again", false, "summarize the final message again")
	fs.Parse(args)
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: atc summary [-json] [-again] <session>")
	}
	c := client.Load()
	s, err := c.Find(fs.Arg(0), true)
	if err != nil {
		return err
	}
	if s.State == sessions.Working {
		return fmt.Errorf("%q is still working; there is no final message yet", s.Title)
	}
	r, err := c.Summary(s.SessionID, 45, *again)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(r)
	}
	switch {
	case r.Summary != nil:
		printLines(summaryLines(r.Summary, painter()))
	case r.Summarizing:
		return fmt.Errorf("still summarizing %q, try again in a moment", s.Title)
	default:
		return fmt.Errorf("%q has no final message to summarize", s.Title)
	}
	return nil
}

func summaryLines(x *summary.Summary, paint func(code, s string) string) []string {
	out := []string{paint("1", x.Status)}
	if len(x.Gist) > 0 {
		out = append(out, "")
		for _, l := range x.Gist {
			out = append(out, "  • "+l)
		}
	}
	if len(x.Overview) > 0 {
		out = append(out, "")
		for _, l := range x.Overview {
			out = append(out, paint("2", "  "+l))
		}
	}
	return out
}

func painter() func(code, s string) string {
	tty := term.IsTerminal(int(os.Stdout.Fd()))
	return func(code, s string) string {
		if !tty {
			return s
		}
		return "\033[" + code + "m" + s + "\033[0m"
	}
}

func showUsage(args []string) error {
	fs, asJSON := jsonFlag("usage", args)
	fs.Parse(args)
	c := client.Load()
	if fs.NArg() > 0 {
		s, err := c.Find(strings.Join(fs.Args(), " "), true)
		if err != nil {
			return err
		}
		st, err := c.SessionUsage(s.SessionID)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(st)
		}
		printLines(append([]string{s.Title, ""}, report.Session(st)...))
		return nil
	}
	l, err := c.Limits()
	if err != nil {
		return err
	}
	days, err := c.Days(14)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(map[string]any{"limits": l, "days": days})
	}
	printLines(report.Plan(l, days, time.Now()))
	return nil
}

func showLimits(args []string) error {
	fs, asJSON := jsonFlag("limits", args)
	short := fs.Bool("short", false, "one line, for a status line or prompt")
	tap := fs.Bool("tap", false, "record the limits in Claude Code's status line input on stdin")
	fs.Parse(args)
	if *tap {
		return limits.Tap(os.Stdin)
	}
	l, err := client.Load().Limits()
	if err != nil {
		return err
	}
	switch {
	case *asJSON:
		return printJSON(l)
	case *short:
		fmt.Println(report.LimitsShort(l.Windows, time.Now()))
	case len(l.Windows) == 0:
		fmt.Println(report.LimitsNote(l, time.Now()))
	default:
		printLines(report.LimitLines(l.Windows, time.Now()))
	}
	return nil
}

func sendTo(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: atc send <session> [text...]")
	}
	text := strings.Join(args[1:], " ")
	if text == "" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		text = string(b)
	}
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("nothing to send")
	}
	c := client.Load()
	s, err := c.Find(args[0], false)
	if err != nil {
		return err
	}
	if !s.Attachable {
		return fmt.Errorf("%q is not running in the background; resume it first", s.Title)
	}
	live, _ := c.Live()
	return c.Send(s.ID, client.Signed(live, false, text))
}

func attachTo(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: atc attach <session>")
	}
	c := client.Load()
	s, err := c.Find(args[0], true)
	if err != nil {
		return err
	}
	id := s.ID
	switch {
	case s.Attachable:
	case s.Kind == "interactive":
		return fmt.Errorf("%s runs in a terminal elsewhere, so it cannot be attached", s.Title)
	default:
		fmt.Printf("%s is not running. Resume it? [Y/n] ", s.Title)
		var ans string
		fmt.Scanln(&ans)
		if strings.HasPrefix(strings.ToLower(ans), "n") {
			return nil
		}
		if id, err = c.Resume(s.SessionID); err != nil {
			return err
		}
	}
	if err := c.Attach(id); err != nil {
		return err
	}
	fmt.Println(c.Detached(id, s.Title))
	return nil
}

var look = map[string]struct{ glyph, word, color string }{
	sessions.NeedsYou: {"●", "needs you", "31"},
	sessions.YourTurn: {"○", "your turn", "33"},
	sessions.Working:  {"◐", "working", "34"},
	sessions.Stopped:  {"◌", "stopped", "2"},
	sessions.Past:     {"·", "past", "2"},
}

func printRows(list []sessions.Session) {
	paint := painter()
	home := client.Load().ServerHome()
	for i, s := range list {
		l, ok := look[s.State]
		if !ok {
			l = look[sessions.Past]
			l.word = s.State
		}
		var tags []string
		if s.Kind == "interactive" {
			tags = append(tags, "in a terminal")
		}
		if s.Pinned {
			tags = append(tags, "pinned")
		}
		where := sessions.Tilde(s.Cwd, home)
		if s.Host != "" && len(hostsOf(list)) > 1 {
			where = s.Host + ":" + where
		}
		if s.Branch != "" && s.Branch != "HEAD" {
			where += " · " + s.Branch
		}
		fmt.Printf("%3d %s %-10s %-44s %5s  %s\n", i+1, paint(l.color, l.glyph), paint(l.color, l.word),
			clip(s.Title, 44), s.Age(), paint("2", strings.Join(append([]string{where}, tags...), " · ")))
		switch {
		case s.Summary != nil && s.State == sessions.YourTurn:
			fmt.Printf("%17s%s\n", "", "↳ "+clip(s.Summary.Status, 70))
		case s.LastPrompt != "":
			fmt.Printf("%17s%s\n", "", paint("2", "“"+clip(oneLine(s.LastPrompt), 70)+"”"))
		}
	}
}

func hostsOf(list []sessions.Session) map[string]bool {
	m := map[string]bool{}
	for _, s := range list {
		m[s.Host] = true
	}
	return m
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
