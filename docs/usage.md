# Usage and limits

The bar at the bottom of the session list shows how much of your Claude plan's current 5-hour
session and weekly limit you have used. Click it (or press `u`) for the usage page, across all
your sessions and machines: every limit with how far through its window you are, its pace and
reset time; then spend over the last 24 hours, 7, 30 or 90 days or all time, per day (per hour for
24 hours) by model; which hours you use it; where the cost goes (output, cache reads and writes);
and the bays, models, hosts and sessions that spent it. Pick a bar, bay, model or host and everything
else narrows to it, so a day's bar lists that day's biggest sessions. Every dollar figure
comes with `% wk`, its size in weeks of your plan's limit: 100% wk is one full week, worked out from
what this week has spent so far divided by its percentage. That one rate is used for every amount,
whichever weeks it was spent in, so $8,000 over a month reads as, say, 270% wk. All time reaches as far back as
the transcripts on disk: Claude Code deletes old ones (`cleanupPeriodDays` in its settings).

## Your time

**Time**, beside Spend at the top right (or `#/time`, or Time in the palette), is how long you were at atc: today, the last 7
or 30 days or all of it, for every Claude account or one. It has your time per day and bay, when in a day
you were in which bay, your stretches and how often you switched sessions in them, the hours, the devices, and each session's
time beside what Claude spent in it. Pick a day or a bay and the rest narrows to it.

The page counts 5-second ticks while it is visible and focused, for the session that is open, or for the screen (the board,
pages, settings) when none is. Typing, clicking, scrolling, touching or moving the mouse, also inside a page a session showed
you, keeps it counting for a minute. A pause of up to 3 minutes, such as reading a long reply, counts once you move again or
switch away; of a longer one only the first minute does. Two devices at once count once, and atc open in a session's browser
tab doesn't count. Ticks that couldn't be sent go out with the next ones, up to 14 minutes later.

It leaves out other apps and tabs, `atc attach` in a terminal, and calls, so it is less than the time you worked.
`time.json` in atc's config folder keeps each session's total per day and `time/<day>.jsonl` the times of day.

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
in their own transcripts), wall time and how long Claude was working. Its amounts carry `% wk` too. The
week and 5-hour tiles count only what the session spent since that window opened. The cost is what the same
tokens would cost at Claude API list prices, an estimate for comparison, since a subscription is
not billed per token.

## More than one Claude account

Sessions in some folders can run on another Claude account, such as a company one for work:

```sh
atc profile add work ~/proj/work
CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
```

The first makes `~/.claude-work`, a Claude Code config folder of the account's own: its own sign-in,
transcripts, history and background daemon. It links your settings, `CLAUDE.md`, skills, commands, agents and
plugins from `~/.claude` and copies your MCP servers (run it again to bring over ones you add later). Restart
atc and every new session under `~/proj/work` runs on that account; New session has a **Claude account** choice
to pick another, `atc new -profile` and the `start` tool take one, and a preset or an agent can name one with
`"profile"`. A session resumes on the account that keeps its transcript (`atc profile move <session> <name>` moves
it, with its whole conversation, and resumes it there if it was open), and its turn summaries are written
on that account too, so its text never goes through another. Sessions on another account carry its name on
their row and in `atc ls`. An entry in `profiles.json` with only a name, like `{"name": "personal"}`, names the
default account.

The usage page then has a switch per account, each with its own limits and spend. An account billed per token
has no limits to show, and for it the dollar figures are close to what it pays. `atc profile` lists the
accounts and whether each is signed in; `profiles.json` in atc's config folder holds them, on each machine.
