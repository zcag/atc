package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"sync"
)

type Agent struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	PID       int    `json:"pid"`
	Cwd       string `json:"cwd"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	State     string `json:"state"`
	Status    string `json:"status"`
	StartedAt int64  `json:"startedAt"`
}

var ErrUntrusted = errors.New("workspace not trusted")

type CLI struct {
	Bin    string
	Args   []string
	Launch []string
	Slice  string
}

var shortID = regexp.MustCompile(`\b[0-9a-f]{8}\b`)

var hidden sync.Map

// Hide keeps a Claude process of atc's own out of the session list.
func Hide(pid int) func() {
	hidden.Store(pid, true)
	return func() { hidden.Delete(pid) }
}

// Secrets are atc's settings no Claude session needs: with the WhatsApp gateway's key a session could write to
// anyone, past every check atc wa makes. Settings marks them secret (caps' registry), a test keeps the two lists alike.
var Secrets = []string{"ATC_WHATSAPP_KEY", "ATC_WHATSAPP_SECRET"}

// Env is this process's environment without Secrets, for a Claude process atc starts in dir. A set Env keeps os/exec
// from pointing PWD at dir itself, so it is set here.
func Env(dir string) []string {
	env := slices.DeleteFunc(os.Environ(), func(kv string) bool {
		k, _, _ := strings.Cut(kv, "=")
		return slices.Contains(Secrets, k)
	})
	if dir != "" {
		env = append(env, "PWD="+dir)
	}
	return env
}

func (c CLI) run(ctx context.Context, dir string, args ...string) (string, error) {
	argv := append([]string{c.Bin}, args...)
	if args[0] == "--bg" {
		argv = append(slices.Clone(c.Launch), argv...)
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir, cmd.Env = dir, Env(dir)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	s := strings.TrimSpace(out.String())
	if strings.Contains(s, "Workspace not trusted") {
		return s, &Untrusted{Dir: dir, Home: strings.Contains(s, "home directory")}
	}
	if err != nil {
		return s, fmt.Errorf("claude %s: %w: %s", args[0], err, s)
	}
	return s, nil
}

func (c CLI) Agents(ctx context.Context) ([]Agent, error) {
	out, err := c.run(ctx, "", "agents", "--json", "--all")
	if err != nil {
		return nil, err
	}
	var as []Agent
	err = json.Unmarshal([]byte(out), &as)
	return slices.DeleteFunc(as, func(a Agent) bool { _, ok := hidden.Load(a.PID); return ok }), err
}

func (c CLI) Start(ctx context.Context, dir, name, prompt string, extra ...string) (string, error) {
	args := append(append([]string{"--bg"}, c.Args...), extra...)
	if name != "" {
		args = append(args, "--name", name)
	}
	if prompt != "" {
		args = append(args, prompt)
	}
	out, err := c.bg(ctx, dir, args...)
	if err != nil {
		return "", err
	}
	return idFrom(out)
}

func (c CLI) Resume(ctx context.Context, dir, sessionID string, extra ...string) (string, error) {
	args := append(append([]string{"--bg"}, c.Args...), extra...)
	out, err := c.bg(ctx, dir, append(args, "--resume", sessionID)...)
	if err != nil {
		return "", err
	}
	return idFrom(out)
}

func (c CLI) Stop(ctx context.Context, id string) error {
	_, err := c.run(ctx, "", "stop", id)
	return err
}

func (c CLI) Remove(ctx context.Context, id string) error {
	_, err := c.run(ctx, "", "rm", id)
	return err
}

func (c CLI) Print(ctx context.Context, model, system, input string) (string, error) {
	cmd := exec.CommandContext(ctx, c.Bin, "-p", "--model", model, "--safe-mode", "--system-prompt", system, "--tools", "",
		"--strict-mcp-config", "--no-session-persistence", "--output-format", "json")
	cmd.Dir = os.TempDir()
	cmd.Stdin = strings.NewReader(input)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("claude -p: %v", err)
	}
	defer Hide(cmd.Process.Pid)()
	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("claude -p: %v: %s", err, strings.TrimSpace(errOut.String()+out.String()))
	}
	var r struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
	}
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		return "", fmt.Errorf("claude -p: %v", err)
	}
	if r.IsError {
		return "", fmt.Errorf("claude -p: %s", r.Result)
	}
	return r.Result, nil
}

func idFrom(out string) (string, error) {
	if ids := shortID.FindAllString(out, -1); len(ids) > 0 {
		return ids[len(ids)-1], nil
	}
	return "", fmt.Errorf("no session id in: %s", out)
}
