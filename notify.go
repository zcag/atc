package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/zcag/atc/internal/client"
)

func notify(args []string) error {
	var urgent bool
	var ref, page string
	var replies, words []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		flag, v, inline := strings.Cut(strings.TrimLeft(a, "-"), "=")
		val := func() (string, error) {
			if inline {
				return v, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", a)
			}
			i++
			return args[i], nil
		}
		var err error
		switch {
		case !strings.HasPrefix(a, "-"):
			words = append(words, a)
		case flag == "urgent" || flag == "u":
			urgent = true
		case flag == "reply" || flag == "r":
			var r string
			r, err = val()
			replies = append(replies, r)
		case flag == "session":
			ref, err = val()
		case flag == "page":
			page, err = val()
		default:
			return fmt.Errorf("unknown flag %s (atc notify -h)", a)
		}
		if err != nil {
			return err
		}
	}
	text := strings.Join(words, " ")
	if text == "" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		text = string(b)
	}
	if strings.TrimSpace(text) == "" {
		usageExit("notify")
	}
	if len(replies) > 3 {
		return fmt.Errorf("at most three replies")
	}
	c := client.Load()
	sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
	if ref != "" {
		s, err := c.Find(ref, true)
		if err != nil {
			return err
		}
		sid = s.SessionID
	}
	if sid == "" {
		return fmt.Errorf("not inside a Claude session, so atc can't tell who is talking; add --session <session>")
	}
	res, err := c.Notify(sid, map[string]any{"text": text, "urgent": urgent, "replies": replies, "page": page})
	switch {
	case err != nil:
		return err
	case res == "pushed":
		fmt.Println("Pushed. atc does not list this session, so tapping it opens atc, not the session.")
	case urgent:
		fmt.Println("Sent; it buzzes now.")
	default:
		fmt.Println("Sent; it buzzes unless they are already in atc.")
	}
	return nil
}
