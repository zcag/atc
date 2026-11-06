# The assistant and its channels

`atc hub` keeps the assistant as one conversation that atc, WhatsApp and phone calls all talk into.
It runs Claude as a stream-json process (`claude -p`), so a reply streams to whoever asked as it is
written, and it runs as its own service, so restarting atc never cuts a call:

```sh
atc service install --only hub           # installs atc-hub; atc service install does both
ATC_HUB=http://127.0.0.1:8820            # in ~/.config/atc/env: atc talks to it there
ATC_HUB_CLAUDE_ARGS=...                  # optional extra flags for its Claude
atc hub status · atc hub reset           # what it is doing; start over now
```

Installed the usual way, the assistant works with nothing accepted: `claude -p` doesn't ask for trust,
and its folder is atc's own (`~/.local/share/atc/assistant`). Without a hub (`atc serve` by hand, or
`--only atc`) it is a background session, in `ATC_ASSIST_DIR`, by default that same folder; Claude Code
requires a yes for that, so the page asks you once with its own prompt.

## What it may do alone

On a call or on WhatsApp nobody can tap Allow, so whatever isn't allowed beforehand is refused, and the assistant hands that
work to a session, which asks you as usual. You choose how much in `atc setup` or Settings, Assistant (`ATC_ASSISTANT_AUTONOMY`):

| Level | It may |
|---|---|
| `limited` | use atc's tools, show you pages (`atc show`, `atc open`), and reach you (`atc wa`, `atc call`, `atc notify`) |
| `daily`, the default | also read your files, search the web, keep notes in its own folder, and run `atc guest` |
| `full` | do anything Claude can, with no checks (`--dangerously-skip-permissions`). A message or page that fools it can do real damage |

`daily` can read anything your user can, atc's token included, and can reach the web, so something it reads could talk it
into sending what it read somewhere: [Security](security.md) says more. For more than `daily` without going to `full`, add
allow rules to Claude Code's own settings, which still apply. `ATC_HUB_CLAUDE_ARGS` is added last. The guests' conversation
is not affected by this: it may only use atc's tools, answer a guest, use the guests' folder and look things up. An agent on a
call [follows the same level](presets-and-agents.md#on-a-call), with its own folder.

## How it reaches you

With `ATC_HUB` set, the Assistant button, the side key and WhatsApp all reach the hub's session. It
shows in the list as **assistant**, with no terminal: its transcript is the chat, the box under it
writes to it, the reply appears as it is written, and Esc or Stop interrupts it. A phone call is a
third channel: the talker connects as `phone` (`ws://127.0.0.1:8820/ws?channel=phone`). See
[Calls](calls.md).

## Channels

Each message is tagged with where it came from: `atc`, `whatsapp`, `phone` and `agent` (another
session's `send`). The guest channels, `guest` (someone else on WhatsApp, see
[Guests](whatsapp.md#guests)) and `guest-call` (a guest calling the assistant's line: the talker
answers the numbers in the guest list too and connects as this channel, so the reply is spoken to them
under `modes/guest-call.md`), are served on the same paths but go to the guests' conversation, whose
own API is under `/guests/` (`/guests/status`, `/guests/events`); there a guest call's turns go first
and hold its WhatsApp guests, and neither gets atc's feed of your sessions. When the channel changes,
the message carries that channel's rules from `modes/<channel>.md` (built in; a file of the same name
in `~/.config/atc/modes/` takes its place), so the session writes Markdown for atc, short spoken
sentences on a call, and phone-screen messages on WhatsApp. A report from another session gets an
answer that goes to no one: it stays in the conversation. The report carries `modes/agent.md` and a
line saying whether you are on a call and which channel you last wrote from, so the session decides
whether to tell you (`atc notify`, `atc wa`). During a call, your next message on the call reminds the
session that a report came in, so it says what matters in that spoken reply.

## Kept current

The assistant never has to poll atc or answer from memory. atc keeps a feed of what changes in the
list: a session that needs you, finishes a turn, starts or stops, and a machine that goes offline or
comes back. The hub puts that feed in front of every message: the whole state (`[atc now, HH:MM]`:
your Triage screen as text, the same bays in the same order: Your turn, Pinned, Working, Parked,
Stopped, Offline; a pinned or parked session that leaves an Open item moves up into Your turn; an
agent with no `every` is tagged "last run Xh ago, runs only when woken, so not live", since its result
is from whoever last woke it) on the first message of a conversation and whenever the channel changes
(so each call starts with it), and otherwise only what changed since the last message (`[atc since
your last turn, HH:MM]`, one line per session). When a session starts needing you while a phone turn
is running a tool, the change joins that turn at once, so the assistant can judge whether to say it
now, in a line, or later (`modes/phone.md`). A call only speaks answers to your own words, so between
turns the change waits for your next one. The hub reads the feed from
`GET /api/feed?since=SEQ[&full=1]` on atc; atc wakes it with `POST /notice`.

## Several at once

A message that arrives while the session works joins the turn it is on, and each part of the reply
goes to the channel of the newest message the session had read when it wrote it. Text from atc or
WhatsApp while the phone is part of the turn waits until that turn ends, so a call never reads out an
answer meant for a screen. A barge-in on the call interrupts only what is being said to the call.

## Starting over

When the conversation has been quiet for 6 hours and is past 80k tokens, or quiet for 10 minutes and
past 150k (the same rule as [agents](presets-and-agents.md#starting-over)), never during a call, the
hub has the session write a handover note in one last turn and opens a new session with it as the
first message. `/new` on WhatsApp, a fresh assistant in atc and `atc hub reset` do it at once. The old
conversation stays in atc as **assistant MM-DD hh:mm**; the notes are in
`~/.local/state/atc/hub/handovers/`.

## When the hub is down

WhatsApp and the Assistant button fall back to a plain background session resumed from the hub's
conversation. When the hub is back, atc stops it; what was said there stays in its own transcript, and
if Claude gave it a new session id, the hub does not see it.

## Endpoints

For clients other than atc: `GET /ws?channel=NAME` (send `{"type":"message","text"}`,
`{"type":"note","text"}` or `{"type":"interrupt"}`; get `text`, `tool`, `block`, `read`, `joined`,
`held`, `done`, `error`, `notice`), `GET /events` (every channel's events), `GET /status`,
`POST /message {channel, text}`, `POST /interrupt {channel}`, `POST /reset`, `POST /notice`,
`POST /call {reason, from, notify, timeout, whatsapp}`.
