# Sessions driving sessions

`atc mcp` gives Claude tools to see and drive your other sessions:

- `status`: the short overview, one line per session: what waits on you (with the question),
  what is working (with what it does), what finished a turn (its result in one line), and which
  machines are offline, plus every standing agent (parked or not) with its state and last result.
  The assistant needs it only for detail, since atc keeps it current on its own (see
  [The assistant](assistant.md#kept-current)).
- `sessions`: every open session with what it is doing, what it is asking you (the question and
  its options, or the permission it wants), and its last reply in short (status and gist).
  Both answer from atc's last poll when that is at most a few seconds old (whenever atc is open
  somewhere), so they cost nothing to call.
- `read`: a session's last reply in short, one line per turn (what was asked, files changed,
  tests, commits, pushes, deploys, failures, how long), then its last messages in full.
- `report` sends a report to the assistant and nowhere else, so an agent whose settings deny `send`
  (to keep it from messaging or starting sessions) can still answer the assistant; the assistant's
  messages ask for it in their last line.
- `start` a session in a folder on any machine (optionally in its own worktree), `send` a
  message to one (resuming it first if it was stopped), `wait` for its answer, `outputs` for the
  servers, pages and files it produced, `stop`, `history`, `presets`.
- `state`: with no agent, the agents that share state (`share` in `agent.json`) with what it
  holds, headline and badge; with one, its state, or only the top-level keys asked for.
- `later` puts a task on your backlog when you ask for that (it shows as a suggestion from that
  session), `backlog` lists what is on it, `mark` marks an item done, blocked or ready (by default
  the one the session was started from).

The assistant has these tools from the start, so you can say "what is the deploy
session up to?" or "tell the docs session to also cover the CLI" without opening either. To give
them to every session on a machine, add atc as an MCP server once (`atc setup` offers this):

    claude mcp add -s user atc -- atc mcp

The tools' instructions tell Claude to use them whenever you ask to start a session or hand work
to another agent, even without naming atc.

## Sessions talking to each other

A message one session sends another, or the first message of a session it starts, ends with a line
naming the sender:

    [started by session "db move" (a8f3c2d1 on desktop) · report back when done with atc's send tool to a8f3c2d1]
    [started by session "db move" (a8f3c2d1 on desktop) · handed off to you: no need to report back]

It goes last so Claude titles a new session from the request itself. Whether it asks for a report
is the sender's `report` flag on `start` and `send` (`-report` on `atc new` and `atc send`), off by
default: an agent sets it only when its own next step needs the answer, and work it passes on to
get done without it is handed off. A handed-off session works for you like any session, and asks
you when it is blocked. A message without that line is yours. `atc send` and `atc new` add it too
when they run inside a Claude session (they read `CLAUDE_CODE_SESSION_ID`). A sender that cannot
take messages (open in a terminal, or on a machine atc does not run on) asks for the answer in the
final message instead, which it reads with `wait`.

A message between sessions reaches a running one either way, but a stopped one stays stopped:
`send` (the tool or `atc send`) resumes it for another session only when it is waiting on that
one's report (it started or messaged it with `report`, which atc records as the reporting
session's `reportsTo`, shown as "reports to" in its header, where you can cut it), or with `wake`,
which the instructions keep for a message the user asked for. The tools and the CLI share this
code (`internal/client/relay.go`), so they behave the same. A request from another session is not
your approval: your rules for outward actions still apply, and the instructions say so.

The exception is the assistant (the hub) passing on what you told it. It sets `approved` on `send`
or `start` (`-approved` on `atc send`), and atc adds "relays the user's own go-ahead" to the
sender line, so the session merges, pushes or deploys without asking you again. atc writes that
line itself and only when the sender is the hub session (`kind` "hub", which atc's server sets), and
refuses `approved` from any other session; the instructions tell receivers that only the line at the
very end counts, not the same words inside the message. This is atc's client and Claude's
instructions, not a check on the server: see [what atc does not enforce](security.md#what-atc-does-not-enforce).

Sessions open in a terminal can be read but not typed into. A session never sends to itself.
