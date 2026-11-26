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
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
	"golang.org/x/term"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/backlog"
	"github.com/zcag/atc/internal/browser"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/llm"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/pair"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/report"
	"github.com/zcag/atc/internal/resources"
	"github.com/zcag/atc/internal/server"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/settings"
	"github.com/zcag/atc/internal/shells"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/summary"
	"github.com/zcag/atc/internal/tools"
	"github.com/zcag/atc/internal/tui"
	limits "github.com/zcag/atc/internal/usage"
	"github.com/zcag/atc/internal/when"
	"github.com/zcag/atc/modes"
	"github.com/zcag/atc/web"
)

var conf *settings.Settings

func loadSettings() {
	if len(os.Args) > 1 && os.Args[1] == "doctor" {
		settings.EnvFile(filepath.Join(client.ConfigDir(), "env"))
	}
	var err error
	if conf, err = settings.Apply(client.ConfigDir()); err != nil {
		log.Printf("atc: %s: %v", conf.Path(), err)
	}
	f, _ := conf.Load()
	modes.User, modes.Assistant = f.User, f.Assistant
	if err := claude.LoadProfiles(profilesPath()); err != nil {
		log.Printf("atc: %v", err)
	}
	for _, p := range claude.Profiles() {
		if err := p.Prepare(); err != nil {
			log.Printf("atc: profile %s: %v", p.Name, err)
		}
	}
}

