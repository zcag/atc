package main

import (
	"cmp"
	"context"
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

func doctor(args []string) error {
	fs := flags("doctor")
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
	paint := painter()
	counts := map[string]int{}
	for i, m := range rep.Machines {
		if i > 0 {
			fmt.Println()
		}
		head := m.Host
		if m.Version != "" {
			head += "  atc " + m.Version
		}
		fmt.Println(paint("1", head))
		if m.Error != "" {
			fmt.Println("  " + unticked(m.Error))
			continue
		}
		if m.SettingsError != "" {
			fmt.Println("  " + unticked(m.SettingsError))
		}
		tw := 0
		for _, r := range m.Rows {
			tw = max(tw, len(r.Title))
		}
		for _, g := range rep.Groups {
			if !slices.ContainsFunc(m.Rows, func(r caps.Row) bool { return r.Group == g }) {
				continue
			}
			fmt.Printf("\n%s\n", paint("1", g))
			for _, r := range m.Rows {
				if r.Group == g {
					counts[statusWord(r)]++
					printRow(r, tw, paint)
				}
			}
		}
		if m.RestartCmd != "" {
			fmt.Printf("\nSaved settings wait for a restart: %s\n", m.RestartCmd)
		}
	}
	var sum []string
	for _, w := range []string{"broken", "needed", "not set up", "ok"} {
		if counts[w] > 0 {
			sum = append(sum, fmt.Sprintf("%d %s", counts[w], w))
		}
	}
	if len(sum) > 0 {
		fmt.Printf("\n%s. --json for scripts.\n", strings.Join(sum, ", "))
	}
}

func unticked(s string) string { return strings.ReplaceAll(s, "`", "") }

var statusColor = map[string]string{"ok": "32", "broken": "31;1", "needed": "33;1", "not set up": "2"}

func printRow(r caps.Row, tw int, paint func(code, s string) string) {
	pad := strings.Repeat(" ", 2+10+2)
	word := statusWord(r)
	fmt.Printf("  %s  %s  %s\n", paint(statusColor[word], fmt.Sprintf("%-10s", word)), fmt.Sprintf("%-*s", tw, r.Title), unticked(r.Detail))
	if r.Status == caps.OK {
		return
	}
	var needs []string
	for _, n := range r.Needs {
		if n.Status != caps.OK {
			needs = append(needs, n.Title)
		}
	}
	if len(needs) > 0 {
		fmt.Println(pad + "needs " + strings.Join(needs, ", "))
	}
	if r.Fix.Command != "" {
		fmt.Println(pad + paint("2", "fix") + "  " + paint("1", r.Fix.Command))
	}
	if r.Fix.Text != "" {
		fmt.Println(pad + unticked(r.Fix.Text))
	}
	if r.Fix.GuideURL != "" {
		fmt.Println(pad + "see " + r.Fix.GuideURL)
	}
	if r.Cost != "" {
		fmt.Println(pad + "costs: " + unticked(r.Cost))
	}
}
