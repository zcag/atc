# Usage and limits

The bar at the bottom of the session list shows how much of your Claude plan's current 5-hour
session and weekly limit you have used. Click it (or press `u`) for the usage page, across all
your sessions and machines: every limit with how far through its window you are, its pace and
reset time; then spend over the last 24 hours, 7, 30 or 90 days or all time, per day (per hour for
24 hours) by model; which hours you use it; where the cost goes (output, cache reads and writes);
and the bays, models, hosts and sessions that spent it. Pick a bar, bay, model or host and everything
else narrows to it, so a day's bar lists that day's biggest sessions. All time reaches as far back as
the transcripts on disk: Claude Code deletes old ones (`cleanupPeriodDays` in its settings).

## Where the limits come from

Claude Code hands the current limits to its status line command each time it draws the line. `atc
setup` sets that command to `atc limits -tap`, which saves what it gets for atc to show. If you have
your own status line, `atc setup` leaves it alone and prints the line to add at the start of your
script:

```sh
input=$(cat); printf '%s' "$input" | atc limits -tap
```

So the limits are as current as the last status line a running session drew, and with no session
running atc shows the last reading it has.

## One session's cost

Each session's header shows its tokens and an estimated cost; **Usage** in its menu breaks that
down: input, output and cache tokens, models, turns, tool calls, subagents (which Claude Code keeps
in their own transcripts), wall time and how long Claude was working. The cost is what the same
tokens would cost at Claude API list prices, an estimate for comparison, since a subscription is
not billed per token.
