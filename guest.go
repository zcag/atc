package main

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/whatsapp"
)

func waClient() *whatsapp.Client {
	c := whatsapp.FromEnv()
	if c != nil {
		c.Guests = &whatsapp.Guests{Path: filepath.Join(client.ConfigDir(), "guests")}
		c.Quiet = &whatsapp.Quiet{Path: filepath.Join(client.ConfigDir(), "groups-quiet")}
	}
	return c
}

func guest(args []string) error {
	c := client.Load()
	switch {
	case len(args) == 0 || args[0] == "ls" || args[0] == "list":
		list, err := c.Guests()
		if err != nil {
			return err
		}
		names := make([]string, 0, len(list))
		for n := range list {
			names = append(names, n)
		}
		slices.Sort(names)
		if len(names) == 0 {
			fmt.Println("No guests.")
			return nil
		}
		var rows [][]string
		for _, n := range names {
			rows = append(rows, []string{n, "+" + list[n]})
		}
		printLines(table([]string{"Guest", "Number"}, rows, nil, nil, painter()))
		return nil
	case args[0] == "add" && len(args) >= 3:
		if err := c.GuestEdit("add", args[1], strings.Join(args[2:], "")); err != nil {
			return err
		}
		fmt.Printf("%s can write in now. Introduce yourself with: atc wa --to %s TEXT\n", args[1], args[1])
		return nil
	case args[0] == "call" && len(args) >= 2:
		called := strings.Join(args[2:], " ")
		if err := c.GuestCall(args[1], called); err != nil {
			return err
		}
		if called == "" {
			fmt.Printf("Calls greet %s without a name.\n", args[1])
		} else {
			fmt.Printf("Calls greet %s as %s.\n", args[1], called)
		}
		return nil
	case (args[0] == "rm" || args[0] == "remove") && len(args) == 2:
		if err := c.GuestEdit("rm", args[1], ""); err != nil {
			return err
		}
		fmt.Printf("%s is no longer a guest.\n", args[1])
		return nil
	}
	return usageErr("guest")
}
