// Package modes holds how the assistant talks on each channel (phone, whatsapp, atc, atc-voice, agent, guest).
// A file of the same name in Dir takes the place of the built-in one.
package modes

import (
	"embed"
	"os"
	"path/filepath"
	"strings"
)

//go:embed *.md
var builtin embed.FS

var Dir string

func Text(channel string) string {
	if Dir != "" {
		if b, err := os.ReadFile(filepath.Join(Dir, channel+".md")); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	b, _ := builtin.ReadFile(channel + ".md")
	return strings.TrimSpace(string(b))
}
