package history

import (
	"encoding/json"
	"regexp"
	"strings"
)

type Badge struct {
	Kind string `json:"kind"`
	OK   bool   `json:"ok"`
	Text string `json:"text"`
	Ref  string `json:"ref,omitempty"`
}

var (
	testCmd    = regexp.MustCompile(`\b(go test|(npm|pnpm|yarn|bun)( run)? test|pytest|cargo test|make test|vitest|jest|rspec|rails test|gradle\w* test|\./gradlew test)\b`)
	buildCmd   = regexp.MustCompile(`\b(go build|(npm|pnpm|yarn|bun) run build|make build|cargo build|tsc\b|gradle\w* assemble|make android)\b`)
	deployCmd  = regexp.MustCompile(`\b(make install(-\w+)?|systemctl (--user )?(restart|reload)|docker compose up|kubectl (apply|rollout)|make deploy\S*|deploy-\w+|make android-publish)\b`)
	showCmd    = regexp.MustCompile(`\batc show\b`)
	showLine   = regexp.MustCompile(`(?m)^(?:Showing|Updated) "(.*)" \(([^)]+)\) in atc`)
	commitLine = regexp.MustCompile(`(?m)^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$`)
	pushLine   = regexp.MustCompile(`(?m)^\s+(?:[0-9a-f]+\.\.[0-9a-f]+|\* \[new branch\]|\+ [0-9a-f]+\.\.\.[0-9a-f]+)\s+(\S+) -> (\S+)`)
	failTest   = regexp.MustCompile(`(?m)^\s*--- FAIL: (\S+)|^FAILED (\S+)|^\s*✗ (.+)$`)
	firstURL   = regexp.MustCompile(`https?://\S+`)
	segments   = regexp.MustCompile(`\s*(?:&&|\|\||;|\|)\s*`)
	readOnly   = map[string]bool{
		"ls": true, "cat": true, "head": true, "tail": true, "grep": true, "rg": true, "find": true, "wc": true, "sed": true,
		"jq": true, "file": true, "stat": true, "which": true, "tree": true, "du": true, "df": true, "pgrep": true, "ps": true,
		"journalctl": true, "echo": true, "pwd": true, "date": true, "sort": true, "uniq": true, "cut": true, "awk": true,
		"nl": true, "column": true, "less": true, "diff": true, "realpath": true, "basename": true, "dirname": true, "env": true,
		"printenv": true, "id": true, "hostname": true, "uname": true, "type": true, "command": true, "fd": true, "readlink": true,
		"xxd": true, "od": true, "strings": true, "sha256sum": true, "md5sum": true, "true": true, "test": true, "[": true,
	}
	readOnlyGit = map[string]bool{"log": true, "status": true, "diff": true, "show": true, "blame": true, "branch": true, "rev-parse": true, "remote": true, "ls-files": true, "grep": true, "describe": true}
)

var terminalEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

func classify(m Message) (*Badge, bool) {
	switch m.Tool {
	case "Read", "Grep", "Glob", "LS":
		return nil, true
	case "Bash":
	default:
		return nil, false
	}
	var in struct{ Command string }
	json.Unmarshal(m.Input, &in)
	cmd, out := in.Command, ""
	failed := m.Out != nil && m.Out.Error
	if m.Out != nil {
		out = terminalEscape.ReplaceAllString(m.Out.Text, "")
	}
	switch {
	case strings.Contains(cmd, "git commit"):
		if sm := commitLine.FindStringSubmatch(out); sm != nil {
			return &Badge{Kind: "commit", OK: true, Text: sm[3], Ref: sm[2][:7]}, false
		}
	case strings.Contains(cmd, "git push"):
		if failed {
			return &Badge{Kind: "push", Text: "Push failed"}, false
		}
		if sm := pushLine.FindStringSubmatch(out); sm != nil {
			return &Badge{Kind: "push", OK: true, Text: "Pushed to " + sm[2]}, false
		}
		return &Badge{Kind: "push", OK: true, Text: "Pushed"}, false
	case testCmd.MatchString(cmd):
		b := &Badge{Kind: "test", OK: !failed && !strings.Contains(out, "\nFAIL") && !strings.HasPrefix(out, "FAIL") && !strings.Contains(out, "--- FAIL"), Text: "Tests passed"}
		if !b.OK {
			b.Text = "Tests failed"
			if sm := failTest.FindStringSubmatch(out); sm != nil {
				b.Ref = strings.TrimSpace(sm[1] + sm[2] + sm[3])
			}
		}
		return b, false
	case buildCmd.MatchString(cmd):
		if failed {
			return &Badge{Kind: "build", Text: "Build failed"}, false
		}
		return &Badge{Kind: "build", OK: true, Text: "Built"}, false
	case showCmd.MatchString(cmd) && !failed:
		if sm := showLine.FindStringSubmatch(out); sm != nil {
			return &Badge{Kind: "show", OK: true, Text: sm[1], Ref: sm[2]}, false
		}
	case deployCmd.MatchString(cmd):
		what := deployCmd.FindString(cmd)
		if failed {
			return &Badge{Kind: "deploy", Text: "Failed: " + what}, false
		}
		return &Badge{Kind: "deploy", OK: true, Text: "Deployed", Ref: what}, false
	}
	return nil, !failed && lookOnly(cmd)
}

func lookOnly(cmd string) bool {
	if strings.ContainsAny(cmd, ">") && !strings.Contains(cmd, "2>&1") && !strings.Contains(cmd, ">/dev/null") {
		return false
	}
	for _, seg := range segments.Split(strings.TrimSpace(cmd), -1) {
		f := strings.Fields(seg)
		for len(f) > 0 && (strings.Contains(f[0], "=") || f[0] == "sudo" || f[0] == "cd") {
			if f[0] == "cd" && len(f) > 1 {
				f = f[2:]
				continue
			}
			f = f[1:]
		}
		if len(f) == 0 {
			continue
		}
		if f[0] == "git" {
			if len(f) < 2 || !readOnlyGit[f[1]] {
				return false
			}
			continue
		}
		if f[0] == "sed" && !strings.Contains(seg, "-n") {
			return false
		}
		if !readOnly[f[0]] {
			return false
		}
	}
	return true
}
