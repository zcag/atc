package main

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/term"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/server"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/tui"
	"github.com/zcag/atc/web"
)

const usage = `atc: every Claude Code session on a machine, in one place.

SERVER
  atc serve [-addr host:port] [-root DIR]... [-no-auth]
      Serves the web UI and API. New sessions get the flags in $ATC_CLAUDE_ARGS.
  atc token                      print this machine's server token

CLIENT (talks to $ATC_URL, a saved login, or the local server)
  atc                            browse, start and attach in a terminal UI
  atc login <url> <token>        save where the server is
  atc ls [-json]                 live sessions, most urgent first
  atc attach <session>           take over this terminal; Ctrl+Z detaches
  atc history [-json] [query]    past conversations, newest first
  atc new [-n name] [-host machine] [dir] [prompt...]
      dir defaults to the current dir, with your home written as ~ so it
      maps onto the same path under the server's home
  atc resume <session>           bring a stopped or past session back
  atc stop <session>             stop it; the conversation is kept
  atc rm <session>               delete a background session
  atc rename <session> <name>    atc pin|unpin <session>
  atc park|unpark <session>      move it out of the way: bottom of the list, no notifications

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
	host, _ := os.Hostname()
	srv := &server.Server{
		Term: &attach.Hub{Bin: bin},
		Web:  web.FS,
		Host: strings.Split(host, ".")[0],
		M: &sessions.Manager{
			CLI:   claude.CLI{Bin: bin, Args: strings.Fields(os.Getenv("ATC_CLAUDE_ARGS"))},
			Index: history.New(filepath.Join(home, ".claude", "projects")),
			Store: st,
		},
		Roots: roots,
		Voice: server.VoiceFromEnv(),

		AppDir:    os.Getenv("ATC_APP_DIR"),
		AssistDir: os.Getenv("ATC_ASSIST_DIR"),

		TrustTailnet:   tailscaleBin(os.Getenv("ATC_TRUST_TAILNET")),
		TrustedProxies: server.ParseCIDRs(os.Getenv("ATC_TRUSTED_PROXIES")),
	}
	if srv.Peers, err = server.LoadPeers(filepath.Join(client.ConfigDir(), "peers.json")); err != nil {
		return err
	}
	if srv.Push, err = push.Open(filepath.Join(client.ConfigDir(), "devices.json")); err != nil {
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
		return json.NewEncoder(os.Stdout).Encode(list)
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
		return json.NewEncoder(os.Stdout).Encode(list)
	}
	printRows(list)
	return nil
}

func newSession(args []string) error {
	fs := flag.NewFlagSet("new", flag.ExitOnError)
	name := fs.String("n", "", "session name")
	host := fs.String("host", "", "machine to start it on, when the server lists several")
	fs.Parse(args)
	rest := fs.Args()
	dir := ""
	if len(rest) > 0 && (strings.HasPrefix(rest[0], "/") || strings.HasPrefix(rest[0], "~")) {
		dir, rest = rest[0], rest[1:]
	}
	if dir == "" {
		dir = tildePWD()
	}
	id, err := client.Load().StartOn(*host, dir, *name, strings.Join(rest, " "))
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
	s, err := find(c, args[0], cmd != "stop" && cmd != "rm")
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

func attachTo(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: atc attach <session>")
	}
	c := client.Load()
	s, err := find(c, args[0], true)
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

func find(c *client.Client, q string, withPast bool) (sessions.Session, error) {
	pool, err := c.Live()
	if err != nil {
		return sessions.Session{}, err
	}
	if withPast {
		past, err := c.History("", "", 0)
		if err != nil {
			return sessions.Session{}, err
		}
		pool = append(pool, past...)
	}
	return resolve(q, pool)
}

func resolve(q string, pool []sessions.Session) (sessions.Session, error) {
	if n, err := strconv.Atoi(q); err == nil && n >= 1 && n <= len(pool) && len(q) < 4 {
		return pool[n-1], nil
	}
	var hits []sessions.Session
	seen := map[string]bool{}
	for _, pass := range []func(sessions.Session) bool{
		func(s sessions.Session) bool { return s.ID == q || s.SessionID == q },
		func(s sessions.Session) bool { return strings.HasPrefix(s.SessionID, q) },
		func(s sessions.Session) bool { return strings.Contains(strings.ToLower(s.Title), strings.ToLower(q)) },
	} {
		for _, s := range pool {
			if pass(s) && !seen[s.SessionID] {
				seen[s.SessionID] = true
				hits = append(hits, s)
			}
		}
		if len(hits) > 0 {
			break
		}
	}
	switch len(hits) {
	case 0:
		return sessions.Session{}, fmt.Errorf("no session matches %q", q)
	case 1:
		return hits[0], nil
	}
	msg := fmt.Sprintf("%q matches %d sessions:", q, len(hits))
	for _, h := range hits[:min(len(hits), 8)] {
		msg += "\n  " + h.SessionID[:8] + "  " + h.Title
	}
	return sessions.Session{}, fmt.Errorf("%s", msg)
}

var look = map[string]struct{ glyph, word, color string }{
	sessions.NeedsYou: {"●", "needs you", "31"},
	sessions.YourTurn: {"○", "your turn", "33"},
	sessions.Working:  {"◐", "working", "34"},
	sessions.Stopped:  {"◌", "stopped", "2"},
	sessions.Past:     {"·", "past", "2"},
}

func printRows(list []sessions.Session) {
	tty := term.IsTerminal(int(os.Stdout.Fd()))
	paint := func(code, s string) string {
		if !tty {
			return s
		}
		return "\033[" + code + "m" + s + "\033[0m"
	}
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
		if s.LastPrompt != "" {
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
