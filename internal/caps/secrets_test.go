package caps

import (
	"slices"
	"testing"

	"github.com/zcag/atc/internal/claude"
)

func TestSecretsStayOutOfSessions(t *testing.T) {
	var secret []string
	for _, c := range All() {
		for _, f := range c.Fields {
			if f.Secret {
				secret = append(secret, f.Key)
			}
		}
	}
	slices.Sort(secret)
	want := slices.Sorted(slices.Values(claude.Secrets))
	if !slices.Equal(secret, want) {
		t.Errorf("secret settings %v, but claude.Secrets keeps %v out of sessions", secret, want)
	}
}
