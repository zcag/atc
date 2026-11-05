package main

import (
	"bufio"
	"cmp"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/caps"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/server"
	"github.com/zcag/atc/internal/settings"
)

const setupHelp = `Usage: atc setup [--yes] [--calls] [--trust-tailnet] [--autonomy LEVEL] [--user NAME] [--assistant NAME] [--language CODE]

Walks through what a new install needs: who you are, Claude Code's status line (how atc learns your
plan limits), atc's tools for your sessions, how to reach atc from other devices, the call characters
and calls. Safe to run again: what is already set stays, and nothing changes without asking.

  --yes             accept every suggestion without asking, except the two below
  --calls           set up calls without asking; about 2 GB, so --yes alone doesn't
  --trust-tailnet   let your own Tailscale devices in without a token; it widens who gets in, so --yes alone doesn't
  --autonomy        what the assistant may do alone: limited, daily (what --yes takes) or full
`

type asker struct {
	in  *bufio.Reader
	yes bool
}

func (a asker) answer() (string, bool) {
	line, err := a.in.ReadString('\n')
	if err != nil && line == "" {
		fmt.Println()
		return "", false
	}
	return strings.TrimSpace(line), true
}

func (a asker) text(q, def string) string {
	if a.yes {
		return def
	}
	if def != "" {
		q += " [" + def + "]"
	}
	fmt.Print(q + ": ")
	line, _ := a.answer()
	return cmp.Or(line, def)
}

func (a asker) confirm(q string) bool {
	if a.yes {
		return true
	}
	fmt.Print(q + " [Y/n] ")
	line, ok := a.answer()
	if !ok {
		fmt.Println("  No answer, so skipped. Run atc setup in a terminal to choose.")
		return false
	}
	line = strings.ToLower(line)
	return line == "" || line == "y" || line == "yes"
}

// consent is a yes that --yes alone doesn't give: for what costs gigabytes or widens who gets in. Without an answer, it is no.
func (a asker) consent(q, flag string, given, byDefault bool) bool {
	if given {
		return true
	}
	if a.yes {
		fmt.Println("  Left out under --yes; " + flag + " asks for it.")
		return false
	}
	options := "[y/N]"
	if byDefault {
		options = "[Y/n]"
	}
	fmt.Print(q + " " + options + " ")
	line, ok := a.answer()
	if !ok {
		fmt.Println("  No answer, so skipped. Run atc setup in a terminal to choose.")
		return false
	}
	line = strings.ToLower(line)
	return line == "y" || line == "yes" || line == "" && byDefault
}

// setupInput is where answers come from. Under curl | sh, stdin is the script's own finished pipe, so the terminal has to
// be opened directly.
func setupInput() io.Reader {
	if st, err := os.Stdin.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
		return os.Stdin
	}
	if tty, err := os.Open("/dev/tty"); err == nil {
		return tty
	}
	return os.Stdin
}

// claudeBin also looks where Claude Code's installer puts it, since that folder is on the services' PATH even when it
// isn't on this shell's yet.
func claudeBin() (string, bool) {
	bin := cmp.Or(os.Getenv("ATC_CLAUDE_BIN"), "claude")
	if _, err := exec.LookPath(bin); err == nil {
		return bin, true
	}
	home, _ := os.UserHomeDir()
	local := filepath.Join(home, ".local", "bin", filepath.Base(bin))
	if _, err := os.Stat(local); err == nil {
		return local, true
	}
	return bin, false
}

func localBinOnPath() bool {
	home, _ := os.UserHomeDir()
	return slices.Contains(filepath.SplitList(os.Getenv("PATH")), filepath.Join(home, ".local", "bin"))
}

