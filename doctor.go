package main

import (
	"cmp"
	"context"
	"flag"
	"fmt"
	"os"
	"runtime/debug"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/caps"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/server"
)

// Version is set at release with -ldflags "-X main.Version=1.2.3".
var Version = "dev"

func versionString() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return Version
	}
	if v := info.Main.Version; Version == "dev" && strings.HasPrefix(v, "v") {
		return v
	}
	var rev, dirty string
	for _, s := range info.Settings {
		switch {
		case s.Key == "vcs.revision" && len(s.Value) >= 12:
			rev = s.Value[:12]
		case s.Key == "vcs.modified" && s.Value == "true":
			dirty = "-dirty"
		}
	}
	if rev == "" {
		return Version
	}
	return Version + " " + rev + dirty
}

const doctorHelp = `Usage: atc doctor [-json]

What each atc feature needs and how it stands, by the same checks Settings shows: the status, what is wrong in plain
words, and the fix. It asks the running server, with its environment and machines; with none running it does the same
checks here, over the same files.

Exits 1 only if something required is missing or something set up stopped working on the machine it asked. Optional
features that were never set up are fine.
`

func doctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(doctorHelp) }
	asJSON := fs.Bool("json", false, "print JSON")
	fs.Parse(args)
	c := client.Load()
	var rep server.CapsReport
	if err := c.Caps(&rep); err != nil || len(rep.Machines) == 0 {
		host, _ := os.Hostname()
		ctx, cancel := context.WithTimeout(context.Background(), 2*caps.Timeout)
		defer cancel()
		rep = server.CapsAlone(ctx, conf, strings.Split(host, ".")[0], versionString(), cmp.Or(os.Getenv("ATC_CLAUDE_BIN"), "claude"), c.URL)
	}
	var err error
	if *asJSON {
		err = printJSON(rep)
	} else {
		printDoctor(rep)
	}
	if err == nil && len(caps.Failing(rep.Machines[0].Rows)) > 0 {
		os.Exit(1)
	}
	return err
}

func statusWord(r caps.Row) string {
	switch {
	case r.Status == caps.OK:
		return "ok"
	case r.Status == caps.Broken:
		return "broken"
	case r.Optional:
		return "not set up"
	}
	return "needed"
}

func printDoctor(rep server.CapsReport) {
	for i, m := range rep.Machines {
		if i > 0 {
			fmt.Println()
		}
		fmt.Printf("%s", m.Host)
		if m.Version != "" {
			fmt.Printf(" (atc %s)", m.Version)
		}
		fmt.Println()
		if m.Error != "" {
			fmt.Println("  " + m.Error)
			continue
		}
		if m.SettingsError != "" {
			fmt.Println("  " + m.SettingsError)
		}
		for _, g := range rep.Groups {
			at := slices.IndexFunc(m.Rows, func(r caps.Row) bool { return r.Group == g })
			if at < 0 {
				continue
			}
			fmt.Printf("\n  %s\n", g)
			for _, r := range m.Rows {
				if r.Group == g {
					printRow(r)
				}
			}
		}
		if m.RestartCmd != "" {
			fmt.Printf("\n  Saved settings wait for a restart: %s\n", m.RestartCmd)
		}
	}
}

func printRow(r caps.Row) {
	const pad = "               "
	fmt.Printf("    %-11s%s: %s\n", statusWord(r), r.Title, r.Detail)
	var needs []string
	for _, n := range r.Needs {
		if n.Status != caps.OK {
			needs = append(needs, n.Title)
		}
	}
	if r.Status == caps.OK {
		return
	}
	if len(needs) > 0 {
		fmt.Println(pad + "needs " + strings.Join(needs, ", "))
	}
	if r.Fix.Command != "" {
		fmt.Println(pad + "fix: " + r.Fix.Command)
	}
	if r.Fix.Text != "" {
		fmt.Println(pad + r.Fix.Text)
	}
	if r.Fix.GuideURL != "" {
		fmt.Println(pad + "see " + r.Fix.GuideURL)
	}
	if r.Cost != "" {
		fmt.Println(pad + "costs: " + r.Cost)
	}
}
