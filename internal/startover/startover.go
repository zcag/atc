package startover

import (
	"fmt"
	"time"
)

// Policy says when a standing conversation starts over: once it has been quiet for Quiet and is
// past Small tokens, or quiet for CapQuiet and past Cap.
type Policy struct {
	Quiet    time.Duration
	Small    int
	CapQuiet time.Duration
	Cap      int
}

var Default = Policy{Quiet: 6 * time.Hour, Small: 80_000, CapQuiet: 10 * time.Minute, Cap: 150_000}

// Due is why the conversation should start over now, or "" while it goes on.
func (p Policy) Due(quiet time.Duration, context int) string {
	if quiet > p.Quiet && context > p.Small || quiet > p.CapQuiet && context > p.Cap {
		return fmt.Sprintf("quiet %s, context %d", quiet.Round(time.Minute), context)
	}
	return ""
}
