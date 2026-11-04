# atc

A self-hosted console for Claude Code. It lists every Claude Code session on your machines, shows
which ones need you, opens any of them in a browser, a terminal or the Android app, starts new ones
in any folder, and resumes old conversations. Sessions keep running when you close the tab, lose the
connection or restart atc.

One install serves one user. atc runs on the machine where your sessions live, as your user.

atc is an independent project. It is not affiliated with or endorsed by Anthropic.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/board-dark.png">
  <img src="docs/img/board-light.png" alt="The session board: sessions from three projects grouped by waiting on you, working and parked, with a status line, context used and age for each">
</picture>

## What it does with Claude Code

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

## What works without setup

With Claude Code signed in, these work right after install:

- The session list, grouped by what each session needs, with a live terminal for any of them.
- The transcript view, search through past conversations, and resume.
- Starting sessions, stopping them, parking them and putting them on a backlog.
- Pages agents show you, what each session produced, tokens and estimated cost, and memory and CPU
  per session.
- Standing agents, and tools that let sessions see and drive each other (`atc mcp`).
- Short summaries of finished turns, using a little of your plan (they can be pointed at your own
  model or turned off).

## Screenshots

These come from a demo with made-up sessions (`test/demo/run.sh`).

A transcript, with the diff of one edit open under the steps of a turn:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/transcript-dark.png">
  <img src="docs/img/transcript-light.png" alt="A session's transcript: a word-level diff, tests passed, a build, a page and a commit, followed by the agent's reply">
</picture>

A page the agent made, beside the conversation:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/page-dark.png">
  <img src="docs/img/page-light.png" alt="A report page with figures and a table, open next to the conversation that produced it">
</picture>

Settings lists what is set up, and says how to set up what is not:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/settings-dark.png">
  <img src="docs/img/settings-light.png" alt="The Core feature list in Settings: three rows working, and the HTTPS address row not set up, open to show its fix and a field for the address">
</picture>

The board at phone width, which is also the Android app:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/phone-dark.png">
  <img src="docs/img/phone-light.png" width="300" alt="The session board at phone width, with sessions waiting on you listed first">
</picture>

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

More in [Install](docs/install.md).

## First run

1. `atc setup` asks who you are, sets the status line for plan limits, adds atc's tools for your
   sessions and says how to reach atc from other devices. It prints a link to open.
2. `atc doctor` lists what each feature needs, how it stands and the fix.
3. **Settings** in the page (`,`) shows the same list, with a field for each setting.
   See [Settings and doctor](docs/settings.md).

## Four layers

Each layer needs the one before it. Only the first is needed to use atc.

1. **Console.** Sessions, transcripts, pages, agents, backlog, usage.
   See [Using atc](docs/using.md). Needs Claude Code.
2. **Assistant.** One text conversation with tools to see and drive your other sessions, reachable
   from every screen. See [The assistant](docs/assistant.md). On by default, through a small second
   service.
3. **Calls.** Talk to the assistant by voice, from the browser or the app. An add-on: `atc voice install`
   adds its services, about 2 GB on disk, and runs on 2 CPU cores. See [Calls](docs/calls.md).
4. **Outside lines.** WhatsApp, a SIM line and guests. Advanced, needs accounts and numbers of its
   own, and comes with no promises. See [WhatsApp](docs/whatsapp.md).

## Docs

- [Install](docs/install.md): requirements, services, reaching atc from other devices
- [Settings and doctor](docs/settings.md): the feature list and every setting
- [Security](docs/security.md): what a login gives, and how to expose atc safely
- [Using atc](docs/using.md): the browser and the terminal
- [Several machines](docs/machines.md)
- [Android app](docs/android.md): notifications, pairing, the widget, the digital assistant role
- [Presets and agents](docs/presets-and-agents.md)
- [Other models and opencode](docs/models.md)
- [Pages](docs/pages.md): what agents show you
- [Backlog and notify](docs/backlog-and-notify.md)
- [A browser for sessions](docs/browser.md)
- [Outputs](docs/outputs.md)
- [Summaries](docs/summaries.md)
- [Usage and limits](docs/usage.md)
- [Resources](docs/resources.md)
- [Sessions driving sessions](docs/sessions.md)
- [The assistant and its channels](docs/assistant.md)
- [Calls](docs/calls.md)
- [WhatsApp and speech services](docs/whatsapp.md)
- [Look and themes](docs/look.md)

## License

MIT, see [LICENSE](LICENSE). What atc bundles and depends on is listed in
[THIRD_PARTY.md](THIRD_PARTY.md).
