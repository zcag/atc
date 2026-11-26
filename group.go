package main

import (
	"fmt"
	"strings"

	"github.com/zcag/atc/internal/client"
)

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
		return usageErr("group")
	}
	if err != nil {
		return err
	}
	if len(list) == 0 {
		fmt.Println("In no groups.")
		return nil
	}
	var rows [][]string
	for _, g := range list {
		rows = append(rows, []string{g.Status, g.Name, g.ID})
	}
	printLines(table([]string{"Status", "Group", "Id"}, rows, nil, nil, painter()))
	return nil
}
