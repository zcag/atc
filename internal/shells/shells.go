package shells

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Shell struct {
	ID      string    `json:"id"`
	Host    string    `json:"host,omitempty"`
	Dir     string    `json:"dir"`
	Cmd     string    `json:"cmd"`
	Run     string    `json:"run,omitempty"`
	Started time.Time `json:"started"`
	Viewers int       `json:"viewers"`
}

// Shells are login shells held by a tmux server of their own, on Socket, so they outlive the browser tab and atc itself.
type Shells struct {
	Socket string
}

const prefix = "atc-"

var ErrNoTmux = errors.New("tmux is not installed on this machine")

var validID = regexp.MustCompile(`^[0-9a-f]{8}$`)

func ValidID(id string) bool { return validID.MatchString(id) }

func Tmux() (string, error) {
	if p, err := exec.LookPath("tmux"); err == nil {
		return p, nil
	}
	for _, p := range []string{"/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"} {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", ErrNoTmux
}

func (s *Shells) cmd(ctx context.Context, args ...string) (*exec.Cmd, error) {
	bin, err := Tmux()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, bin, append([]string{"-u", "-f", os.DevNull, "-S", s.Socket}, args...)...)
	cmd.Env = Env()
	return cmd, nil
}

func (s *Shells) run(ctx context.Context, args ...string) (string, error) {
	cmd, err := s.cmd(ctx, args...)
	if err != nil {
		return "", err
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("tmux %s: %s", args[0], cmp.Or(strings.TrimSpace(string(out)), err.Error()))
	}
	return string(out), nil
}

// Env is atc's environment without what belongs to atc's service or to a terminal atc was started from.
func Env() []string {
	var out []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case strings.HasPrefix(k, "ATC_"), strings.HasPrefix(k, "CLAUDE"), strings.HasPrefix(k, "TMUX"),
			k == "INVOCATION_ID", k == "JOURNAL_STREAM", k == "NOTIFY_SOCKET", k == "MANAGERPID", k == "SYSTEMD_EXEC_PID",
			k == "TERM", k == "COLORTERM":
			continue
		}
		out = append(out, kv)
	}
	if os.Getenv("LANG") == "" && os.Getenv("LC_ALL") == "" && os.Getenv("LC_CTYPE") == "" {
		out = append(out, "LANG="+utf8Locale())
	}
	return append(out, "TERM=xterm-256color", "COLORTERM=truecolor")
}

func utf8Locale() string {
	if runtime.GOOS == "darwin" {
		return "en_US.UTF-8"
	}
	return "C.UTF-8"
}

func loginShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	for _, sh := range []string{"/bin/zsh", "/bin/bash"} {
		if _, err := os.Stat(sh); err == nil {
			return sh
		}
	}
	return "/bin/sh"
}

var options = [][]string{
	{"status", "off"}, {"prefix", "None"}, {"mouse", "on"}, {"escape-time", "0"},
	{"history-limit", "50000"}, {"set-clipboard", "on"}, {"default-terminal", "tmux-256color"}, {"focus-events", "on"},
}

const runThenWait = `"$0" -lic "$1"; s=$?; printf '\n\033[2m[exit %s, any key closes]\033[0m' "$s"; stty -icanon -echo min 1 2>/dev/null; head -c1 >/dev/null`

// Start opens a login shell in dir, or with run, a shell that runs that one command line and closes on the next key once it is done.
func (s *Shells) Start(ctx context.Context, dir, run string) (Shell, error) {
	home, _ := os.UserHomeDir()
	switch {
	case dir == "" || dir == "~":
		dir = home
	case strings.HasPrefix(dir, "~/"):
		dir = filepath.Join(home, dir[2:])
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return Shell{}, fmt.Errorf("%s is not a folder here", dir)
	}
	b := make([]byte, 4)
	rand.Read(b)
	id := hex.EncodeToString(b)
	if err := os.MkdirAll(filepath.Dir(s.Socket), 0o700); err != nil {
		return Shell{}, err
	}
	args := []string{"start-server"}
	for _, o := range options {
		args = append(args, ";", "set-option", "-g", o[0], o[1])
	}
	command := []string{loginShell(), "-l"}
	if run != "" {
		command = []string{"/bin/sh", "-c", runThenWait, loginShell(), run}
	}
	args = append(args, ";", "set-option", "-sa", "terminal-features", "xterm-256color:RGB:clipboard:focus:hyperlinks",
		";", "new-session", "-d", "-s", prefix+id, "-c", dir, "-x", "120", "-y", "40", "--")
	args = append(args, command...)
	if run != "" {
		args = append(args, ";", "set-option", "@run", run)
	}
	if _, err := s.run(ctx, args...); err != nil {
		return Shell{}, err
	}
	return Shell{ID: id, Dir: dir, Run: run, Started: time.Now()}, nil
}

func (s *Shells) List(ctx context.Context) ([]Shell, error) {
	if _, err := os.Stat(s.Socket); err != nil {
		return nil, nil
	}
	out, err := s.run(ctx, "list-sessions", "-F", strings.Join([]string{"#{session_name}", "#{session_created}", "#{session_attached}", "#{pane_current_command}", "#{pane_current_path}", "#{@run}"}, "\t"))
	if err != nil {
		if strings.Contains(err.Error(), "no server running") || strings.Contains(err.Error(), "error connecting") {
			return nil, nil
		}
		return nil, err
	}
	var list []Shell
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		f := strings.SplitN(line, "\t", 6)
		if len(f) < 6 || !strings.HasPrefix(f[0], prefix) {
			continue
		}
		at, _ := strconv.ParseInt(f[1], 10, 64)
		n, _ := strconv.Atoi(f[2])
		list = append(list, Shell{ID: strings.TrimPrefix(f[0], prefix), Started: time.Unix(at, 0), Viewers: n, Dir: f[4], Cmd: f[3], Run: f[5]})
	}
	return list, nil
}

func (s *Shells) Kill(ctx context.Context, id string) error {
	_, err := s.run(ctx, "kill-session", "-t", "="+prefix+id)
	return err
}

// Attach is a tmux client on the shell, which a browser's terminal runs on; it detaches when the browser goes.
func (s *Shells) Attach(id string) (*exec.Cmd, error) {
	return s.cmd(context.Background(), "attach-session", "-t", "="+prefix+id)
}

func (s *Shells) Has(ctx context.Context, id string) bool {
	_, err := s.run(ctx, "has-session", "-t", "="+prefix+id)
	return err == nil
}
