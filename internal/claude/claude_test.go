package claude

import "testing"

func TestIDFromPrefersTheCopy(t *testing.T) {
	for out, want := range map[string]string{
		"backgrounded · 3b616e9b · bgtest":                                                                             "3b616e9b",
		"woke session c008f8f0 with its saved options (--name)":                                                        "c008f8f0",
		"background session d2fec8b1 keeps its own saved options, so the flags you passed started a copy as c5d750bc.": "c5d750bc",
	} {
		if got, _ := idFrom(out); got != want {
			t.Errorf("idFrom(%q) = %q, want %q", out, got, want)
		}
	}
}
