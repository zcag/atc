package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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
	Profile   string `json:"profile,omitempty"`
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
var Secrets = []string{"ATC_WHATSAPP_KEY", "ATC_WHATSAPP_SECRET", "ATC_INBOUND_SECRET"}

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

func (c CLI) run(ctx context.Context, p Profile, dir string, args ...string) (string, error) {
	argv := append([]string{c.Bin}, args...)
	if args[0] == "--bg" {
		argv = append(slices.Clone(c.Launch), argv...)
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir, cmd.Env = dir, append(Env(dir), p.Env()...)
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

// Agents lists every profile's sessions, each daemon asked on its own. A profile whose daemon can't answer is left
// out rather than failing the rest; only the default's failure is an error.
func (c CLI) Agents(ctx context.Context) ([]Agent, error) {
	ps := Profiles()
	lists, errs := make([][]Agent, len(ps)), make([]error, len(ps))
	var wg sync.WaitGroup
	for i, p := range ps {
		wg.Go(func() { lists[i], errs[i] = c.agents(ctx, p) })
	}
	wg.Wait()
	var as []Agent
	for i, p := range ps {
		if errs[i] != nil && !p.Default() {
			log.Printf("claude agents, profile %s: %v", p.Name, errs[i])
			continue
		}
		as = append(as, lists[i]...)
	}
	return as, errs[0]
}

func (c CLI) agents(ctx context.Context, p Profile) ([]Agent, error) {
	out, err := c.run(ctx, p, "", "agents", "--json", "--all")
	if err != nil {
		return nil, err
	}
	var as []Agent
	err = json.Unmarshal([]byte(out), &as)
	for i := range as {
		as[i].Profile = p.Name
		jobProfile.Store(as[i].ID, p.Name)
	}
	return slices.DeleteFunc(as, func(a Agent) bool { _, ok := hidden.Load(a.PID); return ok }), err
}

// Start starts a background session in dir as the profile named profile, or the one dir's rules pick when it is "".
func (c CLI) Start(ctx context.Context, profile, dir, name, prompt string, extra ...string) (string, error) {
	p := ProfileFor(dir)
	if profile != "" {
		var ok bool
		if p, ok = ProfileNamed(profile); !ok {
			return "", fmt.Errorf("no Claude profile called %q here", profile)
		}
	}
	args := append([]string{"--bg"}, p.Flags(append(slices.Clone(c.Args), extra...))...)
	if name != "" {
		args = append(args, "--name", name)
	}
	if prompt != "" {
		args = append(args, prompt)
	}
	out, err := c.bg(ctx, p, dir, args...)
	if err != nil {
		return "", err
	}
	return started(p, out)
}

// Resume reopens a conversation as the profile that keeps its transcript: no other account can see it.
func (c CLI) Resume(ctx context.Context, dir, sessionID string, extra ...string) (string, error) {
	p := ProfileOfSession(sessionID)
	args := append([]string{"--bg"}, p.Flags(append(slices.Clone(c.Args), extra...))...)
	out, err := c.bg(ctx, p, dir, append(args, "--resume", sessionID)...)
	if err != nil {
		return "", err
	}
	return started(p, out)
}

func started(p Profile, out string) (string, error) {
	id, err := idFrom(out)
	if err == nil {
		jobProfile.Store(id, p.Name)
	}
	return id, err
}

func (c CLI) Stop(ctx context.Context, id string) error {
	_, err := c.run(ctx, ProfileOf(id), "", "stop", id)
	return err
}

func (c CLI) Remove(ctx context.Context, id string) error {
	return c.RemoveFrom(ctx, ProfileOf(id), id)
}

func (c CLI) RemoveFrom(ctx context.Context, p Profile, id string) error {
	_, err := c.run(ctx, p, "", "rm", id)
	return err
}

func (c CLI) Print(ctx context.Context, model, system, input string) (string, error) {
	return c.PrintAs(ctx, DefaultProfile(), model, system, input)
}

// PrintAs is Print on the account p, for text that belongs to it.
func (c CLI) PrintAs(ctx context.Context, p Profile, model, system, input string) (string, error) {
	cmd := exec.CommandContext(ctx, c.Bin, "-p", "--model", model, "--safe-mode", "--system-prompt", system, "--tools", "",
		"--strict-mcp-config", "--no-session-persistence", "--output-format", "json")
	cmd.Dir = os.TempDir()
	if env := p.Env(); env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
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
