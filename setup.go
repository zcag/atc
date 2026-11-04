package main

import (
	"bufio"
	"cmp"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

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

func (a asker) text(q, def string) string {
	if a.yes {
		return def
	}
	if def != "" {
		q += " [" + def + "]"
	}
	fmt.Print(q + ": ")
	line, _ := a.in.ReadString('\n')
	return cmp.Or(strings.TrimSpace(line), def)
}

func (a asker) confirm(q string) bool {
	if a.yes {
		return true
	}
	fmt.Print(q + " [Y/n] ")
	line, _ := a.in.ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "" || line == "y" || line == "yes"
}

func setupCmd(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(setupHelp) }
	yes := fs.Bool("yes", false, "")
	user := fs.String("user", "", "")
	assistant := fs.String("assistant", "", "")
	language := fs.String("language", "", "")
	fs.Parse(args)
	a := asker{bufio.NewReader(os.Stdin), *yes}

	bin := cmp.Or(os.Getenv("ATC_CLAUDE_BIN"), "claude")
	if _, err := exec.LookPath(bin); err != nil {
		fmt.Println("Claude Code is not installed. atc runs on it: install it, sign in, and run atc setup again.")
		fmt.Println("  curl -fsSL https://claude.ai/install.sh | bash")
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
	fmt.Println("\nTo connect the phone app or another computer: atc pair prints a QR code and the text to paste.")
	fmt.Println("\nEverything else (voice, phone, more machines) is in Settings, with what each needs, or run atc doctor.")
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

func setupReach(a asker) {
	addr := cmp.Or(os.Getenv("ATC_ADDR"), envFileValue("ATC_ADDR"), client.DefaultAddr)
	_, port, ok := strings.Cut(addr, ":")
	if !ok || port == "" {
		port = "7272"
	}
	tok, _ := os.ReadFile(client.ServerTokenPath())
	fmt.Printf("\nOn this computer atc is at http://127.0.0.1:%s/?token=%s\n", port, strings.TrimSpace(string(tok)))
	fmt.Println("\nOther devices. A phone or another computer needs HTTPS for its microphone and the app.")
	if _, err := exec.LookPath("tailscale"); err == nil {
		if a.confirm("  Tailscale is here. Serve atc over HTTPS to your own devices?") {
			if err := run("tailscale", "serve", "--bg", port); err != nil {
				fmt.Println("  That failed; to retry: tailscale serve --bg " + port)
			}
		}
		return
	}
	fmt.Println("  Easiest is Tailscale (https://tailscale.com): install it, then  tailscale serve --bg " + port)
	fmt.Println("  Or put atc behind your own reverse proxy with HTTPS. Every request needs the login token either way.")
}
