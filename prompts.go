package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/modes"
)

func promptsCmd(args []string) error {
	fs := flags("prompts")
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
