package sessions

import (
	"os"
	"testing"
)

func TestBay(t *testing.T) {
	home, _ := os.UserHomeDir()
	for cwd, want := range map[string]string{
		home + "/proj/atc":                         "atc",
		home + "/proj/atc/.claude/worktrees/x/web": "atc",
		"/Users/someone/proj/shop":                 "shop",
		home + "/notes/daily":                      "notes",
		home:                                       "~",
		"/srv/data":                                "data",
		"/Users/someone/proj/Storefront/app/models/thing": "Storefront",
	} {
		if got := (Session{Cwd: cwd}).Bay(); got != want {
			t.Errorf("Bay(%q) = %q, want %q", cwd, got, want)
		}
	}
	if (Session{Cwd: home + "/proj/atc", Kind: "hub"}).Bay() != "" {
		t.Error("the assistant has no bay")
	}
}
