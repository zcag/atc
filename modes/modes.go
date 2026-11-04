// Package modes holds the assistant's words: how it talks on each channel (phone, whatsapp, atc, agent, guest,
// guest-call), its standing prompts (hub, guests-desk) and the short lines atc puts in its conversation (lines.json).
// A file of the same name in Dir takes the place of the built-in one, so a user's own wording, language and rules
// live outside the code. A lines.json in Dir overrides key by key.
package modes

import (
	"cmp"
	"embed"
	"encoding/json"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

//go:embed *.md lines.json
var builtin embed.FS

var (
	Dir string
	// User and Assistant name the two in the built-in text ({{user}}, {{assistant}}, and capitalized at a sentence's
	// start); a file in Dir is the user's own words and is left as written.
	User, Assistant string
)

func named(s string) string {
	user, assistant := strings.ReplaceAll(User, "%", ""), strings.ReplaceAll(Assistant, "%", "")
	return strings.NewReplacer(
		"{{user}}", cmp.Or(user, "the user"), "{{User}}", cmp.Or(user, "The user"),
		"{{assistant}}", cmp.Or(assistant, "the assistant"), "{{Assistant}}", cmp.Or(assistant, "The assistant"),
	).Replace(s)
}

func Text(name string) string {
	if Dir != "" {
		if b, err := os.ReadFile(filepath.Join(Dir, name+".md")); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	b, _ := builtin.ReadFile(name + ".md")
	return named(strings.TrimSpace(string(b)))
}

func lines() map[string]string {
	out := map[string]string{}
	b, _ := builtin.ReadFile("lines.json")
	json.Unmarshal(b, &out)
	for k, v := range out {
		out[k] = named(v)
	}
	if Dir != "" {
		if b, err := os.ReadFile(filepath.Join(Dir, "lines.json")); err == nil {
			json.Unmarshal(b, &out)
		}
	}
	return out
}

func Line(key string) string { return lines()[key] }

// Rendered is every text the assistant gets with Dir applied, in a stable order: what `atc prompts` prints and
// checks, so a change to what a user's assistant is told shows up as a diff.
func Rendered() string {
	ents, _ := fs.ReadDir(builtin, ".")
	var out strings.Builder
	for _, e := range ents {
		if name, ok := strings.CutSuffix(e.Name(), ".md"); ok {
			out.WriteString("=== " + name + "\n" + Text(name) + "\n\n")
		}
	}
	l := lines()
	out.WriteString("=== lines\n")
	for _, k := range slices.Sorted(maps.Keys(l)) {
		out.WriteString(k + ": " + cmp.Or(strings.ReplaceAll(l[k], "\n", `\n`), "(empty)") + "\n")
	}
	return out.String()
}