func setupCmd(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(setupHelp) }
	yes := fs.Bool("yes", false, "")
	user := fs.String("user", "", "")
	assistant := fs.String("assistant", "", "")
	language := fs.String("language", "", "")
	calls := fs.Bool("calls", false, "")
	trustTailnet := fs.Bool("trust-tailnet", false, "")
	autonomy := fs.String("autonomy", "", "")
	fs.Parse(args)
	a := asker{bufio.NewReader(setupInput()), *yes}

	if !localBinOnPath() {
		fmt.Println("~/.local/bin is not on your PATH, so this shell won't find atc or claude. Add this to your shell's profile and run it here too:")
		fmt.Println(`  export PATH="$HOME/.local/bin:$PATH"`)
	}
	bin, found := claudeBin()
	if !found {
		fmt.Println("Claude Code is not installed. atc runs on it: install it, sign in, and run atc setup again.")
		fmt.Println("  curl -fsSL https://claude.ai/install.sh | bash")
		fmt.Println("atc's page shows the same steps: " + setupLink())
		return nil
	}

	fmt.Println("\nWho the assistant talks to, and what it is called. All optional.")
	f, _ := conf.Load()
	f.User = cmp.Or(*user, a.text("Your name", f.User))
	f.Assistant = cmp.Or(*assistant, a.text("The assistant's name", f.Assistant))
	f.Language = cmp.Or(*language, a.text("The language you speak, as a code like en", f.Language))
	if err := conf.Save(f); err != nil {
		return err
	}
	if f.Language != "" {
		os.Setenv(settings.LanguageKey, f.Language)
	}

	fmt.Println("\nPlan limits. Claude Code tells its status line how much of your plan you have used, and atc reads that.")
	if err := setupStatusLine(a); err != nil {
		fmt.Println("  " + err.Error())
	}

	fmt.Println("\nTools. They let any session see and start other sessions, and let you ask Claude about them.")
	if exec.Command(bin, "mcp", "get", "atc").Run() == nil {
		fmt.Println("  Already added.")
	} else if a.confirm("  Add atc's tools for all your Claude Code sessions?") {
		if err := run(bin, "mcp", "add", "-s", "user", "atc", "--", "atc", "mcp"); err != nil {
			fmt.Println("  That failed; to retry: claude mcp add -s user atc -- atc mcp")
		}
	}

	setupAutonomy(a, *autonomy)
	setupReach(a, *trustTailnet)
	fmt.Println("\nThe Android app. atc offers it to your phone, and updates it from this machine.")
	if a.confirm("  Download it now?") {
		if name, err := fetchApp(appReleases, appDir()); err != nil {
			fmt.Println("  That failed; to retry: atc app update (" + err.Error() + ")")
		} else {
			fmt.Println("  App version " + name + " is ready.")
		}
	}
	fmt.Println("\nThe people on a call: June, Arthur and Tom, each a character in a room. Settings, Persons changes them.")
	if err := ensureCharacters(); err != nil {
		fmt.Println("  The characters could not be downloaded; to retry: atc app characters (" + err.Error() + ")")
	} else {
		fmt.Println("  Ready.")
	}
	setupCalls(a, *calls)
	fmt.Println("\nTo connect the phone app or another computer: atc pair prints a QR code and the text to paste.")
	fmt.Println("\nEverything else (phone, more machines) is in Settings, with what each needs, or run atc doctor.")
	if !caps.SignedIn(context.Background(), bin) {
		fmt.Println("\nClaude Code is not signed in yet, so no session can start. Run this next:")
		fmt.Println("  claude auth login")
	}
	return nil
}

func setupAutonomy(a asker, given string) {
	fmt.Println("\nWhat the assistant may do alone. On a call or on WhatsApp nobody can tap Allow, so what isn't allowed is refused,")
	fmt.Println("and it hands that work to a session, which asks you as usual. Settings, Assistant changes this.")
	fmt.Println("  limited  atc's tools, showing you pages and messaging you")
	fmt.Println("  daily    also reads your files, searches the web and keeps notes in its own folder")
	fmt.Println("  full     anything Claude can do, with no checks: a message that fools it can do real damage")
	f, err := conf.Load()
	if err != nil {
		fmt.Println("  " + err.Error())
		return
	}
	if env := os.Getenv(settings.AutonomyKey); env != "" && f.Env[settings.AutonomyKey] == "" {
		fmt.Println("  Set in atc's environment, which wins: " + env)
		return
	}
	level := given
	if level == "" {
		level = a.text("  Which one", cmp.Or(f.Env[settings.AutonomyKey], settings.AutonomyDaily))
	}
	level = strings.ToLower(strings.TrimSpace(level))
	if !slices.Contains(settings.AutonomyLevels, level) {
		level = settings.AutonomyDaily
		fmt.Println("  That isn't one of them, so daily.")
	}
	if f.Env[settings.AutonomyKey] == level {
		return
	}
	if f.Env == nil {
		f.Env = map[string]string{}
	}
	f.Env[settings.AutonomyKey] = level
	if err := conf.Save(f); err != nil {
		fmt.Println("  " + err.Error())
		return
	}
	restartServices("hub")
}

