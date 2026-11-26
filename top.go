package main

import (
	"fmt"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/resources"
)

func showTop(args []string) error {
	fs := flags("top")
	asJSON := fs.Bool("json", false, "print JSON")
	host := fs.String("host", "", "which machine; default the server's own")
	fs.Parse(args)
	r, err := client.Load().Resources(*host)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(r)
	}
	if who := fs.Arg(0); who != "" {
		return topOne(r, who)
	}
	m := r.Machine
	fmt.Printf("Memory %s of %s (%s in /tmp and /dev/shm), swap %s, CPU %.0f%% of %d cores, load %.1f.\n", size(m.MemUsed), size(m.MemTotal), size(m.RAMDisk), size(m.SwapUsed), m.CPU/float64(max(m.Cores, 1)), m.Cores, m.Load)
	for _, sec := range []struct {
		name   string
		groups []resources.Group
	}{{"Outlived their session", r.Left}, {"Sessions", r.Sessions}, {"Outside sessions", r.Outside}} {
		if len(sec.groups) == 0 {
			continue
		}
		var rows [][]string
		for _, g := range sec.groups {
			big := ""
			if len(g.Procs) > 0 {
				big = g.Procs[0].Name
			}
			rows = append(rows, []string{clip(g.Title, 40), size(g.Mem), fmt.Sprintf("%.0f%%", g.CPU), size(int64(g.Read)) + "/" + size(int64(g.Write)), fmt.Sprint(g.Count), big})
		}
		fmt.Println()
		printLines(table([]string{sec.name, "Memory", "CPU", "Disk r/w", "Procs", "Biggest"}, rows, map[int]bool{1: true, 2: true, 3: true, 4: true}, nil, painter()))
	}
	return nil
}

func topOne(r resources.Report, who string) error {
	for _, g := range append(append(append([]resources.Group{}, r.Sessions...), r.Left...), r.Outside...) {
		if strings.HasPrefix(g.Key, who) || (g.SessionID != "" && strings.HasPrefix(g.SessionID, who)) || strings.Contains(strings.ToLower(g.Title), strings.ToLower(who)) {
			fmt.Printf("%s: %s, %.0f%% CPU, %s.\n\n", g.Title, size(g.Mem), g.CPU, plural(g.Count, "process", "processes"))
			var rows [][]string
			for _, p := range g.Procs {
				rows = append(rows, []string{fmt.Sprint(p.PID), size(p.Mem), fmt.Sprintf("%.0f%%", p.CPU), clip(p.Cmd, 100)})
			}
			printLines(table([]string{"Pid", "Memory", "CPU", "Command"}, rows, map[int]bool{0: true, 1: true, 2: true}, nil, painter()))
			return nil
		}
	}
	return fmt.Errorf("nothing running for %q", who)
}

func size(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1fG", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%dM", n>>20)
	case n >= 1<<10:
		return fmt.Sprintf("%dK", n>>10)
	}
	return fmt.Sprintf("%d", n)
}
