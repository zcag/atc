package main

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

func TestEveryCommandHasOneHelp(t *testing.T) {
	listed := map[string]bool{}
	for _, s := range sections {
		for _, c := range s.cmds {
			if listed[c] {
				t.Errorf("%s is listed twice", c)
			}
			listed[c] = true
		}
	}
	src, _ := os.ReadFile("main.go")
	cases := regexp.MustCompile(`(?m)^\tcase ((?:"[a-z-]+",? ?)+):`).FindAllStringSubmatch(string(src), -1)
	if len(cases) < 30 {
		t.Fatalf("found only %d command cases in main.go", len(cases))
	}
	for _, m := range cases {
		for _, c := range regexp.MustCompile(`"([a-z-]+)"`).FindAllStringSubmatch(m[1], -1) {
			name := c[1]
			if a := aliases[name]; a != "" || strings.HasPrefix(name, "-") || name == "help" {
				continue
			}
			if _, ok := helps[name]; !ok {
				t.Errorf("atc %s has no help", name)
			}
			if !listed[name] {
				t.Errorf("atc %s is missing from the top-level usage", name)
			}
		}
	}
	single := regexp.MustCompile(`(^|[\s\[(])-[a-z]{2,}`)
	for name, h := range helps {
		text := h.text(name)
		if !strings.HasPrefix(text, "atc "+name+": ") || !strings.Contains(text, "\nUsage\n") || !strings.Contains(text, "-h, --help") {
			t.Errorf("atc %s -h does not follow the template:\n%s", name, text)
		}
		for _, l := range strings.Split(text, "\n") {
			if single.MatchString(l) && !strings.Contains(l, "-- atc") {
				t.Errorf("atc %s -h has a single-dash flag: %q", name, l)
			}
		}
	}
}

func TestHelpComesFirst(t *testing.T) {
	bin := t.TempDir() + "/atc"
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	for _, args := range [][]string{{"token", "-h"}, {"mcp", "--help"}, {"backlog", "-h"}, {"attach", "-h"}, {"login", "-h"}, {"app", "-h"}, {"help", "park"}} {
		cmd := exec.Command(bin, args...)
		cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), "ATC_URL=http://127.0.0.1:1")
		out, err := cmd.Output()
		want := "atc " + args[0] + ": "
		if args[0] == "help" {
			want = "atc " + args[1] + ": "
		}
		if err != nil || !strings.HasPrefix(string(out), want) {
			t.Errorf("atc %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
}