func setupCalls(a asker, given bool) {
	fmt.Println("\nCalls. Talk to the assistant by voice, from the app or this page. It runs on this machine's CPU.")
	if err := voiceHostError(); err != nil {
		fmt.Println("  " + err.Error())
		return
	}
	if _, err := os.Stat(voiceEnvPath()); err == nil {
		fmt.Println("  Already set up: atc voice status shows how it stands.")
		return
	}
	if !a.consent("  Set them up now? It downloads about 2 GB.", "--calls", given, true) {
		fmt.Println("  To do it later: atc voice install")
		return
	}
	if err := voiceInstall(nil); err != nil {
		fmt.Println("  That failed; to retry: atc voice install (" + err.Error() + ")")
	}
}

func setupStatusLine(a asker) error {
	path := filepath.Join(claude.ConfigDir(), "settings.json")
	cfg := map[string]any{}
	b, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(b, &cfg); err != nil {
			return fmt.Errorf("could not read %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if line, ok := cfg["statusLine"].(map[string]any); ok {
		if cmd, _ := line["command"].(string); strings.Contains(cmd, "limits -tap") {
			fmt.Println("  Already set.")
			return nil
		}
		fmt.Println("  You have your own status line, so it stays. Add this at the start of its script, which passes stdin on to atc:")
		fmt.Printf("    input=$(cat); printf '%%s' \"$input\" | atc limits -tap\n")
		return nil
	}
	if !a.confirm("  Set Claude Code's status line so atc gets your limits?") {
		return nil
	}
	cfg["statusLine"] = map[string]any{"type": "command", "command": "atc limits -tap"}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o600)
}

func setupAddr() string {
	return cmp.Or(os.Getenv("ATC_ADDR"), envFileValue("ATC_ADDR"), client.DefaultListen)
}

func setupPort() string {
	_, port, err := net.SplitHostPort(setupAddr())
	if err != nil || port == "" {
		return "7272"
	}
	return port
}

func setupLink() string {
	tok, _ := serverToken()
	return "http://127.0.0.1:" + setupPort() + "/?token=" + tok
}

// tailnetAddress is the HTTPS address tailscale serve gives this machine.
func tailnetAddress() string {
	out, err := exec.Command("tailscale", "status", "--json").Output()
	if err != nil {
		return ""
	}
	var st struct{ Self struct{ DNSName string } }
	if json.Unmarshal(out, &st) != nil || st.Self.DNSName == "" {
		return ""
	}
	return "https://" + strings.TrimSuffix(st.Self.DNSName, ".")
}

func setupReach(a asker, trustTailnet bool) {
	port := setupPort()
	fmt.Println("\nOn this computer atc is at " + setupLink())
	fmt.Println("\nOther devices. atc answers this machine, your local network and your tailnet, and refuses public addresses.")
	fmt.Println("  Keep atc on a private network, never the public internet: a login is a shell on this machine.")
	if ip := server.ReachableIP(); ip != "" && listensWide(setupAddr()) {
		fmt.Printf("  From your network it is at http://%s:%s, over plain HTTP, so use it only on a network you trust.\n", ip, port)
		fmt.Printf("  To keep atc to this machine, put ATC_ADDR=127.0.0.1:%s in %s and run atc service install.\n", port, filepath.Join(client.ConfigDir(), "env"))
	}
	if os.Getenv("SSH_CONNECTION") != "" {
		fmt.Printf("  You are on ssh. From the computer you came from: ssh -L %s:127.0.0.1:%s <this machine>, then open the link above.\n", port, port)
	}
	fmt.Println("  A browser only gives a page the microphone over HTTPS, which calls need.")
	if _, err := exec.LookPath("tailscale"); err == nil {
		if a.confirm("  Tailscale is here. Serve atc over HTTPS to your own devices?") {
			if err := run("tailscale", "serve", "--bg", port); err != nil {
				fmt.Println("  That failed; to retry: tailscale serve --bg " + port)
			} else if u := tailnetAddress(); u == "" {
				fmt.Println("  Tailscale didn't say this machine's address: enter it in Settings, HTTPS address.")
			} else if err := setUnset(map[string]string{"ATC_PUBLIC_URL": u}, "atc"); err != nil {
				fmt.Println("  " + err.Error())
			}
		}
		fmt.Println("  Your own Tailscale devices can skip the login token. That trusts the device: any program or other user on it gets a full login.")
		if a.consent("  Let them in without a token?", "--trust-tailnet", trustTailnet, false) {
			if err := setUnset(map[string]string{"ATC_TRUST_TAILNET": "1"}, "atc"); err != nil {
				fmt.Println("  " + err.Error())
			}
		}
		return
	}
	fmt.Println("  Easiest is Tailscale (https://tailscale.com): install it, then  tailscale serve --bg " + port)
	fmt.Println("  Or put atc behind a reverse proxy with HTTPS on your own network. Every request needs the login token either way.")
}
