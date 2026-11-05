# atc

**Air traffic control for Claude Code.** Every session on every machine, a team of agents working in the background, and an
assistant you can call on the phone. All of it on your own machines, from a browser, a terminal or your phone.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/hero-dark.webp">
  <img src="docs/img/hero-light.webp" alt="atc's main screen, one window with three panes. On the left, the sessions of one project with what each did in a line. In the middle, the session Fix the coupon crash: your request, what it did as a short story with one failed test, and the edit as a diff. On the right, the page it made: 8.2% errors at the peak, 231 failed checkouts replayed and all passing, a chart of errors jumping at the deploy and falling at the rollback, and the cause.">
</picture>

```sh
curl -fsSL https://github.com/zcag/atc/releases/latest/download/install.sh | sh
```

Linux or macOS, with Claude Code signed in. One install serves one user. [More ways to install](#install).

atc is an independent project. It is not affiliated with or endorsed by Anthropic.

## Every session, wherever you are

All your sessions from all your machines in one list, with whatever is waiting on you at the top and a one-line result on each.
Start one in any folder on any machine, and open any of them from a browser, a terminal or your phone.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/board-dark.webp">
  <img src="docs/img/board-light.webp" alt="The board: sessions from three machines and eleven projects, grouped into pinned, waiting on you, working and parked, each with a status line, context used, steps, what it made and its age.">
</picture>

The Android app pushes when a session needs you, and you can approve or answer from the notification. Holding the side key opens
what's waiting, even on the lock screen. Share a link or a screenshot from any app into a session, or see them all on a home
screen widget.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/phones-dark.webp">
  <img src="docs/img/phones-light.webp" alt="Four phones. The first shows the screen the side key opens: sessions waiting, one with its question answered by buttons and a text field, others asking to run a command with Allow once and Deny, and a green call button. The second shows a session's prompt, its steps and a small diff above its result. The third shows a finished report with one-tap replies, Push it and Draft the note for support. The fourth shows the report page that session made, with its figures and a chart.">
</picture>

Back at a desk, read what a session did as a transcript: each prompt and reply with the diffs, test results and commits, and search
across the whole thing. Likely next messages are one tap away.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/transcript-dark.webp">
  <img src="docs/img/transcript-light.webp" alt="A session's transcript: a word-level diff of the fix, a card for the page it made, then its report, with suggested replies above the message box.">
</picture>

[Using atc](docs/using.md) · [Android app](docs/android.md) · [Several machines](docs/machines.md)

## An assistant you can call

One conversation that can see everything: your sessions, your agents, what just changed. It answers on a phone call, in
the page and on WhatsApp, and it's the same conversation on all three. Anything urgent can ring you:

```sh
atc call --reason "Checkout errors jumped to 8% after the last deploy"
```

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
  <img src="docs/img/call-ring-light.webp" alt="Two phones. The first has woken to an incoming call: Assistant, with the reason under the name, Checkout errors jumped to 8% after the last deploy, and a red and a green button. The second is on the call: Assistant, a call timer, what it is saying, and mute, hang up and speaker buttons.">
</picture>

You can talk over it, and it hears you. It says what it's doing while it works, starts sessions for anything long, and tells you
how they came out after you've hung up. Calling it needs no phone number, and it runs on your machine on 2 CPU cores.
[Calls](docs/calls.md) · [A recorded demo call](docs/img/call-demo.mp4) · [The assistant](docs/assistant.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/assistant-dark.webp">
  <img src="docs/img/assistant-light.webp" alt="The assistant: you ask it to find out why checkout is slow and to fix a build on the laptop. It starts both sessions, reads what they found, shows a page and answers with the numbers, offering replies. On the left and under the conversation, the sessions it set going and what each is doing now.">
</picture>

## A team of agents

An agent is someone you go to for one thing. It keeps its own notes, keeps one long conversation, and wakes up when there's work.

| | Wakes | Does |
|---|---|---|
| **@ops** | when an alert fires | Investigates, fixes the obvious on your machines, and rings you with the rest already worked out |
| **@shopping** | every morning | Researches what's on your list across stores, checks stock and price, leaves a few options to pick from |
| **@email** | when you ask | Sorts your inboxes onto a page you can act on. Marks read what you say, and never sends |
| **@reviewer** | when a pull request has no review | Reads it and writes down what it thinks |
| **@invoice** | every second Friday | Prepares the invoice and the email, and sends on your go |
| **@tracker** | every 3 hours | Sweeps mail, calendar and GitHub into one list of everything open |

We run agents like these every day. You make your own: each is a folder with a page of instructions and a rule for when to wake.

```json
{ "title": "Ops", "check": "./unresolved-alerts.sh", "every": "2m", "prompt": "Look into these." }
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/agents-dark.webp">
  <img src="docs/img/agents-light.webp" alt="Eight windows, one team. The Agents list: @email, @invoice, @ops, @reviewer, @shopping, @standup and @tracker, each with what it is keeping track of, its last result, and when it wakes next. Then each agent's own page: @shopping's options with prices and stock and Pick buttons; @ops's alerts today, three fixed and one that rang you; @email's inbox sorted with buttons to act on; @tracker's 23 open items, the 4 that cost you something first; @invoice's invoice ready for your go; @standup's draft from yesterday; and @reviewer's pull requests.">
</picture>

Between wake-ups they stay out of your way. Ask one something any time with `atc send @shopping "the towel, in grey"`, point a
Grafana alert or a CI webhook at it, or let the assistant read what it knows: "what's open?" gets answered from @tracker's list
without waking anyone. [Agents](docs/presets-and-agents.md)

## Work you can see and step into

A session can put anything in front of you. `atc show report.html` opens it beside the conversation and redraws it as the file
changes: a chart, a comparison, an inbox with working buttons. Every page from every session stays one screen away, on your phone too.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/pages-dark.webp">
  <img src="docs/img/pages-light.webp" alt="The Pages screen: every page from every session, grouped by project, with one agent's alerts page open.">
</picture>

Sessions drive a real browser too. Each gets its own tabs with your logins shared, and you watch them live next to the conversation.
When one hits a login or a captcha, click and type in its tab and it carries on.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/browser-dark.webp">
  <img src="docs/img/browser-light.webp" alt="A session driving a checkout page in a browser tab, shown live beside its conversation, with an address bar you can use.">
</picture>

[Pages](docs/pages.md) · [A browser for sessions](docs/browser.md)

## Keep it all running

Your 5-hour and weekly limits with a projection of when you'd hit them, and spend by day, model, project and session. Memory and CPU
per session, a week back, including the dev server a finished session left behind. After a reboot, atc brings your sessions back
and tells the interrupted ones to continue.

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

## And a lot more

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/fleet-dark.webp">
  <img src="docs/img/fleet-light.webp" alt="atc on a desktop with a lot going on: the board with sixteen sessions waiting and thirteen working across three machines, and in front of it @ops's session on the checkout errors with the page it made, a chart of errors jumping to 8% at the last deploy. In front of those, a phone taking an incoming call from Assistant, Checkout errors jumped to 8% after the last deploy, with Decline and Answer buttons.">
</picture>

<table>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/new-dark.webp">
  <img src="docs/img/new-light.webp" alt="New session: a prompt, a folder picker, presets, the machine and the engine.">
</picture><br><b>Start anything.</b> Any folder on any machine, in its own git worktree, from a preset, on Claude, <a href="docs/models.md">a local model or opencode</a>.</td>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/backlog-dark.webp">
  <img src="docs/img/backlog-light.webp" alt="The backlog: tasks by stage, some you added and some suggested by sessions.">
</picture><br><b>A backlog.</b> Tasks for later, sessions set aside to resume, and suggestions from your agents. <a href="docs/backlog-and-notify.md">Backlog</a></td>
</tr>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/terminal-dark.webp">
  <img src="docs/img/terminal-light.webp" alt="A session's terminal in the page, running atc's terminal UI: the same sessions as the board, with keys for attach, new, filter and history.">
</picture><br><b>A terminal UI.</b> <code>atc</code> is the whole list in your terminal, and <code>atc attach</code> opens any session. <a href="docs/using.md#from-a-terminal">From a terminal</a></td>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/palette-dark.webp">
  <img src="docs/img/palette-light.webp" alt="The palette over the board, finding sessions and pages by a few letters.">
</picture><br><b>A key for everything.</b> <code>/</code> finds any session, page or command.</td>
</tr>
<tr>
<td width="50%"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/settings-dark.webp">
  <img src="docs/img/settings-light.webp" alt="Settings: the feature list, each row saying how it stands and how to set it up.">
</picture><br><b>Setup that checks itself.</b> <code>atc doctor</code> and Settings test every feature and give the fix. <a href="docs/settings.md">Settings and doctor</a></td>
<td width="50%"><img src="docs/img/themes.webp" alt="The same board cut into six slanted bands: three themes, each in dark and light."><br><b>Themes.</b> Three, light and dark. <a href="docs/look.md">A new one is one CSS file.</a></td>
</tr>
</table>

- **Sessions that run each other.** `atc mcp` gives any session tools to read, start and message the others. [Sessions driving sessions](docs/sessions.md)
- **WhatsApp.** Text it, send photos and voice notes, and get answers back as voice notes. Let a few other people reach it too, in a conversation of their own. [WhatsApp](docs/whatsapp.md)
- **Notifications from anything.** `atc notify` from a session, with one-tap replies. [Notify](docs/backlog-and-notify.md)
- **Your phone as its home.** Digital assistant role, Quick Settings tile, Android Auto and Bluetooth for calls, QR pairing with per-device revoke. [Android app](docs/android.md)
- **Summaries of every finished turn**, at three lengths, on your plan or your own model. [Summaries](docs/summaries.md)
- **Everything over HTTP and JSON.** The API behind the page is open to your scripts, and CLI commands take `-json`.

The screenshots come from `test/demo/`: atc's real UI on made-up sessions and a fake Claude whose lines on calls are written for the demo, with made-up figures
on the Resources screen. The frames are drawn on. The phones are a debug build of the app on a test device.

## How it works with Claude Code

atc needs Claude Code installed and your own sign-in to it, on the machine atc runs on. It brings no
account and no key of its own.

- It runs the unmodified `claude` binary as the signed-in user: `claude --bg`, `claude attach`,
  `claude agents`, and `claude -p` for summaries.
- It reads what Claude Code keeps on disk for that user: conversation transcripts, its list of
  background sessions, and which folders it trusts.
- It never answers Claude Code's trust prompt or records a yes itself. For a folder not yet trusted,
  atc runs plain `claude` there in its terminal so you answer that prompt yourself. Claude Code writes
  the yes to its own `~/.claude.json`; atc only reads that file, to stop the prompt and start your
  session.
- It reads your plan limits from Claude Code's status line. `atc setup` sets that up
  (`atc limits -tap`), or tells you the line to add if you have your own status line.
- It changes Claude Code's own files in two places: `atc setup`, when you say yes, sets the status
  line and adds atc's MCP server; and atc lists its live sessions in `jobs/pins.json`, which keeps
  Claude Code's background service from retiring them.
- It does not proxy Claude's traffic, modify the `claude` binary, or send your sessions anywhere but
  the devices you connect. It does not read Claude Code's stored credentials.

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
