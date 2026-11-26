package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/zcag/atc/internal/client"
)

func wa(args []string) error {
	var files, render, words []string
	var caption, voice, poll, to, group string
	var options []string
	var multi bool
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
		var x string
		switch {
		case !strings.HasPrefix(a, "-"):
			words = append(words, a)
		case flag == "file" || flag == "f":
			if x, err = val(); err == nil {
				x, err = filepath.Abs(x)
				files = append(files, x)
			}
		case flag == "render":
			if x, err = val(); err == nil {
				x, err = filepath.Abs(x)
				render = append(render, x)
			}
		case flag == "to":
			to, err = val()
		case flag == "group":
			group, err = val()
		case flag == "caption":
			caption, err = val()
		case flag == "voice":
			voice, err = val()
		case flag == "poll":
			poll, err = val()
		case flag == "option" || flag == "o":
			if x, err = val(); err == nil {
				options = append(options, x)
			}
		case flag == "multi":
			multi = true
		default:
			return fmt.Errorf("unknown flag %s (atc wa -h)", a)
		}
		if err != nil {
			return err
		}
	}
	text := strings.Join(words, " ")
	if poll == "" && len(options) > 0 {
		return fmt.Errorf("--option needs --poll")
	}
	if text == "" && len(files)+len(render) == 0 && voice == "" && poll == "" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		text = string(b)
	}
	if strings.TrimSpace(text) == "" && len(files)+len(render) == 0 && voice == "" && poll == "" {
		usageExit("wa")
	}
	req := map[string]any{"to": to, "group": group, "text": text, "files": files, "render": render, "caption": caption, "voice": voice}
	if poll != "" {
		req["poll"] = map[string]any{"question": poll, "options": options, "multi": multi}
	}
	sent, err := client.Load().WhatsApp(req)
	if err != nil {
		return err
	}
	where := ""
	if to != "" || group != "" {
		where = " to " + to + group
	}
	fmt.Println("Sent on WhatsApp" + where + ": " + strings.Join(sent, ", "))
	return nil
}
