package main

import (
	"fmt"
	"strings"

	"github.com/zcag/atc/internal/client"
)

const groupHelp = `atc group: the WhatsApp groups atc's account is in.

  atc group                  list them: in (atc takes part), quiet, or without you
  atc group quiet GROUP      stay out of GROUP although you are in it (by name or id)
  atc group on GROUP         take part in GROUP again

atc takes part in every group you are in: the guests' conversation reads each message and
answers with atc wa --group when it judges it should. Being added to a group you are
in is enough; nobody else there needs to be a guest.
`

func group(args []string) error {
	c := client.Load()
	var list []client.WAGroup
	var err error
	switch {
	case len(args) == 0 || args[0] == "ls" || args[0] == "list":
		list, err = c.Groups()
	case len(args) >= 2 && (args[0] == "quiet" || args[0] == "on"):
		list, err = c.GroupSet(args[0], strings.Join(args[1:], " "))
	default:
		fmt.Print(groupHelp)
		return nil
	}
	if err != nil {
		return err
	}
	for _, g := range list {
		fmt.Printf("%-12s %s\t%s\n", g.Status, g.Name, g.ID)
	}
	if len(list) == 0 {
		fmt.Println("In no groups.")
	}
	return nil
}
