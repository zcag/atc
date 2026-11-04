package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/resources"
)

func showTop(args []string) error {
	fs := flag.NewFlagSet("top", flag.ExitOnError)
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
	fmt.Printf("memory %s of %s (%s in /tmp and /dev/shm), swap %s, cpu %.0f%% of %d cores, load %.1f\n\n", size(m.MemUsed), size(m.MemTotal), size(m.RAMDisk), size(m.SwapUsed), m.CPU/float64(max(m.Cores, 1)), m.Cores, m.Load)
	w := tabwriter.NewWriter(os.Stdout, 2, 2, 2, ' ', 0)
	section := func(name string, groups []resources.Group) {
		if len(groups) == 0 {
			return
		}
		fmt.Fprintf(w, "%s\tMEM\tCPU\tDISK R/W\tPROCS\tBIGGEST\n", name)
		for _, g := range groups {
			big := ""
			if len(g.Procs) > 0 {
				big = g.Procs[0].Name
			}
			fmt.Fprintf(w, "%s\t%s\t%.0f%%\t%s/%s\t%d\t%s\n", clipTo(g.Title, 40), size(g.Mem), g.CPU, size(int64(g.Read)), size(int64(g.Write)), g.Count, big)
		}
		fmt.Fprintln(w, "\t\t\t\t\t")
	}
	section("OUTLIVED THEIR SESSION", r.Left)
	section("SESSIONS", r.Sessions)
	section("OUTSIDE SESSIONS", r.Outside)
	return w.Flush()
}

func topOne(r resources.Report, who string) error {
	for _, g := range append(append(append([]resources.Group{}, r.Sessions...), r.Left...), r.Outside...) {
		if strings.HasPrefix(g.Key, who) || (g.SessionID != "" && strings.HasPrefix(g.SessionID, who)) || strings.Contains(strings.ToLower(g.Title), strings.ToLower(who)) {
			fmt.Printf("%s: %s, %.0f%% cpu, %d processes\n", g.Title, size(g.Mem), g.CPU, g.Count)
			w := tabwriter.NewWriter(os.Stdout, 2, 2, 2, ' ', 0)
			fmt.Fprintln(w, "PID\tMEM\tCPU\tCOMMAND")
			for _, p := range g.Procs {
				fmt.Fprintf(w, "%d\t%s\t%.0f%%\t%s\n", p.PID, size(p.Mem), p.CPU, clipTo(p.Cmd, 100))
			}
			return w.Flush()
		}
	}
	return fmt.Errorf("nothing running for %q", who)
}

func clipTo(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
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
