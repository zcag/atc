# atc

**Call your Claude Code sessions.** atc is a self-hosted console for every session on your machines: a
board of what needs you, an assistant that drives them for you, by text or on a phone call, standing
agents, and pages your agents make for you. In the browser, in a terminal and on your phone.

Sessions keep running when you close the tab, lose the connection or restart atc.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/hero-dark.webp">
  <img src="docs/img/hero-light.webp" alt="atc on a desktop: a session list, a transcript and the report page that session made, side by side, with a live call to the assistant docked on the right, a glowing orb above what the assistant is saying. In front, a phone with two sessions asking for an answer, each answerable in place, and a call button.">
</picture>

```sh
curl -fsSL https://github.com/zcag/atc/releases/latest/download/install.sh | sh
```

Linux or macOS, with Claude Code signed in. One install serves one user. [More ways to install](#install).

atc is an independent project. It is not affiliated with or endorsed by Anthropic.

## Call it

Talk to the assistant from the browser, the app or a real phone line. It knows which sessions wait on
you, answers from what they did, and passes your words on while you drive. It can ring you too: an agent
that needs a decision runs `atc call`, and when you pick up, the assistant says why it called and takes
your answer back to it. The orb moves with both voices and turns with what is happening: hearing you,
using a tool, speaking.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/call-dark.webp">
  <img src="docs/img/call-light.webp" alt="Four phones. The first shows the screen the side key opens: machines up, usage, memory, questions with their answers as buttons, and a green call button. The other three show one call: a teal orb while it hears you with your words appearing, an amber orb while it uses a tool, a violet orb while it speaks, with the sessions on the call listed below.">
</picture>

Runs on your own machine on 2 CPU cores, no phone or number needed. [Calls](docs/calls.md)

## One assistant, on every channel

One conversation with tools to see and drive everything else. Ask what is going on, have it start work
in any folder on any machine, and get told what came of it. What you type here, what you say on a call
and what you send on WhatsApp all reach the same conversation.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/assistant-dark.webp">
  <img src="docs/img/assistant-light.webp" alt="The assistant: you ask it to find out why checkout is slow and to fix a build on the laptop. It starts both sessions, reads what they found, shows a page and answers with the numbers, offering replies. On the left and under the conversation, the sessions it set going and what each is doing now.">
</picture>

[The assistant](docs/assistant.md) · [Sessions driving sessions](docs/sessions.md) · [WhatsApp](docs/whatsapp.md)

## Agents that keep going

An agent is one standing conversation under one name: your reviews, your CI, your mail. It wakes on a
schedule, when a check prints something, or when anything posts to it (a Grafana alert, a CI webhook),
does its work out of sight and comes back only when it has something for you. It keeps its state on a
page that the assistant can read, so "what's open?" needs no one to wake up.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/agents-dark.webp">
  <img src="docs/img/agents-light.webp" alt="The Agents screen: a list of standing agents with what each keeps, and the reviewer's details: when it wakes, the check that decides, when it starts over. In front, the page it keeps: three open pull requests, one needing a change.">
</picture>

[Presets and agents](docs/presets-and-agents.md)

## See what needs you

Every session on every machine, sorted by who is waiting: a question or a permission first, then finished
turns, then work in progress with what it is doing right now. Each row says its result in a line, so you
often need not open it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/board-dark.webp">
  <img src="docs/img/board-light.webp" alt="The board: sessions from two machines and five projects, grouped into pinned, waiting on you, working and parked, each with a status line, context used, steps, what it made and its age.">
</picture>

[Using atc](docs/using.md) · [Several machines](docs/machines.md)

## Read what happened

A transcript made for reading, however long the session: your prompt, the reply, and what happened
between them as a short story with word-level diffs, tests, commits and pages. Suggested replies send with
one tap. Find searches the whole session and filters to failures, commits and deploys.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/transcript-dark.webp">
  <img src="docs/img/transcript-light.webp" alt="A session's transcript: a word-level diff of the fix, a card for the page it made, then its report, with suggested replies above the message box.">
</picture>

## Pages your agents show you

An agent runs `atc show report.html` and it opens beside the conversation, live: it redraws on every edit.
Pages can keep state across devices, send you notes back and run actions the agent declared. A small kit makes
them look like atc in light and dark. Reports, handovers, dashboards, inboxes.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/pages-dark.webp">
  <img src="docs/img/pages-light.webp" alt="The Pages screen: every page from every session, grouped by project, with one agent's daily page open.">
</picture>

[Pages](docs/pages.md)

## A browser your sessions share, a terminal for each

Sessions get their own tabs in one shared Chromium, and you see those tabs live beside the conversation:
click and type in them for a login or a captcha, then let the agent carry on. Every session also has a
live terminal, in the page or from any computer with `atc attach`, and `atc` alone is the whole board as a
terminal UI (here inside atc's own terminal).

<table>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/browser-dark.webp">
  <img src="docs/img/browser-light.webp" alt="A session driving a checkout page in a browser tab, shown live beside its conversation, with an address bar you can use.">
</picture></td>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/terminal-dark.webp">
  <img src="docs/img/terminal-light.webp" alt="A session's terminal in the page, running atc's terminal UI: the same sessions as the board, with keys for attach, new, filter and history.">
</picture></td>
</tr>
</table>

[A browser for sessions](docs/browser.md) · [Using atc from a terminal](docs/using.md#from-a-terminal)

## Know what it costs

Plan limits with pace and a forecast of when you run out, spend by day, model, project and session. Memory and
CPU for every session and everything it started, a week back, including what outlived its session.

<table>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/usage-dark.webp">
  <img src="docs/img/usage-light.webp" alt="Usage: the 5-hour and weekly limits with a pace mark and a projection, then 30 days of spend per day by model, and the biggest sessions.">
</picture></td>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/resources-dark.webp">
  <img src="docs/img/resources-light.webp" alt="Resources: memory and CPU over 24 hours, stacked by session, and a process that outlived its session.">
</picture></td>
</tr>
</table>

[Usage and limits](docs/usage.md) · [Resources](docs/resources.md)

## In your pocket

The Android app is the same page in a native shell, plus what a browser cannot do: pushes when a session
needs you, calls that ring like a phone call, Bluetooth and Android Auto, a home-screen widget, sharing
anything to a session, and being your phone's digital assistant, so holding the side key opens the
screen on the left above, even on the lock screen.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/phones-dark.webp">
  <img src="docs/img/phones-light.webp" alt="Four phones: the board, a session's reply with suggested replies, the assistant, and the usage page.">
</picture>

[Android app](docs/android.md)

## And the rest

<table>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/palette-dark.webp">
  <img src="docs/img/palette-light.webp" alt="The palette over the board, finding sessions and pages by a few letters.">
</picture><br><b>Keyboard first.</b> A palette over everything, and a key for everything else.</td>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/new-dark.webp">
  <img src="docs/img/new-light.webp" alt="New session: a prompt, a folder picker, presets, the machine and the engine.">
</picture><br><b>Start anything anywhere.</b> Any folder on any machine, in its own worktree, from a preset, on <a href="docs/models.md">a local model or opencode</a>.</td>
</tr>
<tr>
<td><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/backlog-dark.webp">
  <img src="docs/img/backlog-light.webp" alt="The backlog: tasks by stage, some you added and some suggested by sessions.">
</picture><br><b>A backlog agents can add to.</b> Your tasks and their suggestions, started with one key. <a href="docs/backlog-and-notify.md">Backlog and notify</a></td>
<td><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/settings-dark.webp">
  <img src="docs/img/settings-light.webp" alt="Settings: the feature list, each row saying how it stands and how to set it up.">
</picture><br><b>It tells you what is set up.</b> Settings and <code>atc doctor</code> list each feature, how it stands and the fix. <a href="docs/settings.md">Settings and doctor</a></td>
</tr>
</table>

<img src="docs/img/themes.webp" alt="The same board cut into six slanted bands: three themes, each in dark and light.">

Light and dark, three themes, [one file to add another](docs/look.md). Every image here comes from atc running on
made-up sessions (`test/demo/`), with its real UI: a real hub, a browser and a second machine, on a fake Claude and a
scripted call line. The window and phone frames are drawn around the screenshots, and the phones are the page at phone
width.

## How it works with Claude Code

atc needs Claude Code installed and your own sign-in to it, on the machine atc runs on. It brings no
account and no key of its own.

- It runs the unmodified `claude` binary as the signed-in user: `claude --bg`, `claude attach`,
  `claude agents`, and `claude -p` for summaries.
- It reads what Claude Code keeps on disk for that user: conversation transcripts, its list of
  background sessions.
- It reads your plan limits from Claude Code's status line. `atc setup` sets that up
  (`atc limits -tap`), or tells you the line to add if you have your own status line.
- It changes Claude Code's own files in two places: `atc setup`, when you say yes, sets the status
  line and adds atc's MCP server; and atc lists its live sessions in `jobs/pins.json`, which keeps
  Claude Code's background service from retiring them.
- It does not proxy Claude's traffic, modify the `claude` binary, or send your sessions anywhere but
  the devices you connect. By default it does not read Claude Code's stored credentials.

Everything sessions spend comes out of your own plan or API key, under your agreement with Anthropic.

## Install

```sh
curl -fsSL https://github.com/zcag/atc/releases/latest/download/install.sh | sh
```

This downloads a release for Linux or macOS, checks its checksum, installs `atc` into `~/.local/bin`,
runs it and the assistant's hub as services of your user, and starts `atc setup`.

Or build from source (Go 1.26 or newer):

```sh
go install github.com/zcag/atc@latest
atc service install
```

Then:

1. `atc setup` asks who you are, sets the status line for plan limits, adds atc's tools for your
   sessions and says how to reach atc from other devices. It prints a link to open.
2. `atc doctor` lists what each feature needs, how it stands and the fix.
3. **Settings** in the page (`,`) shows the same list, with a field for each setting.

More in [Install](docs/install.md) and [Security](docs/security.md).

## What you turn on

Each layer needs the one before it. Only the first is needed to use atc.

| Layer | What | Needs |
|---|---|---|
| **Console** | Sessions, transcripts, pages, agents, backlog, usage, resources, sessions driving each other, short summaries of finished turns (a little of your plan; they can use your own model or be off) | Claude Code. Works right after install |
| **Assistant** | One conversation reachable from every screen | On by default, through a small second service |
| **Calls** | Talk to it from the browser or the app | `atc voice install`: about 2 GB on disk, runs on 2 CPU cores |
| **Outside lines** | WhatsApp, a SIM line, guests | Advanced: accounts and numbers of their own, and no promises |

## Docs

[Install](docs/install.md) ·
[Settings and doctor](docs/settings.md) ·
[Security](docs/security.md) ·
[Using atc](docs/using.md) ·
[Several machines](docs/machines.md) ·
[Android app](docs/android.md) ·
[Presets and agents](docs/presets-and-agents.md) ·
[Other models and opencode](docs/models.md) ·
[Pages](docs/pages.md) ·
[Backlog and notify](docs/backlog-and-notify.md) ·
[A browser for sessions](docs/browser.md) ·
[Outputs](docs/outputs.md) ·
[Summaries](docs/summaries.md) ·
[Usage and limits](docs/usage.md) ·
[Resources](docs/resources.md) ·
[Sessions driving sessions](docs/sessions.md) ·
[The assistant and its channels](docs/assistant.md) ·
[Calls](docs/calls.md) ·
[WhatsApp and speech services](docs/whatsapp.md) ·
[Look and themes](docs/look.md)

## License

MIT, see [LICENSE](LICENSE). What atc bundles and depends on is listed in
[THIRD_PARTY.md](THIRD_PARTY.md).