func main() {
	log.SetFlags(0)
	if len(os.Args) > 1 && helpAsked(os.Args[2:]) {
		if t, ok := helpFor(os.Args[1]); ok {
			fmt.Print(t)
			return
		}
	}
	loadSettings()
	if len(os.Args) < 2 {
		if !term.IsTerminal(int(os.Stdout.Fd())) {
			fmt.Print(topUsage())
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
	case "version", "--version":
		fmt.Println("atc", versionString())
	case "doctor":
		err = doctor(args)
	case "token":
		var tok string
		if tok, err = serverToken(); err == nil {
			fmt.Println(tok)
		}
	case "login":
		err = login(args)
	case "pair":
		err = pairCmd(args)
	case "peer":
		err = peerCmd(args)
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
	case "app":
		err = appCmd(args)
	case "setup":
		err = setupCmd(args)
	case "service":
		err = serviceCmd(args)
	case "prompts":
		err = promptsCmd(args)
	case "mcp":
		err = tools.Run(context.Background(), client.Load())
	case "show":
		err = show(args)
	case "wa":
		err = wa(args)
	case "guest", "guests":
		err = guest(args)
	case "group", "groups":
		err = group(args)
	case "call":
		err = callCmd(args)
	case "hub":
		err = hubCmd(args)
	case "voice":
		err = voiceCmd(args)
	case "notify":
		err = notify(args)
	case "open":
		err = openPage(args)
	case "pages":
		err = pagesCmd(args)
	case "board":
		err = boardCmd(args)
	case "browser":
		err = browserCmd(args)
	case "outputs":
		err = showOutputs(args)
	case "summary":
		err = showSummary(args)
	case "state":
		err = stateCmd(args)
	case "usage":
		err = showUsage(args)
	case "profile", "profiles":
		err = profileCmd(args)
	case "limits":
		err = showLimits(args)
	case "top":
		err = showTop(args)
	case "why":
		err = showWhy(args)
	case "backlog":
		err = backlogCmd(args)
	case "resume", "stop", "rm", "rename", "pin", "unpin", "park", "unpark":
		err = act(cmd, args)
	case "-h", "--help", "help":
		if t, ok := helpFor(strings.Join(args, " ")); ok {
			fmt.Print(t)
		} else {
			fmt.Print(topUsage())
		}
	default:
		fmt.Fprintf(os.Stderr, "atc: unknown command %q\n\n%s", cmd, topUsage())
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
	fs := flags("serve")
	addr := fs.String("addr", cmp.Or(os.Getenv("ATC_ADDR"), client.DefaultListen), "listen address ($ATC_ADDR); by default every interface, answering only private addresses")
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
	modes.Dir = filepath.Join(client.ConfigDir(), "modes")
	history.UseCallLines(callPacks()...)
	history.UseCallStart(func() (string, string) { return modes.Line("call.you_called"), modes.Line("call.reason") })
	st, err := store.Open(filepath.Join(client.ConfigDir(), "meta.json"))
	if err != nil {
		return err
	}
	cli := claude.CLI{Bin: bin, Args: strings.Fields(os.Getenv("ATC_CLAUDE_ARGS"))}
	if _, err := exec.LookPath("systemd-run"); err == nil && os.Getenv("ATC_CONTAIN") == "1" {
		cli.Slice = "claude.slice"
		cli.Launch = []string{"systemd-run", "--user", "--scope", "--collect", "--quiet", "--property=OOMPolicy=continue", "--slice=" + cli.Slice}
	}
	sum, err := summarizer(cli)
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	index := history.New(claude.ProjectRoots()...)
	index.Forks, index.Price = claude.Forks, server.Priced
	srv := &server.Server{
		Term:     &attach.Hub{Bin: bin, Env: func(id string) []string { return claude.ProfileOf(id).Env() }, Asking: server.AskingUser(index), Transcript: server.TranscriptOf(index)},
		Web:      web.FS,
		Host:     strings.Split(host, ".")[0],
		Settings: conf,
		Version:  versionString(),
		M: &sessions.Manager{
			CLI:     cli,
			Index:   index,
			Store:   st,
			Summary: sum,
		},
		Roots: roots,
		Voice: server.VoiceFromEnv(),

		WhatsApp: waClient(),
		Hub:      hubClient(),
		CallLine: os.Getenv("ATC_CALL_LINE"),

		CallTestLine: os.Getenv("ATC_CALL_TEST_LINE"),
		CallNumber:   os.Getenv("ATC_CALL_LINE_NUMBER"),
		CallVoices:   os.Getenv("ATC_CALL_VOICES"),
		Pal:          strings.TrimRight(os.Getenv("ATC_PAL"), "/"),
		PalToken:     os.Getenv("ATC_PAL_TOKEN"),
		CallTestFrom: strings.FieldsFunc(os.Getenv("ATC_CALL_TEST_FROM"), func(r rune) bool { return r == ',' || r == ' ' }),
		PublicURL:    strings.TrimRight(os.Getenv("ATC_PUBLIC_URL"), "/"),
		LocalURL:     loopback(*addr),

		AppDir:    cmp.Or(os.Getenv("ATC_APP_DIR"), defaultAppDir()),
		AgentsDir: cmp.Or(os.Getenv("ATC_AGENTS"), filepath.Join(client.ConfigDir(), "agents.d")),
		StateDir:  client.ConfigDir(),
		Shells:    &shells.Shells{Socket: filepath.Join(client.ConfigDir(), "shells.sock")},
		Res:       resources.New(filepath.Join(client.ConfigDir(), "resources"), claude.Homes()),
		AssistDir: os.Getenv("ATC_ASSIST_DIR"),

		TrustTailnet:   tailscaleBin(os.Getenv("ATC_TRUST_TAILNET")),
		TrustedProxies: server.ParseProxies(os.Getenv("ATC_TRUSTED_PROXIES")),
	}
	seed, _ := voiceFiles.ReadFile("voice/persons.json")
	if err := srv.SeedPersons(seed); err != nil {
		log.Printf("persons: %v", err)
	}
	if os.Getenv("ATC_AGENTS") == "" {
		if err := srv.SeedAgents(starterAgents); err != nil {
			log.Printf("starter agents: %v", err)
		}
	}
	if u := os.Getenv("ATC_OPENCODE"); u != "" {
		srv.M.OC = opencode.New(u, cmp.Or(os.Getenv("ATC_OPENCODE_BIN"), "opencode"))
		if sum != nil {
			sum.Read = map[string]func(sid, reply string) (string, error){opencode.Harness: srv.M.OC.Reply}
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
	srv.Pages.PinAt(filepath.Join(home, ".local/share/atc/pinned"))
	if srv.Backlog, err = backlog.Open(filepath.Join(client.ConfigDir(), "backlog.json")); err != nil {
		return err
	}
	if srv.Paired, err = pair.Open(filepath.Join(client.ConfigDir(), "paired.json")); err != nil {
		return err
	}
	if u := os.Getenv("ATC_BROWSER"); u != "" {
		if srv.Browser, err = browser.Open(strings.TrimRight(u, "/"), filepath.Join(client.ConfigDir(), "browser.json")); err != nil {
			return err
		}
	}
	if !*noAuth {
		if srv.Token, err = serverToken(); err != nil {
			return err
		}
	}
	handler := srv.Handler()
	explicit := os.Getenv("ATC_ADDR") != ""
	fs.Visit(func(f *flag.Flag) { explicit = explicit || f.Name == "addr" })
	if !explicit {
		handler = server.PrivateOnly(handler)
	}
	if listensWide(*addr) {
		srv.Reachable = server.ReachableIP
	}
	log.Printf("atc listening on %s", *addr)
	if srv.Token != "" && term.IsTerminal(int(os.Stderr.Fd())) {
		log.Printf("open %s/?token=%s to log in a browser", loopback(*addr), srv.Token)
	} else if srv.Token != "" {
		log.Printf("run `atc token` for the login token")
	}
	return http.ListenAndServe(*addr, handler)
}

func listensWide(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	return err == nil && (host == "" || host == "0.0.0.0" || host == "::")
}

func hubClient() *hub.Client {
	if os.Getenv("ATC_HUB") == "" {
		return nil
	}
	return hub.NewClient(os.Getenv("ATC_HUB"))
}

func summarizer(cli claude.CLI) (*summary.Summarizer, error) {
	if os.Getenv("ATC_SUMMARY") == "off" {
		return nil, nil
	}
	path := filepath.Join(client.ConfigDir(), "summaries.json")
	if url := os.Getenv("ATC_SUMMARY_URL"); url != "" {
		model := os.Getenv("ATC_SUMMARY_MODEL")
		return summary.Open(path, model, func(ctx context.Context, _, system, user string) (string, error) {
			return llm.Chat(ctx, url, model, system, user, 900, true)
		})
	}
	model := cmp.Or(os.Getenv("ATC_SUMMARY_MODEL"), "haiku")
	return summary.Open(path, model, func(ctx context.Context, transcript, system, user string) (string, error) {
		return cli.PrintAs(ctx, claude.ProfileOfFile(transcript), model, system, user)
	})
}

func loopback(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
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
	fs := flags(name)
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
		fmt.Println("No live sessions. atc new starts one.")
		return nil
	}
	printLines(lsTable(list, painter()))
	need := 0
	for _, s := range list {
		if s.State == sessions.NeedsYou {
			need++
		}
	}
	sum := plural(len(list), "session", "sessions")
	if need > 0 {
		sum += ", " + map[bool]string{true: "1 needs you", false: fmt.Sprintf("%d need you", need)}[need == 1]
	}
	fmt.Printf("\n%s. --json for the full rows.\n", sum)
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
	if len(list) == 0 {
		if q := strings.Join(fs.Args(), " "); q != "" {
			fmt.Printf("No past sessions match %q.\n", q)
		} else {
			fmt.Println("No past sessions.")
		}
		return nil
	}
	printLines(histTable(list))
	return nil
}

func newSession(args []string) error {
	fs := flags("new")
	name := fs.String("n", "", "")
	fs.StringVar(name, "name", "", "")
	host := fs.String("host", "", "machine to start it on, when the server lists several")
	preset := fs.String("p", "", "")
	fs.StringVar(preset, "preset", "", "")
	report := fs.Bool("report", false, "from inside a Claude session: ask the new session to report back to it")
	profile := fs.String("profile", "", "Claude account to run it on (atc profile); default the one its folder belongs to")
	fs.Parse(args)
	rest := fs.Args()
	dir := ""
	if *preset == "" {
		if len(rest) > 0 && (strings.HasPrefix(rest[0], "/") || strings.HasPrefix(rest[0], "~")) {
			dir, rest = rest[0], rest[1:]
		}
		dir = cmp.Or(dir, tildePWD())
	}
	c, l := client.Load(), client.Launch{Host: *host, Dir: dir, Name: *name, Preset: *preset, Prompt: strings.Join(rest, " "), Report: *report, Profile: *profile}
	id, dir, err := c.Launch(context.Background(), l)
	if err != nil {
		return err
	}
	fmt.Printf("Started %s in %s.\n", id, dir)
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
	if sid := os.Getenv("CLAUDE_CODE_SESSION_ID"); len(args) == 0 && sid != "" && (cmd == "park" || cmd == "unpark") {
		args = []string{sid}
	}
	if len(args) < 1 || strings.HasPrefix(args[0], "-") || (cmd == "rename") != (len(args) >= 2) {
		return usageErr(cmd)
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
			fmt.Printf("Resumed %s as %s.\n", s.Title, id)
		}
		return err
	case "stop", "rm":
		if s.ID == "" {
			return fmt.Errorf("%q is not a background session", s.Title)
		}
		if cmd == "rm" {
			err = c.Remove(s.ID)
		} else if me, ok := client.Self(live(c)); ok {
			err = c.Stop(s.ID, "session", me.Title)
		} else {
			err = c.Stop(s.ID, "cli", "")
		}
	case "rename":
		name := strings.TrimSpace(strings.Join(args[1:], " "))
		if err = c.Patch(s.SessionID, map[string]any{"name": name}); err == nil {
			fmt.Printf("Renamed %s to %s.\n", s.Title, name)
		}
		return err
	case "park", "unpark":
		err = c.Patch(s.SessionID, map[string]any{"parked": cmd == "park"})
	default:
		err = c.Patch(s.SessionID, map[string]any{"pinned": cmd == "pin"})
	}
	if err == nil {
		fmt.Printf("%s %s.\n", map[string]string{"stop": "Stopped", "rm": "Deleted", "park": "Parked", "unpark": "Unparked", "pin": "Pinned", "unpin": "Unpinned"}[cmd], s.Title)
	}
	return err
}

func live(c *client.Client) []sessions.Session {
	l, _ := c.Live()
	return l
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func backlogCmd(args []string) error {
	c := client.Load()
	if len(args) == 0 {
		items, err := c.Backlog()
		if err != nil {
			return err
		}
		var rows [][]string
		for _, it := range items {
			if it.Status != backlog.Done {
				state := it.Status
				if it.Aside {
					state = "set aside"
				}
				rows = append(rows, []string{it.ID, state, clip(it.Title, 60), it.Dir})
			}
		}
		if len(rows) == 0 {
			fmt.Println("The backlog is empty.")
			return nil
		}
		printLines(table([]string{"Id", "State", "Title", "Folder"}, rows, nil, nil, painter()))
		return nil
	}
	s, err := c.Find(args[0], true)
	if err != nil {
		return err
	}
	it, err := c.Shelve(s.SessionID, strings.Join(args[1:], " "))
	if err == nil {
		fmt.Printf("Put %s on the backlog as %s.\n", s.Title, it.ID)
	}
	return err
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
		return usageErr("outputs")
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
		return usageErr("summary")
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
		printLines(append([]string{s.Title, ""}, report.Session(st, c.WeekRate())...))
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
	printLines(report.Plan(l, days, c.WeekRate(), time.Now()))
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
	fs := flags("send")
	report := fs.Bool("report", false, "from inside a Claude session: ask it to answer this session")
	wake := fs.Bool("wake", false, "from inside a Claude session: resume it although it is stopped and not waiting on this session")
	approved := fs.Bool("approved", false, "from the assistant only: this relays the user's own go-ahead, so it counts as their approval")
	fs.Parse(args)
	args = fs.Args()
	if len(args) < 1 {
		usageExit("send")
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
	if agent, ok := strings.CutPrefix(args[0], "@"); ok {
		live, _ := c.Live()
		signed, err := client.Signed(live, client.Sign{Report: *report, Approved: *approved}, text)
		if err != nil {
			return err
		}
		if _, err = c.Message(agent, signed); err == nil {
			fmt.Printf("Sent to @%s.\n", agent)
		}
		return err
	}
	s, err := c.Find(args[0], true)
	if err != nil {
		return err
	}
	d, err := c.Deliver(context.Background(), s, text, *report, *wake, *approved)
	switch {
	case err != nil:
	case d.Held:
		fmt.Printf("%s is waiting on an answer to a question; it gets this once that is answered.\n", s.Title)
	case d.Resumed:
		fmt.Printf("Resumed %s and sent it the message.\n", s.Title)
	default:
		fmt.Printf("Sent to %s.\n", s.Title)
	}
	return err
}

func attachTo(args []string) error {
	if len(args) != 1 {
		return usageErr("attach")
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

var looks = map[string]struct{ letter, word, color string }{
	sessions.NeedsYou: {"N", "needs", "48;5;214;38;5;235;1"},
	sessions.YourTurn: {"T", "turn", "7;1"},
	sessions.Working:  {"W", "working", "38;5;24;48;5;153;1"},
	sessions.Stopped:  {"E", "stopped", "2"},
	sessions.Past:     {"E", "past", "2"},
}

func tags(s sessions.Session) string {
	var t []string
	if s.Kind == "interactive" {
		t = append(t, "in a terminal")
	}
	if s.Agent != "" {
		t = append(t, "@"+s.Agent)
	}
	if s.Profile != "" {
		t = append(t, s.Profile)
	}
	if s.Pinned {
		t = append(t, "pinned")
	}
	if s.Parked {
		t = append(t, "parked")
	}
	return strings.Join(t, " · ")
}

func lsTable(list []sessions.Session, paint func(code, s string) string) []string {
	several := len(hostsOf(list)) > 1
	heads := []string{"#", "State", "Title", "Bay", "Branch", "Age"}
	if several {
		heads = []string{"#", "State", "Title", "Host", "Bay", "Branch", "Age"}
	}
	var rows [][]string
	var states []string
	for i, s := range list {
		l, ok := looks[s.State]
		if !ok {
			l = looks[sessions.Past]
		}
		word := l.word
		if s.Away() {
			word = "parked"
		}
		title := clip(s.Title, 44)
		if t := tags(s); t != "" {
			title += "  " + t
		}
		branch := s.Branch
		if branch == "HEAD" {
			branch = ""
		}
		row := []string{fmt.Sprint(i + 1), " " + l.letter + "  " + word, title, s.Bay(), clip(branch, 28), s.Age()}
		if several {
			row = slices.Insert(row, 3, s.Host)
		}
		rows = append(rows, row)
		states = append(states, s.State)
	}
	return table(heads, rows, map[int]bool{0: true, len(heads) - 1: true}, func(r, c int, cell string) string {
		if c != 1 {
			return cell
		}
		l, ok := looks[states[r]]
		if !ok {
			l = looks[sessions.Past]
		}
		return paint(l.color, " "+l.letter+" ") + strings.TrimPrefix(cell, " "+l.letter+" ")
	}, paint)
}

func table(heads []string, rows [][]string, right map[int]bool, cell func(r, c int, s string) string, paint func(code, s string) string) []string {
	w := make([]int, len(heads))
	for c, h := range heads {
		w[c] = ansi.StringWidth(h)
	}
	for _, r := range rows {
		for c, v := range r {
			w[c] = max(w[c], ansi.StringWidth(v))
		}
	}
	pad := func(c int, s string) string {
		gap := strings.Repeat(" ", w[c]-ansi.StringWidth(s))
		if right[c] {
			return gap + s
		}
		return s + gap
	}
	var hs []string
	for c, h := range heads {
		hs = append(hs, pad(c, h))
	}
	out := []string{paint("2", strings.TrimRight(strings.Join(hs, "  "), " "))}
	for r, row := range rows {
		var cs []string
		for c, v := range row {
			p := pad(c, v)
			if cell != nil {
				p = cell(r, c, p)
			}
			cs = append(cs, p)
		}
		out = append(out, strings.TrimRight(strings.Join(cs, "  "), " "))
	}
	return out
}

func histTable(list []sessions.Session) []string {
	several := len(hostsOf(list)) > 1
	heads := []string{"Id", "Last", "Title", "Bay"}
	if several {
		heads = append(heads, "Host")
	}
	now := time.Now()
	var rows [][]string
	for _, s := range list {
		row := []string{s.SessionID[:min(8, len(s.SessionID))], when.Stamp(s.Last().Local(), now), clip(s.Title, 50), s.Bay()}
		if several {
			row = append(row, s.Host)
		}
		rows = append(rows, row)
	}
	return table(heads, rows, nil, nil, painter())
}

func hostsOf(list []sessions.Session) map[string]bool {
	m := map[string]bool{}
	for _, s := range list {
		if s.Host != "" {
			m[s.Host] = true
		}
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
