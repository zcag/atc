package main

import (
	"bytes"
	"cmp"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/zcag/atc/internal/client"
)

//go:embed deploy/atc.service deploy/atc-hub.service deploy/claude.slice deploy/atc.plist
var units embed.FS

const serviceHelp = `Usage: atc service <install|uninstall|status> [--only atc|hub]

  install     copy this binary to ~/.local/bin and run atc (and the assistant's hub) as services
              of your user: systemd on Linux, launchd on macOS. Safe to run again to upgrade:
              sessions keep running, and a restart waits for a call to end.
  uninstall   stop and remove the services; your settings and sessions stay
  status      whether each one runs

  --only      one of them; by default both
`

const macLabel = "io.github.zcag.atc"

type service struct{ name, bin, unit string }

func services(only string) []service {
	all := []service{{"atc", "atc", "atc"}, {"hub", "atc-hub", "atc-hub"}}
	return slices.DeleteFunc(all, func(s service) bool { return only != "" && s.name != only })
}

func serviceCmd(args []string) error {
	if len(args) == 0 {
		fmt.Print(serviceHelp)
		os.Exit(2)
	}
	fs := flag.NewFlagSet("service", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(serviceHelp) }
	only := fs.String("only", "", "")
	fs.Parse(args[1:])
	if *only != "" && *only != "atc" && *only != "hub" {
		return fmt.Errorf("--only takes atc or hub")
	}
	mac := runtime.GOOS == "darwin"
	if !mac {
		if _, err := exec.LookPath("systemctl"); err != nil || exec.Command("systemctl", "--user", "show-environment").Run() != nil {
			fmt.Println("No systemd for your user here, so atc can't run as a service. Start it yourself with: atc serve")
			if args[0] == "install" {
				return installOnly(services(*only))
			}
			return nil
		}
	}
	list := services(*only)
	switch args[0] {
	case "install":
		return serviceInstall(list, mac, *only == "")
	case "uninstall":
		for _, s := range list {
			if mac {
				macUnload(s)
				os.Remove(macPlist(s))
			} else {
				run("systemctl", "--user", "disable", "--now", s.unit)
				os.Remove(systemdUnit(s.unit + ".service"))
			}
			fmt.Println("removed", s.name)
		}
		if !mac {
			return run("systemctl", "--user", "daemon-reload")
		}
		return nil
	case "status":
		for _, s := range list {
			fmt.Printf("%-4s %s\n", s.name, serviceState(s, mac))
		}
		return nil
	}
	fmt.Print(serviceHelp)
	os.Exit(2)
	return nil
}

func installOnly(list []service) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755); err != nil {
		return err
	}
	for _, s := range list {
		if err := installBinary(exe, filepath.Join(home, ".local", "bin", s.bin)); err != nil {
			return err
		}
	}
	return nil
}

func serviceState(s service, mac bool) string {
	if mac {
		return macState(s)
	}
	out, _ := exec.Command("systemctl", "--user", "is-active", s.unit).Output()
	return strings.TrimSpace(string(out))
}

func serviceInstall(list []service, mac, everything bool) error {
	if err := installOnly(list); err != nil {
		return err
	}
	if everything {
		if err := writeEnvDefaults(); err != nil {
			return err
		}
	}
	if !mac {
		if err := installSystemdFiles(list); err != nil {
			return err
		}
		if everything {
			if user := os.Getenv("USER"); user != "" && exec.Command("loginctl", "enable-linger", user).Run() != nil {
				fmt.Println("Could not keep services running after you log out: run  sudo loginctl enable-linger " + user)
			}
		}
	}
	waitForNoCall()
	for _, s := range list {
		if mac {
			if err := macInstall(s); err != nil {
				return err
			}
		} else if err := systemdStart(s); err != nil {
			return err
		}
		state := serviceState(s, mac)
		if _, found := claudeBin(); s.name == "hub" && !found {
			state = "waits for Claude Code, and starts by itself once it is installed"
		}
		fmt.Printf("%s: %s\n", s.name, state)
	}
	return nil
}

func installBinary(from, to string) error {
	if same, _ := filepath.EvalSymlinks(from); same == to {
		return nil
	}
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	tmp := to + ".new"
	if err := os.WriteFile(tmp, b, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, to)
}

func systemdUnit(name string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", name)
}

func installSystemdFiles(list []service) error {
	names := []string{"claude.slice"}
	for _, s := range list {
		names = append(names, s.unit+".service")
	}
	if err := os.MkdirAll(filepath.Dir(systemdUnit("x")), 0o755); err != nil {
		return err
	}
	for _, n := range names {
		b, err := units.ReadFile("deploy/" + n)
		if err != nil {
			return err
		}
		if err := os.WriteFile(systemdUnit(n), b, 0o644); err != nil {
			return err
		}
	}
	return run("systemctl", "--user", "daemon-reload")
}

