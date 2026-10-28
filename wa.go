package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/zcag/atc/internal/client"
)

const waHelp = `atc wa: send the user something on WhatsApp, from the account atc answers them on.

  atc wa [--file PATH]... [--render PAGE.html]... [--caption TEXT] [--voice TEXT] [text...]

It only ever reaches the user. In the whatsapp session your replies are delivered
already; use this for what a reply can't carry:

  --file PATH      a file: images and videos show inline, audio plays, anything else
                   arrives as a document (PDF, CSV, a zip). Repeat for more.
  --render PAGE    an HTML file drawn as an image, 480px wide: a chart, a diagram,
                   a layout that text can't hold. Repeat for more.
  --caption TEXT   a caption under the files and rendered pages
  --voice TEXT     a voice note, TEXT spoken by atc's text-to-speech
  text...          a text message, Markdown converted to WhatsApp's own markup
                   (reads stdin when nothing else is given)

The files must be on the machine atc runs on (desktop).
`

func wa(args []string) error {
	var files, render, words []string
	var caption, voice string
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
		case flag == "h" || flag == "help":
			fmt.Print(waHelp)
			return nil
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
		case flag == "caption":
			caption, err = val()
		case flag == "voice":
			voice, err = val()
		default:
			return fmt.Errorf("unknown flag %s (atc wa -h)", a)
		}
		if err != nil {
			return err
		}
	}
	text := strings.Join(words, " ")
	if text == "" && len(files)+len(render) == 0 && voice == "" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		text = string(b)
	}
	if strings.TrimSpace(text) == "" && len(files)+len(render) == 0 && voice == "" {
		fmt.Print(waHelp)
		os.Exit(2)
	}
	sent, err := client.Load().WhatsApp(map[string]any{"text": text, "files": files, "render": render, "caption": caption, "voice": voice})
	if err != nil {
		return err
	}
	fmt.Println("Sent on WhatsApp: " + strings.Join(sent, ", "))
	return nil
}
