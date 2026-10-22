package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
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
	Bin  string
	Args []string
}

var shortID = regexp.MustCompile(`\b[0-9a-f]{8}\b`)

func (c CLI) run(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, c.Bin, args...)
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	s := strings.TrimSpace(out.String())
	if strings.Contains(s, "Workspace not trusted") {
		return s, ErrUntrusted
	}
	if err != nil {
		return s, fmt.Errorf("claude %s: %v: %s", args[0], err, s)
	}
	return s, nil
}

func (c CLI) Agents(ctx context.Context) ([]Agent, error) {
	out, err := c.run(ctx, "", "agents", "--json", "--all")
	if err != nil {
		return nil, err
	}
	var as []Agent
	return as, json.Unmarshal([]byte(out), &as)
}

func (c CLI) Start(ctx context.Context, dir, name, prompt string) (string, error) {
	args := append([]string{"--bg"}, c.Args...)
	if name != "" {
		args = append(args, "--name", name)
	}
	if prompt != "" {
		args = append(args, prompt)
	}
	out, err := c.run(ctx, dir, args...)
	if err != nil {
		return "", err
	}
	return idFrom(out)
}

func (c CLI) Resume(ctx context.Context, dir, sessionID string) (string, error) {
	out, err := c.run(ctx, dir, "--bg", "--resume", sessionID)
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

func idFrom(out string) (string, error) {
	if ids := shortID.FindAllString(out, -1); len(ids) > 0 {
		return ids[len(ids)-1], nil
	}
	return "", fmt.Errorf("no session id in: %s", out)
}