func systemdStart(s service) error {
	if err := run("systemctl", "--user", "enable", s.unit); err != nil {
		return err
	}
	return run("systemctl", "--user", "restart", s.unit)
}

func macName(s service) string {
	if s.name == "atc" {
		return macLabel
	}
	return macLabel + "." + s.name
}

func macDomain() string { return "gui/" + strconv.Itoa(os.Getuid()) }

func macPlist(s service) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", macName(s)+".plist")
}

func macUnload(s service) {
	target := macDomain() + "/" + macName(s)
	exec.Command("launchctl", "bootout", target).Run()
	for range 100 {
		if exec.Command("launchctl", "print", target).Run() != nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// macState is launchd's word for it: a job that keeps crashing is loaded but not "running".
func macState(s service) string {
	out, err := exec.Command("launchctl", "print", macDomain()+"/"+macName(s)).Output()
	if err != nil {
		return "not running"
	}
	if m := regexp.MustCompile(`(?m)^\s*state = (.+)$`).FindSubmatch(out); m != nil && string(m[1]) != "running" {
		return string(m[1])
	}
	return "running"
}

func macInstall(s service) error {
	b, err := units.ReadFile("deploy/atc.plist")
	if err != nil {
		return err
	}
	if s.name != "atc" {
		b = macRelabel(b, s)
		b = bytes.ReplaceAll(b, []byte(`"$HOME/.local/bin/atc" serve`), []byte(`"$HOME/.local/bin/`+s.bin+`" hub`))
	}
	return macLoad(s, b)
}

// macRelabel makes atc's plist another job's: its label and its log.
func macRelabel(plist []byte, s service) []byte {
	plist = bytes.ReplaceAll(plist, []byte("<string>"+macLabel+"</string>"), []byte("<string>"+macName(s)+"</string>"))
	return bytes.ReplaceAll(plist, []byte("/tmp/atc.log"), []byte("/tmp/"+s.bin+".log"))
}

// macLoad writes the plist and (re)starts the job from it.
func macLoad(s service, plist []byte) error {
	if err := os.MkdirAll(filepath.Dir(macPlist(s)), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(macPlist(s), plist, 0o644); err != nil {
		return err
	}
	macUnload(s)
	return run("launchctl", "bootstrap", macDomain(), macPlist(s))
}

// writeEnvDefaults points atc at the hub it just installed, and at a claude the services' fixed PATH would miss. Lines
// already in the file stay as they are.
func writeEnvDefaults() error {
	path := filepath.Join(client.ConfigDir(), "env")
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var add []string
	has := func(key string) bool {
		return slices.ContainsFunc(strings.Split(string(b), "\n"), func(l string) bool { return strings.HasPrefix(l, key+"=") })
	}
	if !has("ATC_HUB") {
		add = append(add, "ATC_HUB=http://127.0.0.1:8820")
	}
	if c, err := exec.LookPath("claude"); err == nil && !has("ATC_CLAUDE_BIN") && !servicePathHas(filepath.Dir(c)) {
		add = append(add, "ATC_CLAUDE_BIN="+c)
	}
	if len(add) == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if len(b) > 0 && !bytes.HasSuffix(b, []byte("\n")) {
		b = append(b, '\n')
	}
	return os.WriteFile(path, append(b, strings.Join(add, "\n")+"\n"...), 0o600)
}

func servicePathHas(dir string) bool {
	home, _ := os.UserHomeDir()
	return slices.Contains([]string{filepath.Join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"}, dir)
}

// waitForNoCall holds a restart while a call is on the call line, since restarting atc or the hub cuts it. Up to 30
// minutes; with no call line there is nothing to wait for.
func waitForNoCall() {
	url := cmp.Or(os.Getenv("ATC_CALL_LINE"), envFileValue("ATC_CALL_LINE"), envFileValue("ATC_DELTA_CALL"))
	if url == "" {
		return
	}
	c := &http.Client{Timeout: 3 * time.Second}
	for range 360 {
		res, err := c.Get(strings.TrimRight(url, "/") + "/status")
		if err != nil {
			return
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		var st struct {
			Call string `json:"call"`
			App  any    `json:"app"`
		}
		if json.Unmarshal(body, &st) != nil || ((st.Call == "idle" || st.Call == "") && (st.App == nil || st.App == "connected")) {
			return
		}
		fmt.Println("a call is on, waiting to restart")
		time.Sleep(5 * time.Second)
	}
	fmt.Println("the call is still on after 30 minutes, restarting anyway")
}

func envFileValue(key string) string {
	b, _ := os.ReadFile(filepath.Join(client.ConfigDir(), "env"))
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(l, key+"="); ok {
			return strings.Trim(v, `"'`)
		}
	}
	return ""
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}
