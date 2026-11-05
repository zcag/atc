package main

import (
	"bufio"
	"cmp"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/caps"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
)

const setupHelp = `Usage: atc setup [--yes] [--user NAME] [--assistant NAME] [--language CODE]

Walks through what a new install needs: who you are, Claude Code's status line (how atc learns your
plan limits), atc's tools for your sessions, and how to reach atc from other devices. Safe to run
again: what is already set stays, and nothing changes without asking.

  --yes   accept every suggestion without asking
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

	setupReach(a)
	fmt.Println("\nThe Android app. atc offers it to your phone, and updates it from this machine.")
	if a.confirm("  Download it now?") {
		if name, err := fetchApp(appReleases, cmp.Or(os.Getenv("ATC_APP_DIR"), defaultAppDir())); err != nil {
			fmt.Println("  That failed; to retry: atc app update (" + err.Error() + ")")
		} else {
			fmt.Println("  Version " + name + " is ready.")
		}
	}
	fmt.Println("\nTo connect the phone app or another computer: atc pair prints a QR code and the text to paste.")
	fmt.Println("\nEverything else (voice, phone, more machines) is in Settings, with what each needs, or run atc doctor.")
	if !caps.SignedIn(context.Background(), bin) {
		fmt.Println("\nClaude Code is not signed in yet, so no session can start. Run this next:")
		fmt.Println("  claude auth login")
	}
	return nil
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

func setupPort() string {
	addr := cmp.Or(os.Getenv("ATC_ADDR"), envFileValue("ATC_ADDR"), client.DefaultAddr)
	_, port, ok := strings.Cut(addr, ":")
	if !ok || port == "" {
		return "7272"
	}
	return port
}

func setupLink() string {
	tok, _ := serverToken()
	return "http://127.0.0.1:" + setupPort() + "/?token=" + tok
}

func setupReach(a asker) {
	port := setupPort()
	fmt.Println("\nOn this computer atc is at " + setupLink())
	fmt.Println("\nOther devices. A phone or another computer needs HTTPS for its microphone and the app.")
	fmt.Println("  Keep atc on a private network, never the public internet: a login is a shell on this machine.")
	if _, err := exec.LookPath("tailscale"); err == nil {
		if a.confirm("  Tailscale is here. Serve atc over HTTPS to your own devices?") {
			if err := run("tailscale", "serve", "--bg", port); err != nil {
				fmt.Println("  That failed; to retry: tailscale serve --bg " + port)
			}
		}
		return
	}
	fmt.Println("  Easiest is Tailscale (https://tailscale.com): install it, then  tailscale serve --bg " + port)
	fmt.Println("  Or put atc behind a reverse proxy with HTTPS on your own network. Every request needs the login token either way.")
}
