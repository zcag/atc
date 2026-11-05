# Presets and agents

## Presets

Name the sessions you start often, each with its folder and standing instructions, in
`presets.json` in atc's config folder (`~/.config/atc/` by default) on the machine they run on:

```json
[
  { "name": "reviewer", "dir": "~/work/app", "brief": "REVIEWER.md" },
  { "name": "notes", "dir": "~/notes", "brief": "~/notes/assistant.md", "worktree": false }
]
```

They show as one-tap choices in New session (from every machine), as `atc new -p reviewer`, and
to the assistant ("start the reviewer"). `brief` is a file, relative to `dir` or absolute,
read fresh at each start and given to Claude as instructions rather than as your first message, so
the session's title comes from what you actually ask. `args` adds Claude Code flags; `worktree`
starts it in its own git worktree.

A preset is a template you start by hand. For something that runs on its own and keeps one
conversation, make an [agent](#agents).

## Agents

An agent is one standing conversation under one name, for something you come back to: your mail,
an invoice, CI alerts. It is a folder under `agents.d/` in atc's config folder, or under
`ATC_AGENTS`. Point that at a synced folder and every machine sees the same agents; each one runs
only the agents whose `host` names it.

```
email/
  agent.json      what atc needs (below)
  brief.md        its standing instructions, read fresh at every start
  settings.json   optional: Claude Code settings (permissions), passed as --settings
  mcp.json        optional: MCP servers, passed as --mcp-config
  notes.md        what it keeps across conversations (it writes this itself)
```

```json
{ "host": "desktop", "title": "Email", "icon": "mail", "color": "blue",
  "every": "5m", "check": "./check.sh", "prompt": "Unread mail to triage.",
  "reset": { "quiet": "6h", "over": 80000 } }
```

- `host` (required): the machine it runs on.
- `title`, `icon` (one of mail, sun, present, lira, target, inbox, calendar, chart, pr, globe,
  pulse, doc, or an emoji) and `color` (blue, amber, violet, green, red, teal, pink, orange, slate,
  or a hex color): how it looks.
- `dir`: the folder its conversation works in, default the agent's own folder. With one, its
  conversation also shows in that project's tab. `args`: more Claude Code flags.
- `every`, `from`, `check`, `prompt`: when it wakes up (below). `prompt` also starts its first
  conversation from atc.
- `reset`: when its conversation starts over (below).
- `talk`: `true` lets the user talk to it directly on a call ([Talking to an agent](calls.md#talking-to-an-agent)), off
  by default. `person` names who it sounds and looks like there.
- `share`: `{"page": "items", "about": "what it holds"}` names the page whose state other sessions
  read with the `state` tool, so the assistant answers "what's open?" from it instead of asking the
  agent. Give that state a `headline` and `badge` and keep its keys small and named (`counts`
  apart from `items`), since a reader can ask for single keys.

Edits apply without a restart: atc rereads the folders, and the brief is read at every start and
resume. Before the brief, atc tells the agent its name and folder, that it keeps durable things in
`notes.md`, and when to park itself.

### One conversation

Every message reaches the same conversation: the running one, the last one resumed, or a new one
when it has none. A message that arrives mid-turn waits for the turn to end (Claude Code queues it).
Its pages belong to the agent (`@name`), not to one conversation, so they and their state carry
across. Its sessions carry its title, and `@name` names its current conversation anywhere a session
is named: `atc send @email`, `atc attach @email`, `atc state @email inbox`, and the MCP tools.

### Waking it

On a schedule: with `every` (`90s`, `5m`, `1h`, or whole days and weeks: `1d`, `2w`) it wakes on that
interval with `prompt`. With `from`, a local date and time, wake-ups land on `from` plus whole
multiples of `every` (`"every": "2w", "from": "2026-03-06T09:00"` is every second Friday at 09:00),
keeping the wall-clock time across daylight saving. With `check`, a shell command run in the agent's
folder, it wakes only when that exits 0 and prints something, and the message is `prompt` followed by
what it printed. A check gets a minute. A wake-up is skipped while the conversation is working or
needs you, and one missed while atc was down is not made up. Each decision is in the journal
(`agent email: …`).

From anything: `atc send @name [text]` (stdin when no text), or

```sh
curl -H "Authorization: Bearer $TOKEN" --data-binary @alert.json "https://atc.example/api/agents/cicd/message?from=grafana"
```

The body is `{"text": ...}` or anything else as it came (a Grafana alert, a CI payload); empty, it is
the agent's `prompt`. With `from`, the message starts `[message from grafana]` and the request
answers 202 at once, so a webhook never times out and retries. Any machine takes it: atc forwards it
to the agent's `host`. A Grafana webhook contact point with that URL and the token as its
Authorization header is all it takes; Grafana's grouping and repeat interval are the throttle.

### Parking

A parked agent is out of the session list (its row stays in the Agents tab) and sends no pushes. It
parks itself when its work with you is done, with atc's `park` tool or `atc park`, and you can park it
by hand. A wake-up leaves it parked: it works out of sight and unparks itself (`park` with `unpark`)
only when it has something for you. Typing to it unparks it. A question or a permission prompt brings
it back even while parked (this holds for any parked session).

### Starting over

Only while it is parked, so never in the middle of work with you: when the conversation has been
quiet for `reset.quiet` (default 6h) and is past `reset.over` tokens (80k), or quiet for
`reset.capQuiet` (10m) and past `reset.cap` (150k), atc asks it for a handover note, starts a new
conversation with that note as its first message (parked if the old one was), and takes the old one
off Claude's list under a dated name, its transcript kept. A conversation with nothing in it since it
started over is left alone, so an idle agent never starts over twice. **Start over** in its menu does
it now. The notes are in `agents/<name>/` in atc's config folder. This is the assistant's rule too
(`internal/startover`).

### In the UI

An agent's conversation is a session like any other, under the agent's title and icon. The **Agents**
tab (the robot icon next to All in the project tabs) lists them the way a project tab lists its
sessions, parked ones included, with the same dots; agents with no conversation yet are listed below
by name. An agent with a `dir` also shows in that project's tab; the rest stay out of the project
tabs. Picking an agent on the Agents screen opens its conversation beside the list, with its page if it
has one, the stopped conversation if none is running. An agent's tag, in place of the project tag,
and **Agent details** in the session's menu open its details: what it is doing, when it wakes and when next, its check and prompt, when it starts over and last
did, its pages and folder, with Open (or Start), Wake, Park and Start over. The assistant (the hub's
conversation, see [The assistant](assistant.md)) is listed there too, with its own reset rule and no
dot while it is idle, since it never parks; `POST /api/agents/assistant/message` reaches it as another
session would. It opens with its page beside the conversation, and **Start over** is in its menu with
Park. A note from its page reaches its conversation even when it is stopped.

`GET /api/agents` lists the agents of every machine with their behaviour, current conversation, and
page `headline` and `badge`. `POST /api/agents/<name>/reset` starts one over.
