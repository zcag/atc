# atc

atc is a web UI, a terminal UI and an Android app for Claude Code. It lists the sessions on all your machines and
shows which ones are waiting on you. You can reply to them from your phone, or call an assistant that knows what they're
all doing.

It runs on your own machines and uses your own Claude Code sign-in. Sessions live in Claude Code's background
service, so closing a tab or restarting atc doesn't stop them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/hero-dark.webp">
  <img src="docs/img/hero-light.webp" alt="atc on a desktop: an agent's session on the checkout errors, with the page it made beside it, a chart of errors jumping to 8% at the last deploy and what is failing. In front, a phone taking an incoming call from Assistant, Checkout errors jumped to 8% after the last deploy, with Decline and Answer buttons.">
</picture>

```sh
curl -fsSL https://github.com/zcag/atc/releases/latest/download/install.sh | sh
```

Linux or macOS, with Claude Code signed in. One install serves one user. [More ways to install](#install).

atc is an independent project. It is not affiliated with or endorsed by Anthropic.

## Sessions

Every session on every machine, in one list. Anything waiting on a permission or an answer is at the top, and each
row has a one-line summary of what the session last did.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/board-dark.webp">
  <img src="docs/img/board-light.webp" alt="The board: sessions from two machines and five projects, grouped into pinned, waiting on you, working and parked, each with a status line, context used, steps, what it made and its age.">
</picture>

[Using atc](docs/using.md) · [Several machines](docs/machines.md)

## Android app

You get a push when a session needs you, and you can answer from the notification. Holding the side key opens
what's waiting, on the lock screen too. Other apps can share a link or a screenshot into a session.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/phones-dark.webp">
  <img src="docs/img/phones-light.webp" alt="Four phones. The first shows the screen the side key opens: two sessions waiting, one with its question answered by buttons and a text field, one asking to run a git push with Allow once and Deny, and a green call button. The second shows a session's prompt, its steps and a small diff above its result. The third shows a finished report with one-tap replies, Push it and Draft the note for support. The fourth shows the report page that session made, with its figures and a chart.">
</picture>

There's no iOS app; atc works in a phone's browser. [Android app](docs/android.md)

## Calls

Anything urgent can ring your phone:

```sh
atc call --reason "Checkout errors jumped to 8% after the last deploy"
```

The assistant is on the line when you pick up.

> **Assistant:** Hey, sorry to call. Checkout errors jumped to 8% right after the last deploy, and the coupon change looks like the cause. Do you want me to...
>
> **You:** Wait, was that the only thing in the deploy?
>
> **Assistant:** That and a copy fix. The errors all come from the coupon code.
>
> **You:** Okay, roll it back, and have someone find out why.
>
> **Assistant:** Rolling back now, and I've started a session on the cause. The iOS build on the laptop just finished too, so that's one less thing.
>
> **You:** How many orders did we lose?
>
> **Assistant:** About forty, in eleven minutes. I put the chart on your screen.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/call-ring-dark.webp">
  <img src="docs/img/call-ring-light.webp" alt="Three phones. The first has woken to an incoming call: Assistant, with the reason under the name, Checkout errors jumped to 8% after the last deploy, and a red and a green button. The second is on the call: Assistant, a call timer, what it is saying, and mute, hang up and speaker buttons. The third is the phone's call history, with Assistant listed like any other caller.">
</picture>

You can call it as well, from the app or a browser. Calls run on your machine and need `atc voice install`: about 2 GB of
disk and 2 CPU cores, and no phone number. [Calls](docs/calls.md) · [A recorded demo call](docs/img/call-demo.mp4)

## The assistant

One long-running Claude conversation with tools to read, start and message your other sessions. Ask it to find out why
checkout is slow and to fix the build on the laptop, and it starts a session for each and tells you when they're done. Typing
to it, calling it and writing to it on WhatsApp all reach the same conversation.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/assistant-dark.webp">
  <img src="docs/img/assistant-light.webp" alt="The assistant: you ask it to find out why checkout is slow and to fix a build on the laptop. It starts both sessions, reads what they found, shows a page and answers with the numbers, offering replies. On the left and under the conversation, the sessions it set going and what each is doing now.">
</picture>

[The assistant](docs/assistant.md) · [Sessions driving sessions](docs/sessions.md) · [WhatsApp](docs/whatsapp.md)

## Agents

An agent is a folder with instructions and a rule for when to wake up. This one reviews new pull requests:

```json
{
  "host": "desktop",
  "title": "Reviewer",
  "every": "30m",
  "check": "gh pr list --search review:none",
  "prompt": "Review what opened since last time."
}
```

It wakes every 30 minutes, only if the check prints something. A webhook can wake one too, such as a Grafana alert. An
agent keeps one conversation across wake-ups and stays out of your session list until it has something for you.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/agents-dark.webp">
  <img src="docs/img/agents-light.webp" alt="The Agents screen: a list of standing agents with what each keeps, and the reviewer open: its conversation, and beside it the page it keeps, three open pull requests, one needing a change.">
</picture>

[Presets and agents](docs/presets-and-agents.md)

## Transcripts

A reading view of a session, however long it gets: each prompt and reply, with the steps between them folded into a
line and the diffs, test results and commits marked. Search covers the whole session and can filter to failures. Likely replies
are one tap away.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/transcript-dark.webp">
  <img src="docs/img/transcript-light.webp" alt="A session's transcript: a word-level diff of the fix, a card for the page it made, then its report, with suggested replies above the message box.">
</picture>

## Pages

A session can show you a file:

```sh
atc show report.html
```

It opens beside the conversation and redraws when the file changes. HTML, Markdown, images, PDF and CSV all work. An HTML
page can keep state and run commands the session declared, so an inbox page can have a working mark-read button.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/pages-dark.webp">
  <img src="docs/img/pages-light.webp" alt="The Pages screen: every page from every session, grouped by project, with one agent's daily page open.">
</picture>

[Pages](docs/pages.md)

## Shared browser

Sessions can share one Chromium through `atc browser mcp`. Logins are shared and each session sees only its own tabs.
Its tab shows live beside the conversation, and you can click and type in it, which gets it past a login or a captcha.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/browser-dark.webp">
  <img src="docs/img/browser-light.webp" alt="A session driving a checkout page in a browser tab, shown live beside its conversation, with an address bar you can use.">
</picture>

[A browser for sessions](docs/browser.md)

## Limits and resources

Your 5-hour and weekly limits, with a projection of when you'd hit them at the current pace. Spend by day, model, project
and session. Memory and CPU per session, including processes still running after their session ended.

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

## Also

<table>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/new-dark.webp">
  <img src="docs/img/new-light.webp" alt="New session: a prompt, a folder picker, presets, the machine and the engine.">
</picture><br><b>New session.</b> Any folder on any machine, in its own git worktree if you like, on Claude or <a href="docs/models.md">a local model</a>.</td>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/backlog-dark.webp">
  <img src="docs/img/backlog-light.webp" alt="The backlog: tasks by stage, some you added and some suggested by sessions.">
</picture><br><b>Backlog.</b> Tasks you haven't started and sessions you've set aside. <a href="docs/backlog-and-notify.md">Backlog</a></td>
</tr>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/terminal-dark.webp">
  <img src="docs/img/terminal-light.webp" alt="A session's terminal in the page, running atc's terminal UI: the same sessions as the board, with keys for attach, new, filter and history.">
</picture><br><b>Terminal.</b> <code>atc</code> is the same list as a terminal UI. <code>atc attach</code> opens a session. <a href="docs/using.md#from-a-terminal">From a terminal</a></td>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/palette-dark.webp">
  <img src="docs/img/palette-light.webp" alt="The palette over the board, finding sessions and pages by a few letters.">
</picture><br><b>Search.</b> <code>/</code> finds sessions, pages and commands. Most things have a key.</td>
</tr>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/settings-dark.webp">
  <img src="docs/img/settings-light.webp" alt="Settings: the feature list, each row saying how it stands and how to set it up.">
</picture><br><b>Settings.</b> <code>atc doctor</code> and the settings page check what each feature needs and give the fix. <a href="docs/settings.md">Settings and doctor</a></td>
<td width="50%"><img src="docs/img/themes.webp" alt="The same board cut into six slanted bands: three themes, each in dark and light."><br><b>Themes.</b> Three, light and dark. <a href="docs/look.md">A new one is one CSS file.</a></td>
</tr>
</table>

The screenshots come from `test/demo/`: atc's real UI on made-up sessions, a fake Claude and a scripted call line, with made-up
figures on the Resources screen. The frames are drawn on. The phones are a debug build of the app on a test device, and the call
history is an open-source dialer reading the phone's real call log.

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
runs it and the assistant as services of your user, and starts `atc setup`.

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

## What you need for what

The core and the assistant work right after install. The rest is optional.

| | What you get | What it takes |
|---|---|---|
| **Core** | The session list, transcripts, pages, agents, backlog, usage, one-line summaries of finished turns | Claude Code. The summaries use a little of your plan; they can use your own model or be off |
| **Assistant** | One conversation that runs the others | On by default, a small second service |
| **Calls** | Talk to it from the browser or the app | `atc voice install`: about 2 GB on disk, 2 CPU cores |
| **WhatsApp and a phone number** | Reach it from WhatsApp or a real number, and let a few other people reach it | Advanced: accounts and numbers of their own, and no promises |

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
