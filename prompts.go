package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/modes"
)

const promptsHelp = `Usage: atc prompts [--check | --update]

Prints every text the assistant is told, with your own files in ~/.config/atc/modes applied.

  --check    compare with prompts.golden in that folder and show what changed; exit 1 if anything did
  --update   accept the current text as prompts.golden
`

func promptsCmd(args []string) error {
	fs := flag.NewFlagSet("prompts", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(promptsHelp) }
	check := fs.Bool("check", false, "")
	update := fs.Bool("update", false, "")
	fs.Parse(args)
	modes.Dir = filepath.Join(client.ConfigDir(), "modes")
	now, golden := modes.Rendered(), filepath.Join(modes.Dir, "prompts.golden")
	switch {
	case *update:
		return os.WriteFile(golden, []byte(now), 0o644)
	case *check:
		b, err := os.ReadFile(golden)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if d := lineDiff(string(b), now); d != "" {
			return fmt.Errorf("the assistant's prompts changed from %s (accept with atc prompts --update):\n%s", golden, d)
		}
		return nil
	}
	fmt.Print(now)
	return nil
}

func lineDiff(was, now string) string {
	had, has := map[string]bool{}, map[string]bool{}
	for _, l := range strings.Split(was, "\n") {
		had[l] = true
	}
	var out strings.Builder
	for _, l := range strings.Split(now, "\n") {
		has[l] = true
		if !had[l] {
			out.WriteString("+ " + l + "\n")
		}
	}
	for _, l := range strings.Split(was, "\n") {
		if !has[l] {
			out.WriteString("- " + l + "\n")
		}
	}
	return out.String()
}
