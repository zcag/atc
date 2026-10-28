package whatsapp

import (
	"strings"
	"testing"
)

func TestFormatInline(t *testing.T) {
	for in, want := range map[string]string{
		"## Done":                        "*Done*",
		"**bold** and *it* and _it_":     "*bold* and _it_ and _it_",
		"~~gone~~":                       "~gone~",
		"see [the docs](https://x.io/a)": "see the docs (https://x.io/a)",
		"[https://x.io](https://x.io)":   "https://x.io",
		"* one\n  + two":                 "- one\n  - two",
		"`**not bold**` stays":           "`**not bold**` stays",
		"> **quoted**":                   "> *quoted*",
		"2 * 3 * 4":                      "2 * 3 * 4",
		"---":                            "───",
		"![shot](/tmp/a.png)":            "shot",
		"```go\nfunc x() {}\n```\nafter": "```\nfunc x() {}\n```\nafter",
	} {
		parts := Format(in)
		if len(parts) != 1 || parts[0].Text != want {
			t.Errorf("Format(%q) = %+v, want %q", in, parts, want)
		}
	}
}

func TestFormatTable(t *testing.T) {
	parts := Format("Here:\n\n| a | **b** |\n|---|:--:|\n| 1 | 2 |\n| 3 | 4 |\n\nend")
	if len(parts) != 3 || parts[0].Text != "Here:" || parts[2].Text != "end" {
		t.Fatalf("parts = %+v", parts)
	}
	if got := parts[1].Table; len(got) != 3 || got[0][1] != "b" || got[2][0] != "3" {
		t.Fatalf("table = %v", got)
	}
	if txt := TableText(parts[1].Table); !strings.Contains(txt, "a  b\n───") {
		t.Errorf("TableText = %q", txt)
	}
}

func TestFormatLongCode(t *testing.T) {
	code := strings.Repeat("line\n", 80)
	parts := Format("Look:\n```py\n" + code + "```")
	if len(parts) != 2 || parts[1].Lang != "py" || !strings.HasPrefix(parts[1].Code, "line\nline") {
		t.Fatalf("parts = %+v", parts)
	}
}

func TestSplit(t *testing.T) {
	long := strings.Repeat("word ", 300) + "\n\n" + "```\n" + strings.Repeat("x = 1\n", 200) + "```\n" + strings.Repeat("tail ", 300)
	chunks := split(long, 1000)
	if len(chunks) < 4 {
		t.Fatalf("got %d chunks", len(chunks))
	}
	for i, c := range chunks {
		if len(c) > 1000 {
			t.Errorf("chunk %d is %d bytes", i, len(c))
		}
		if strings.Count(c, "```")%2 != 0 {
			t.Errorf("chunk %d leaves a code block open: %q", i, c[max(0, len(c)-40):])
		}
	}
}
