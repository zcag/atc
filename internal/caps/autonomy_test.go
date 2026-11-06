package caps

import (
	"context"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/settings"
)

func TestCheckAutonomySaysWhenAgentsOnACallSkipIt(t *testing.T) {
	env := Env{Get: func(k string) string {
		if k == "ATC_CLAUDE_ARGS" {
			return "--dangerously-skip-permissions"
		}
		return ""
	}}
	if r := checkAutonomy(context.Background(), env); !strings.Contains(r.Detail, "Daily") || !strings.Contains(r.Detail, "ATC_CLAUDE_ARGS") {
		t.Errorf("%+v", r)
	}
}

func TestCheckAutonomy(t *testing.T) {
	for _, c := range []struct {
		level, args string
		want        Status
		says        string
	}{
		{"", "", OK, "Daily"},
		{"daily", "", OK, "Daily"},
		{"limited", "", OK, "Limited"},
		{"full", "", OK, "no checks"},
		{"lots", "", Broken, "runs as daily"},
		{"limited", "--dangerously-skip-permissions", OK, "ATC_HUB_CLAUDE_ARGS"},
	} {
		env := Env{Get: func(k string) string {
			switch k {
			case settings.AutonomyKey:
				return c.level
			case "ATC_HUB_CLAUDE_ARGS":
				return c.args
			}
			return ""
		}}
		if r := checkAutonomy(context.Background(), env); r.Status != c.want || !strings.Contains(r.Detail, c.says) {
			t.Errorf("%q %q: %+v", c.level, c.args, r)
		}
	}
}
