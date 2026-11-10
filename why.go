package main

import (
	"flag"
	"fmt"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/ends"
)

// showWhy says why a session stopped, with the log lines it rests on; with no session, the
// memory incidents of the last week.
func showWhy(args []string) error {
	fs := flag.NewFlagSet("why", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	host := fs.String("host", "", "which machine's incidents; default the server's own")
	raw := fs.Bool("raw", false, "print each log line the evidence rests on")
	fs.Parse(args)
	c := client.Load()
	if fs.NArg() == 0 {
		list, err := c.Incidents(*host)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(list)
		}
		if len(list) == 0 {
			fmt.Println("No memory incidents in the last week.")
		}
		for _, inc := range list {
			fmt.Printf("%s  %s\n  %s\n  atc why %s\n\n", inc.At.Format("Jan 2 15:04"), inc.Title, inc.Text, inc.ID)
		}
		return nil
	}
	if id := fs.Arg(0); strings.HasPrefix(id, "oom-") || strings.HasPrefix(id, "low-") {
		inc, err := c.Incident(id, *host)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(inc)
		}
		printIncident(&inc, *raw)
		return nil
	}
	s, err := c.Find(fs.Arg(0), true)
	if err != nil {
		return err
	}
	e, err := c.Ended(s.SessionID)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(e)
	}
	if s.State != "stopped" && s.State != "past" {
		fmt.Printf("%s is running. The last time it stopped:\n", s.Title)
	}
	if e.Ending == nil {
		return fmt.Errorf("%s: nothing recorded", s.Title)
	}
	fmt.Printf("%s: %s\n%s\n", s.Title, e.Ending.Short, e.Ending.Text)
	printEvidence(e.Ending.Evidence, *raw)
	if e.Incident != nil {
		fmt.Println()
		printIncident(e.Incident, *raw)
	}
	return nil
}

func printIncident(inc *ends.Incident, raw bool) {
	fmt.Printf("%s (%s)\n%s\n", inc.Title, inc.ID, inc.Text)
	names := func(l []ends.Lost) string {
		var s []string
		for _, x := range l {
			s = append(s, x.Title)
		}
		return strings.Join(s, ", ")
	}
	if len(inc.Lost) > 0 {
		fmt.Printf("Stopped: %s\n", names(inc.Lost))
	}
	if len(inc.Closed) > 0 {
		fmt.Printf("Closed for memory: %s\n", names(inc.Closed))
	}
	printEvidence(inc.Evidence, raw)
}

func printEvidence(lines []ends.Line, raw bool) {
	if len(lines) == 0 {
		return
	}
	fmt.Println()
	for _, l := range lines {
		fmt.Printf("  %s  %-20s %s\n", l.At.Format("15:04:05"), l.Source, l.Text)
		if raw && l.Raw != "" {
			for _, r := range strings.Split(l.Raw, "\n") {
				fmt.Printf("            %s\n", r)
			}
		}
	}
}
