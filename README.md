# atc

Every Claude Code session on a machine, in one place. See which ones need you, open any of them
in your browser or terminal, start new ones in any folder, and pick up old conversations. Sessions
keep running when you close the tab, lose the connection, or restart atc.

atc runs on the machine where your sessions live. You reach it from a browser or from the same
`atc` binary on another computer.

## How it works

atc builds on Claude Code's own background sessions (`claude --bg`, `claude attach`,
`claude agents`). Claude Code keeps each session alive in its background service; atc lists them,
starts, stops and resumes them, and connects you to one by running `claude attach` in a terminal
it streams to your browser over a websocket. Nothing about a session lives in atc, so atc can stop
or restart without touching your work.

The list combines what Claude Code reports (running, waiting on you, finished, stopped) with what
each conversation's transcript says: its title, the last thing you asked, branch, model and how
full the context is. Past conversations come from the same transcripts and can be searched and
resumed.

## Requirements

- A Claude Code recent enough to have background sessions (`claude --bg --help` works), signed in
  on the machine that runs atc.
- Go 1.26 to build.

## Install

```sh
go install github.com/zcag/atc@latest
```

or clone and run `make build`.

### Run it as a service (macOS, launchd)

```sh
make install-mac
```

installs the binary and `deploy/atc.plist` as a launch agent, reading the same
`~/.config/atc/env`. The agent sets `AbandonProcessGroup` for the same reason the systemd unit
sets `KillMode=process`, explained below.

### Run it as a service (Linux, systemd)

```sh
make install
```

installs the binary to `~/.local/bin`, installs `deploy/atc.service` as a user service and starts
it. Settings go in `~/.config/atc/env`:

```sh
ATC_ADDR=127.0.0.1:7272                 # where to listen
ATC_CLAUDE_ARGS=--model opus            # extra flags for sessions atc starts
ATC_ROOTS=/home/you/code:/home/you      # folders whose subfolders are offered for new sessions
```

The unit uses `KillMode=process` on purpose. When atc starts Claude Code's background service,
that service lands in atc's process group, and a plain stop would take every session with it.

## Use it

### In a browser

`atc serve` prints a link with a login token. Open it once and the browser stays logged in.
`atc token` prints the token again.

atc listens on `127.0.0.1` unless you set `ATC_ADDR`. To reach it from other devices, put it
behind a reverse proxy with HTTPS, or set `ATC_ADDR=:7272` on a network you trust. Every request
needs the token either way.

- Sessions are grouped by what they need: **needs you** (waiting for a permission or an answer),
  **your turn** (finished, waiting for your next message), **working**, and **stopped**.
- Open one to get its terminal. Close the tab whenever you like; the session keeps going.
- **Transcript** is the conversation as something to read, and it opens at the end: your last
  prompt at the top, Claude's reply below it, and the turns you have already read folded into one
  line each above (the ones that arrived since you last looked stay open). It covers the whole
  session however long it is: atc keeps an index of every turn and loads a turn only when you open
  it. What Claude did between your prompt and its reply reads as a short story told in its own
  words, one line per part of the work, with what came out of it as badges: tests passed or
  failed, commits, pushes, deploys, pages it showed you. Open it for each step: commands with their
  output, edits as diffs, screenshots it looked at, pages it searched, agents it started (as their
  own thread), and the questions it asked you with the answer you picked; reading and searching
  steps fold into one "Looked at" line. While a session works, its latest steps stay open with a
  timer on the running one.
  - **Outline**, **Story** and **Everything** (`1` `2` `3`) choose how much to show; **Aa** sets
    the typeface, size and line length.
  - **Find** (`f`) searches the whole session (prompts, replies, commands, file names) and filters
    to the turns with failures, commits, changed files, deploys or questions.
  - **What this session produced** lists the files it changed (open one for all its edits as one
    diff), its commits, pushes, deploys, the pages it showed you and running servers.
  - The box at the bottom (`r`) writes to the session: Enter sends, Shift+Enter is a new line, and
    a draft is kept per session. Attach files with the clip, by pasting or by dropping them;
    dictate with the mic. A message shows in the transcript the moment you send it, and stays
    there with "Try again" if it could not be sent. Above the box, the summary's suggested replies
    send with one tap.
  - Select any text for **Quote**, **Explain**, **Push back** or **Do this** (each quotes it into
    the box with a start you can edit), **Copy** or **Find**.
- **New session** starts Claude in any folder, with an optional name and first message.
- **Assistant** (the chat button, or `a`) opens one session with the atc tools, for asking about
  your other sessions or driving them. It is the same session the phone's side key opens, and with
  a hub (see "One assistant on every channel") the same conversation as WhatsApp and phone calls.
- **Earlier** lists past conversations. Open one and press **Resume** to continue it.
- On a phone, a row of keys above the keyboard gives you Esc, Tab, Shift+Tab, Ctrl and arrows.
- Press `?` for keyboard shortcuts.
  Drag on the terminal to scroll.

When two screens show the same session, the one you last typed in decides the terminal size, and
the other scales to fit. **Fit to this one** takes it back.

### From a terminal

```sh
atc login https://atc.example.internal <token>   # once, on each computer
atc                                              # the session list, live
atc ls                                           # the same, printed
atc attach 2                                     # open a session (row number, id or part of the title)
atc new ~/code/app "fix the failing test"        # start one
atc history "auth bug"                           # search past conversations
atc resume "auth bug"                            # continue one
atc stop 2 · atc rm 2 · atc rename 2 "name" · atc pin 2
atc summary 2                                    # its final message in short
atc outputs 2                                    # what it produced, with links to open its files
atc state 2 inbox                                # a page's state as JSON; -set merges stdin into it
atc usage                                        # plan limits and tokens per day
atc usage 2                                      # one session's tokens, turns and estimated cost
atc limits -short                                # session 4% · week 73% · resets 28m
```

Commands that print something take `-json`. `atc limits -short` is one line, for a status line or
a shell prompt.

In the terminal UI, the line above the keys shows your plan limits, checked every two minutes. `o`
shows the highlighted session's outputs, `u` its tokens and estimated cost, and `U` the plan
limits with tokens per day.

`atc new` without a folder uses the current one, written relative to your home folder, so the
same path works on a server where your projects live under the same names.

Inside an attached session, Ctrl+Z detaches. So does Esc from Claude's agent view.

## Several machines in one list

One atc server can list sessions from others. Run atc on each machine, then on the one you open
in your browser, list the others in `~/.config/atc/peers.json` and restart it:

```json
[{ "name": "laptop", "url": "http://laptop:7272", "token": "<atc token on the laptop>" }]
```

Sessions from every machine appear together, tagged with their machine. Opening, stopping,
resuming or uploading to one is forwarded to the machine it lives on, and **New session** asks
which machine to start on (`atc new -host laptop` from a terminal). A machine that is off shows as
unreachable and the rest keep working.

## Android app and notifications

`android/` holds a small Android app that shows your atc server's page and adds what a browser
cannot: notifications, the device's own text-to-speech for voice, and being your phone's digital
assistant, so holding the side key opens atc listening, even on the lock screen.

- **Opening a page on the phone:** the assistant can put a page straight on the phone's screen with
  `atc show <file> --open` (on a call, say), instead of a notification. It opens through the phone's
  assistant role, so atc must be the digital assistant; anything else falls back to a notification.
  Other sessions can't use it.
- **atc links:** the app handles `https://atc.example` links (the host is set in the manifest). Android
  does not verify a private host, so turn it on once: Settings › Apps › atc › Set as default ›
  Supported web addresses.
- **Install:** the server offers the app at `/app/` (set `ATC_APP_DIR` to the folder holding
  `atc.apk` and `version.json`, which `make android` produces). The app checks that folder and
  updates itself.
- **Private certificates:** if your server uses a certificate from its own authority (Caddy's
  `tls internal`, a home CA), the app asks once whether to trust it and then trusts that
  authority, so renewals keep working. Put the authority's certificate in the app folder as
  `ca.crt` (for Caddy: `pki/authorities/local/root.crt` in its data folder); without it the app
  trusts the top certificate the server sends, which breaks when that one rotates.
- **Share to atc:** share a link, text, screenshot or file from any app and choose atc. It opens a
  screen to say what Claude should do with it, then starts a session in the project it most
  likely belongs to (named in the text, or picked by `ATC_SPEECH_LLM_URL`'s model from your
  folders' READMEs and recent sessions), optionally in its own git worktree, or sends it to a
  running session.
- **Notifications** use [UnifiedPush](https://unifiedpush.org): install a distributor such as the
  [ntfy](https://ntfy.sh) app, point it at your ntfy server, and the atc app registers with atc
  on its own. You get a notification when a session starts waiting for you and when one finishes
  a turn, with the start of its reply, unless you have that session open.
- **Widget and Quick Settings tile:** the home-screen widget lists sessions that need you, are
  your turn or are working, most urgent first, kept current by a silent push (and a refresh
  button); tap one to open it. Its mic button and the **Talk to Claude** tile open the assistant,
  and the tile shows how many sessions need you.
- **Assistant:** choose atc under Settings → Apps → Default apps → Digital assistant app. Holding
  the side key then opens a session named `assistant` in `ATC_ASSIST_DIR` (default: your home
  folder) with voice on, starting or resuming it as needed.

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
to the voice assistant ("start the reviewer"). `brief` is a file, relative to `dir` or absolute,
read fresh at each start and given to Claude as instructions rather than as your first message, so
the session's title comes from what you actually ask. `args` adds Claude Code flags; `worktree`
starts it in its own git worktree.

A preset can also start itself. With `every` (`90s`, `5m`, `1h`, or whole days and weeks: `1d`, `2w`) the atc that
loads it starts a run on that interval, its first message being `prompt`. Add `check`, a shell
command run in `dir`, and a run starts only when it exits 0 and prints something; the first message
is then `prompt` followed by what it printed:

```json
{ "name": "inbox", "dir": "~/mail", "every": "5m", "check": "ls new/", "prompt": "File these:" }
```

A check gets a minute. While the previous run it started is still working or needs you, a tick is
skipped, so runs never pile up. Each tick's decision is logged to the journal (`preset inbox: …`).
The first run comes one interval after atc starts.

To run at set times, add `from`, a local date and time the schedule counts from: runs land on
`from` plus whole multiples of `every`, so `"every": "2w", "from": "2026-03-06T09:00"` is every
second Friday at 07:00, and `"every": "1d", "from": "2026-10-28T07:00"` is every morning at 07:00.
Day and week steps keep the wall-clock time across daylight saving. A run missed while atc was down
is not made up; the journal says when the next one is.

Anything else can start one too, with the same `POST /api/sessions` the New session screen uses:

```sh
curl -H "Authorization: Bearer $TOKEN" -d '{"preset":"inbox","prompt":"New mail from Ana"}' https://atc.example/api/sessions
```

## Apps

An app is a preset with `"app": true`, and optionally a `title`, an `icon` (one of mail, sun, present,
lira, target, inbox, calendar, chart, pr, globe, pulse, doc, or an emoji) and a `color` (blue, amber,
violet, green, red, teal, pink, orange, slate, or a hex color) for its tile:

```json
{ "name": "mail", "icon": "✉", "app": true, "dir": "~/mail", "brief": "MAIL.md",
  "every": "15m", "check": "mail-cli new", "prompt": "Triage these:" }
```

There is no standing session. Each run is an ordinary session started from the preset: by its
`every` and `check`, by anything that `POST`s to `/api/sessions` with the preset or to
`/api/presets/<name>/run`, or by hand with **Run**, which starts one with `prompt` and skips the
check.

An app that needs no agent to refresh gives its preset a `command` instead: on `every` (after
`check`, if any), on **Run** and on `POST /api/presets/<name>/run`, atc runs that command in the
preset's folder and starts no session. The command keeps the page current itself, with
`atc show <file> --app <name>` and `atc state -set app:<name> <page>`. If the preset also has a
`brief`, **Chat** still starts a session for whatever needs judgment. `command` works on any
preset, app or not; its last run (exit code and output) shows as the app's state.

- **Pages.** A page a run shows with `atc show` belongs to the app, filed under `app:<name>`
  instead of the run, so the next run shows and updates the same page and reads the same state.
  Anywhere else it is `atc state app:<name> [page]`.
- **Badge.** A number or a short string under the top-level `badge` key of the page's state shows
  in the app's own header.
- **Quiet runs.** Runs stay out of the session list and the widget unless one needs you, and a
  finished run sends no push. A run that needs you, and `atc notify` from a run, push as usual.
- **In the UI.** The grid button in the header opens a menu of apps: those with something to say
  (a badge, a run working, needing you or failed) as cards with their page's `headline` and **Run**,
  the rest as a row of chips. An app opens its page full width, with **Run** and **Chat**, which opens the latest run
  beside the page. `atc.send` from the page goes to the latest run, resuming it if it stopped.
  With `"open": "chat"` the app opens straight into that view, for apps you mostly talk to.
- **From other sessions.** An agent starts a run with atc's `start` tool and the app's preset, and
  reaches the app's latest run as `app:<name>` wherever a session is named: `send`, `read`, `wait`,
  `atc attach app:<name>`.

`GET /api/apps` lists the apps of every machine with their pages, badge and latest run.

## Other models

Claude Code runs on any model served through Anthropic's Messages API (`/v1/messages`): Ollama
serves it natively, and LiteLLM or claude-code-router put it in front of an OpenAI-only server.
List them in `engines.json` in the config folder, on the machine whose sessions use them:

```json
[{ "name": "qwen", "model": "qwen3:30b-a3b-instruct-2507-q4_K_M", "url": "http://gpu:11439" }]
```

New session then shows a Model line (Claude stays the default), and those sessions carry the
engine's name on their strip. atc remembers each session's engine and resumes it there; a session
started elsewhere is resumed on the engine whose `model` matches the model in its transcript. Each engine sets `ANTHROPIC_BASE_URL`, an auth token (`token`, default
`local`) and every model alias to `model`, through `--settings`; `env` adds or overrides
variables. It also turns off Claude Code's attribution header
(`CLAUDE_CODE_ATTRIBUTION_HEADER=0`): it sits at the start of every prompt and differs per
session, so a local server's prompt cache never matched and each new session re-read ~30k
tokens. On gpu's MLX Qwen a new session's first turn went from 62-73 s to 2.7 s with it off. Replies from models not named `claude-*` cost nothing and are left out of the plan's
daily usage.

## opencode

atc also runs [opencode](https://opencode.ai) sessions next to Claude's, through one headless
`opencode serve` on the same machine. That server keeps every session alive the way Claude's
background service does, for every folder at once, so opencode sessions survive atc restarting
too. Run it as its own service, never under atc:

```sh
make install-opencode        # deploy/opencode.service, on 127.0.0.1:4096
```

then point atc at it in `~/.config/atc/env` and add an engine with `"harness": "opencode"`:

```sh
ATC_OPENCODE=http://127.0.0.1:4096
```

```json
{ "name": "opencode", "harness": "opencode", "model": "mlx/mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ" }
```

`model` is opencode's `provider/model` from its own config; leave it out to use opencode's
default. Without `ATC_OPENCODE` nothing about atc changes.

The service runs with its own config folder, `~/.config/atc/opencode`: `config.json` links to
your normal opencode config so providers stay in one place, `opencode.json` makes `atc` the default
agent, and `agent/atc.md` (from `deploy/opencode/`) is that agent: a short prompt and only the core
tools (question, bash, read, glob, grep, edit, write). It knows where your notes folder is and may
read it, but only looks something up when a question needs it, through the notes's index, so the
notes don't take up the prompt (a lookup measured 9-28 s). The unit also turns off opencode's
Claude Code compatibility (`~/.claude/CLAUDE.md` and `~/.claude/skills`) and external skills. A
local model needs this to be usable: what gets resent on every step has to fit the server's prompt
cache, or every step re-reads it all. Measured on gpu's MLX Qwen3-Coder-30B, one step in
`~/proj/atc`:

| Setup | Prompt | First step |
|---|---|---|
| opencode defaults (global AGENTS.md, Claude skills, `build` agent) | 25,856 tokens | 72 s |
| own config folder, Claude compatibility off | 6,022 | 11.7 s |
| plus the `atc` agent | 3,607 | 5.4 s |

With the `atc` agent, an 8-step fix-the-failing-test task took 22 s in total: after the first
step each one sent 15-97 new tokens and read the rest from the cache. Your own `opencode` in a
terminal keeps its normal config.

An opencode session is a full atc session: its strip, states and push, the terminal
(`opencode attach`, shared and sized like any other), transcript, summary, outputs, usage (tokens,
no cost), send, voice and the MCP tools. What maps differently:

- **State** comes from the server: busy is working; a pending question or permission is needs
  you, with the question as the activity line.
- **Questions and permissions** show above the session's terminal with their options as buttons
  (Allow once / Always allow / Reject for a permission), answered through the server.
  `opencode attach` does not show a question asked before it attached, which is the usual case
  when you open a session because atc said it needs you.
- **Which sessions are live:** the ones atc started or resumed, and any session that starts
  working on the server, until you stop or remove them. Stop interrupts the turn and keeps the
  session resumable; remove takes it off the list, and the conversation stays in history.
- **Presets** give the folder, name and brief. The brief goes in as hidden context with the first
  message, so it stays in the conversation. `args` are Claude flags and are not used, and git
  worktrees are Claude-only.
- **After a reboot**, a session that was working gets the same "continue" message as Claude's.
- Sessions from a plain `opencode` in a terminal run their own server: they show in history, not
  as live.

## Pages

An agent shows you something to look at (a report, a handover, a diagram, a screenshot) with
`atc show <file>`, and it opens next to the conversation that made it:

- **Live.** atc serves the file where it is and redraws it every time it changes, keeping your
  scroll position, so the agent updates a page by editing the file. A session can show any number
  of pages; each has a name (the file's, or `--as name`), and showing a name again replaces that
  page.
- **In the session.** A button on the session's header lists its pages, newest change first, with
  a dot on the ones that changed since you looked. A page opens beside the conversation on a wide
  screen, or full width (toggle in the page's bar; atc remembers which), and in a **Pages** tab on
  a phone. Each `atc show` is also a card in the transcript, and the session's row in the list
  carries the page. A new page opens by itself beside the conversation unless you are typing;
  otherwise you get a note. You get a push when a session shows you a page, unless you are
  watching it.
- **Full size.** ↗ opens the page on its own at `/#/p/<session>/<name>`, a link that works on any
  of your devices for as long as the page is up. **Pages** (`p`, or the page button above the
  list) shows every page from every session and machine, with previews, a filter and take-down.
- **Talking back.** A page that loads `/atc.js` gets `window.atc`: `atc.state.get()` and
  `atc.state.set(obj)` keep the page's data on the server, across devices; `atc.send(text)` sends
  a note to the session after you confirm it; `atc.copy(text)` copies, in the browser and the app.
  Links to other sites open outside atc. Outside atc the same calls fall back to localStorage and
  the clipboard.
- **Looking like atc.** A page that links `/atc.css` gets atc's fonts, colors (light and dark)
  and a small kit that is dense by default, so a page reads like a dashboard: page header,
  section headers with counts, cards with a colored edge, list rows, columns, a one-line stat
  strip, thin progress meters with a pace tick, compact tables, collapsible blocks, buttons,
  pills, link chips, calm callouts, empty and all-clear states, loading skeletons and a sticky
  action bar for phones. `atc.toast(text, label, fn)` shows a toast with
  an optional button such as Undo. `atc show -h` lists the class names.
- **Actions.** `atc show mail.html --action mark-read='mail-cli markread'` lets the page run that
  command: `atc.run("mark-read", [id])` runs `mail-cli markread <id>` on the page's machine, in
  its folder, for up to 30 seconds, and gives back `{code, stdout, stderr}`. Only whoever shows
  the page declares actions; showing it again replaces them. The command is split on spaces, and
  the page's args are passed as separate arguments without a shell, so `;` or `$(...)` in them is
  just text. Pages show text nobody vetted (mail, web pages), so declare only commands that are
  safe to run with any args. Each run is logged with the session, page, action and exit code.
- **State.** A page's state is one JSON value that the agent, the page and other tools share, so
  an agent can write its results there and let the page only draw them. A write that is an object
  replaces only the top-level keys it has, and a key set to `null` is deleted: the agent can own
  `mail` while the page keeps what you ticked under `handled`, and neither overwrites the other.
  Any other write (an array, a string, `null`) replaces the whole state, as does an object written
  over a state that is not one. It is at most 256 KB. The agent reads it with
  `atc show --state <name>` and writes it with `atc show --state <name> --set` and JSON on
  stdin; anywhere else `atc state <session> [page]` prints it and `atc state -set <session> [page]` merges stdin into it;
  over HTTP it is `GET` and `PUT /api/sessions/<session>/pages/<name>/state`.

A folder shows its `index.html`, with the files beside it loading by relative path. HTML, images,
Markdown, PDF, CSV/TSV, video and audio render. Pages run sandboxed, away from atc's own login.
`atc show -h` is the reference agents read; atc's MCP instructions point every agent at it.

## Backlog

Work you want an agent to do, but not now. **Backlog** (`b`, or the header's menu) is its own
screen, filtered by project like the list:

- **Add** an item there, or press **Later** in the new session dialog: the same folder, name and
  first message, put aside instead of started. An item has a **title** (what the backlog shows,
  and the session's name once started) and a **prompt** (the session's first message, hidden
  behind *prompt* on the row; without one the session gets the title).
- Items are **ready** or **blocked** (with what they wait on). **Start** turns one into a session
  with that first message (in its own worktree if you set that), and the item follows the
  session's state until you mark it **done**. The session is told it came from the backlog, and
  marks its own item done or blocked with the `mark` MCP tool.
- **Put on the backlog** (a session's menu, or the palette) sets a session aside: it stops unless it
  is working, and its item gets **Resume**, which brings that same conversation back.
- Agents add items only when you ask them to (the `later` MCP tool). Theirs wait, dashed, under
  **Suggested by agents** with the session that added them, until you **take** or **dismiss** them.

Items live with the machine the folder is on (`backlog.json` in its config folder); the screen
shows every machine's. Over HTTP: `GET`/`POST /api/backlog`, `PATCH`/`DELETE /api/backlog/<id>`,
`POST /api/backlog/<id>/start`, `POST /api/sessions/<session>/aside`, with `?host=` for another machine.

## Notify

An agent tells you something with `atc notify <message>` from inside its session: a push that
opens that session when you tap it. It follows the same rules as a finished turn (no push while
you are in atc, or the session is open or parked); `--urgent` buzzes regardless, and `--reply TEXT`
(up to three) adds buttons that send the text back to the session. A session on another machine
works the same way: its note travels with the session list to the machine your phone is
registered with.

## A browser for sessions

One Chrome can be shared by every session on a machine, each seeing only its own tabs. Point
`ATC_BROWSER` at Chrome's debugging address (`ATC_BROWSER=http://127.0.0.1:9222`) and give
sessions Playwright's MCP server through atc:

```sh
claude mcp add -s user browser -- atc browser mcp
```

`atc browser mcp` runs `@playwright/mcp` against atc instead of Chrome. atc relays it as that
session: tabs the session opens (and popups they open) are its own, every other tab is hidden
from it, and the profile, so the logins, stay shared. Which session owns which tab is kept in
`browser.json`.

A session with tabs gets a **Browser** entry next to its pages. It shows the tab live, and you
can click, scroll, type and go to an address in it, which is how you step in for a login or a
captcha; on a phone the tab takes the phone's size while you watch, and goes back when you leave.
Chrome can run headless for this, since atc is the screen.

## Outputs

Each session has an **Outputs** tab with what it produced, so you can check its work from a phone:

- **Pages** it showed you, with previews.
- **Running:** servers the session started (a dev server, a preview), as links on the machine's
  name. A server that listens only on localhost is marked as such, since it opens only on that
  machine. Running servers also show on the session's strip.
- **Files** it wrote, plus images, pages, notes, PDFs and media it mentioned or looked at, with
  previews. Tap one to view it: images, pages (with their stylesheets and scripts, sandboxed),
  rendered Markdown, video and audio, and plain text for code.
- **Links** it gave in its replies.
- **Code it touched**, newest first, readable in place.

Files open through links that are signed for that session and folder and expire after 12 hours,
and pages run sandboxed, away from atc's own login.

## Summaries

When a session finishes a turn, atc summarizes its final message at three lengths:

- **Status**, one line: what the message is about. It replaces the start of the reply on the
  session's strip, in `atc ls` and in the notification.
- **Gist**, one short line per topic the message covers.
- **Overview**, for long messages: the content grouped as Answer, Found, Plan, Proposes, Open.
- **Replies**, up to three messages you would likely send next, in your own phrasing: "ok go" for a
  go-ahead, the option it recommends, "did the login" when it asked you to do something,
  "status/eta?" while something still runs, "ok we can wrap" when the work is done. None when the
  next message can't be guessed. They show as buttons under the summary line and above the
  transcript's box, only when it is your turn and Claude isn't asking its own question; a tap sends
  it, and the server log notes each one used (`suggested reply`).

A session shows its summary in a line under its header. On a computer, **More** opens the gist
and overview in place; on a phone it opens them in a sheet, with a button to the full message. The
summary is of that one message: once the session moves on, it goes away until the next turn ends.
A notification for a finished turn waits up to 25 seconds for the summary, then goes out with the
start of the reply instead.

Summaries come from `claude -p` with haiku and a fixed prompt, with no tools, no CLAUDE.md and no
saved session, so each costs about 2,500 tokens of your plan. Replies of a line or two keep their
own text as the status; the model only suggests what to send back. Each machine summarizes its own sessions and keeps the result in
`summaries.json` in its config folder. Set `ATC_SUMMARY_MODEL` for another Claude model,
`ATC_SUMMARY_URL` (with `ATC_SUMMARY_MODEL`) for an OpenAI-compatible endpoint such as a local
model, or `ATC_SUMMARY=off` to turn it off. The prompt is `internal/summary/prompt.md`.

The same summary is in the API and the tools: each session in `/api/sessions` carries `summary`
(`status`, `gist`, `overview`, the `reply` it describes) and `summarizing` while one is being made.
`GET /api/sessions/{id}/summary?wait=30` returns it, making one if needed (also for a past
session), and `POST` makes it again. `atc summary <session>` prints it, and the MCP tools include it
in `sessions` and `wait`.

## Usage and limits

The bar at the bottom of the session list shows how much of your Claude plan's current 5-hour
session and weekly limit you have used. Click it (or press `u`) for the usage page, across all
your sessions and machines: every limit with how far through its window you are, its pace and
reset time; spend by day and model over 7 to 90 days; which hours of the week you use it; where
the cost goes (output, cache reads and writes); and the projects and sessions that spent it.

The limits come from the same endpoint Claude Code's `/usage` reads, signed in with Claude Code's
own login on the machine running atc (the macOS keychain, or `~/.claude/.credentials.json`). atc
only reads that login and never refreshes or changes it; when it has expired, atc shows Claude
Code's last saved reading, marked as not current, until a session renews it. It checks at most
every few minutes.

Each session's header shows its tokens and an estimated cost; **Usage** in its menu breaks that
down: input, output and cache tokens, models, turns, tool calls, subagents (which Claude Code keeps
in their own transcripts), wall time and how long Claude was working. The cost is what the same
tokens would cost at Claude API list prices, an estimate for comparison, since a subscription is
not billed per token.

## One session that runs the others

`atc mcp` gives Claude tools to see and drive your other sessions:

- `sessions`: every open session with what it is doing, what it is asking you (the question and
  its options, or the permission it wants), and its last reply in short (status and gist).
- `read`: a session's last reply in short, one line per turn (what was asked, files changed,
  tests, commits, pushes, deploys, failures, how long), then its last messages in full.
- `start` a session in a folder on any machine (optionally in its own worktree), `send` a
  message to one (resuming it first if it was stopped), `wait` for its answer, `outputs` for the
  servers, pages and files it produced, `stop`, `history`, `presets`.
- `later` puts a task on your backlog when you ask for that (it shows as a suggestion from that
  session), `backlog` lists what is on it, `mark` marks an item done, blocked or ready (by default
  the one the session was started from).

The voice assistant session has these tools from the start, so you can say "what is the deploy
session up to?" or "tell the docs session to also cover the CLI" without opening either. To give
them to every session on a machine, add atc as an MCP server once:

    claude mcp add -s user atc -- atc mcp

The tools' instructions tell Claude to use them whenever you ask to start a session or hand work
to another agent, even without naming atc.

**Sessions talking to each other.** A message one session sends another, or the first message of
a session it starts, ends with a line naming the sender:

    [started by session "docs rewrite" (a8f3c2d1 on desktop) · report back when done with atc's send tool to a8f3c2d1]
    [started by session "docs rewrite" (a8f3c2d1 on desktop) · handed off to you: no need to report back]

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
code (`internal/client/relay.go`), so they behave the same. A request from another session is not your approval: your rules for
outward actions still apply, and the instructions say so.

Sessions open in a terminal can be read but not typed into. A session never sends to itself.

## Voice

Open a session and press **Voice** to talk to it. It opens on the transcript, with the voice controls
in place of the reply box (it also works over the terminal). atc listens through the browser, decides when
you have finished speaking (a pause of about a second and a half), transcribes what you said and
types it into the session. When the session finishes its turn, atc reads its final message back in
full, leaving out what Claude wrote between tool calls; code and tables are mentioned rather than
read out. Talking over it stops the reading. **Earlier** reads the final message of the turn before,
**Short** a sentence or two of it. Saying "stop" sends Esc to Claude, and "yes" answers a
permission prompt.

Voice needs a speech-to-text service that speaks the OpenAI transcription API (a local Whisper
server works), and optionally a chat model to shorten replies and a text-to-speech service for a
voice other than the device's own:

```sh
ATC_STT_URL=http://localhost:8000/v1/audio/transcriptions
ATC_STT_LANGUAGE=en                                             # optional, else Whisper guesses per clip
ATC_STT_LANGUAGES=en,tr                                         # optional: guess, but only among these
ATC_SPEECH_LLM_URL=http://localhost:8001/v1/chat/completions   # optional
ATC_SPEECH_LLM_MODEL=qwen
ATC_TTS_URL=http://localhost:8002/v1/audio/speech                # optional
ATC_TTS_MODEL=tts-1
ATC_TTS_VOICE=alloy
ATC_TTS_TR_URL=http://localhost:8003/v1/audio/speech            # optional: a voice for Turkish
ATC_TTS_TR_MODEL=speaches-ai/piper-tr_TR-fahrettin-medium
ATC_TTS_TR_VOICE=fahrettin
```

`ATC_TTS_<LANG>_URL` (with `_MODEL` and `_VOICE`) gives one language its own text-to-speech engine,
for a language the default voice can't speak: [Speaches](https://github.com/speaches-ai/speaches)
serving a Piper voice works. Speech goes to it when its language is known (a WhatsApp voice note
was spoken in it), or when the text has letters only that language uses (ı, ş, ğ for Turkish).

`ATC_STT_LANGUAGES` lets Whisper detect
the language but keeps only those it lists: a clip heard as anything else (short English, and
Turkish too, come back as Icelandic or Portuguese) is transcribed in each of them, and the first
whose transcript uses letters plain English lacks (ç, ğ, ı) wins, else the first listed. Pinned to
Turkish, English speech still comes out as English, which is what tells the two apart. It takes the place of
`ATC_STT_LANGUAGE` when both are set, and WhatsApp voice notes go the same way.

Without `ATC_TTS_URL`, replies are read by the device's built-in voice, which is instant. The
microphone needs HTTPS. On a phone, keep the screen on: browsers stop the microphone when the
screen locks.

## WhatsApp

atc can put one standing session, named `whatsapp`, behind a WhatsApp account of its own, so you
talk to it from your own number and its replies arrive as ordinary messages with ordinary
notifications. It needs an [OpenWA](https://github.com/rmyndharis/OpenWA) gateway with that second
account linked as a session. Only your number reaches the session: OpenWA's webhook filter lets
nothing else through, and atc checks the signature and the sender again (an `@lid` sender is
resolved to its number through WhatsApp) and ignores anyone else without a word.

```sh
ATC_WHATSAPP_URL=http://openwa:2785              # the gateway
ATC_WHATSAPP_KEY=...                             # its API key
ATC_WHATSAPP_SESSION=<uuid>                      # the linked account, as an OpenWA session id
ATC_WHATSAPP_OWNER=905551234567,1234567890@lid   # your number first, then other ids you write from
ATC_WHATSAPP_SECRET=<16+ random characters>      # signs every delivery
ATC_WHATSAPP_HOOK=http://<this host>:7272/api/whatsapp/hook   # atc registers it on start
ATC_PUBLIC_URL=https://atc.example                # optional: where links in messages point
```

atc registers two webhooks at that URL: messages, filtered by sender, and reactions, edits and poll
votes, filtered by chat (a sender filter would drop reactions, which carry no sender).

The conversation is one session, kept and resumed like `assistant` (in `ATC_ASSIST_DIR`), parked so
atc's own pushes don't repeat what WhatsApp already told you. Dropped from Claude's background list,
it is resumed from its transcript. What you send is typed into it: text, a reply to an earlier
message with that message quoted, photos and files saved to disk with their path, voice notes
transcribed (`ATC_STT_URL`), locations as coordinates, an edit with what it said before, a tap on
one of its polls (votes settle for a few seconds, so changing your mind sends one answer), and a
reaction to one of its questions (👍 is yes). A reaction to anything else starts nothing. Messages
sent while it works join the turn it is on. Your message gets ⏳ while it works and ✅ once
everything you sent has been answered.

Its replies go out as they are written, Markdown turned into WhatsApp's markup. A table is drawn as
an image by atc's browser (`ATC_BROWSER`; without one it becomes monospace text), long code goes as
a file, and anything over a message's length is split at paragraphs. A long final answer goes out
with its summary first (📌 the status and the gist), so the notification tells you the outcome, and
as a `reply.md` document past a couple of screens. While a turn runs quiet, one status message
shows what it is doing, edited in place, and the typing indicator stays on. A voice note gets a
spoken answer back as a voice note, in the language you spoke whatever the written reply is in:
Claude (haiku, through `claude -p`) turns the reply into a few sentences said out loud in that
language (without Claude, the speech model shortens it in the reply's own). It needs
`ATC_TTS_URL`, a voice for that language such as `ATC_TTS_TR_URL`, and OpenWA's
`MEDIA_CONVERSION_ENABLED`.

The session works as a switchboard: it answers and looks things up itself, and hands anything bigger
to a session of its own, relays that session's report, follows up and stops it when it is done.
Turns nobody started from WhatsApp (such a report, or you typing into the conversation in atc) are
relayed too. A page it shows with `atc show` arrives as a screenshot (HTML), the file itself
(image, PDF), or messages (Markdown), with a link to the live page. It sends what a reply can't
carry with `atc wa`: `--file`, `--render page.html` (drawn as an image), `--voice TEXT`, and
`--poll QUESTION --option A --option B` (`--multi` for several). `/status` lists your sessions,
`/stop` interrupts it, `/new` starts a fresh conversation (the last one stays in atc under a dated
name) and `/help` lists all this.

## One assistant on every channel

`atc hub` keeps the assistant as one conversation that atc, WhatsApp and phone calls all talk into.
It runs Claude as a stream-json process (`claude -p`), so a reply streams to whoever asked as it is
written, and it runs as its own service, so restarting atc never cuts a call:

```sh
make install-hub                         # installs atc-hub.service; make install leaves it alone
ATC_HUB=http://127.0.0.1:8820            # in ~/.config/atc/env: atc talks to it there
ATC_HUB_CLAUDE_ARGS=...                  # optional extra flags for its Claude
ATC_DELTA_CALL=http://127.0.0.1:8807     # the phone line (delta-call), for atc call
ATC_CALL_NUMBER=+905551234567            # optional, defaults to the first ATC_WHATSAPP_OWNER
atc hub status · atc hub reset           # what it is doing; start over now
```

With `ATC_HUB` set, the Assistant button, the side key and WhatsApp all reach the hub's session. It
shows in the list as **assistant**, with no terminal: its transcript is the chat, the box under it
writes to it, the reply appears as it is written, and Esc or Stop interrupts it. A phone call is a
third channel: delta's `talk.py` connects as `phone` (`ws://127.0.0.1:8820/ws?channel=phone`).

**Channels.** Each message is tagged with where it came from: `atc`, `atc-voice` (the Voice button),
`whatsapp`, `phone`, and `agent` (another session's `send`). When the channel changes, the message
carries that channel's rules from `modes/<channel>.md` (built in; a file of the same name in
`~/.config/atc/modes/` takes its place), so the session writes Markdown for atc, short spoken
sentences on a call, and phone-screen messages on WhatsApp. A report from another session is
answered on the channel they last wrote from.

**Several at once.** A message that arrives while the session works joins the turn it is on, and
each part of the reply goes to the channel of the newest message the session had read when it wrote
it. Text from atc or WhatsApp while the phone is part of the turn waits until that turn ends, so a
call never reads out an answer meant for a screen. A barge-in on the call interrupts only what is
being said to the call.

**Starting over.** When the conversation has been quiet for 6 hours and is past 80k tokens, or quiet
for 10 minutes and past 150k, never during a call, the hub has the session write a handover note in
one last turn and opens a new session with it as the first message. `/new` on WhatsApp, a fresh
assistant in atc and `atc hub reset` do it at once. The old conversation stays in atc as
**assistant MM-DD hh:mm**; the notes are in `~/.local/state/atc/hub/handovers/`.

**When the hub is down**, WhatsApp and the Assistant button fall back to a plain background session
resumed from the hub's conversation. When the hub is back, atc stops it; what was said there stays in
its own transcript, and if Claude gave it a new session id, the hub does not see it.

Endpoints, for clients other than atc: `GET /ws?channel=NAME` (send `{"type":"message","text"}`,
`{"type":"note","text"}` or `{"type":"interrupt"}`; get `text`, `tool`, `block`, `read`, `joined`,
`held`, `done`, `error`, `notice`), `GET /events` (every channel's events), `GET /status`,
`POST /message {channel, text}`, `POST /interrupt {channel}`, `POST /reset`,
`POST /call {reason, from, notify, timeout}`.

## Calling the user

```sh
atc call [--reason TEXT] [--wait] [--timeout 45s]
```

has delta (the agents' phone line, through delta-call) ring the user's own number; it never dials
another. When they pick up, the assistant is on the line: its first message carries the reason and,
from another session, that session's sender line, so it says why it called and passes their answer
back with `send`. Without `--wait` the command returns at once, and a call nobody picks up comes
back to the session that asked as a `[telefon ... açmadı]` message (the assistant's own calls come
back on the channel it was busy with). `--wait` prints the outcome instead: `answered`, `no-answer`
or `busy` (a call is already on).

## Notes

- Claude Code only starts in folders you have trusted. If atc reports a folder is not trusted,
  run `claude` there once and accept the prompt.
- Sessions you started yourself in a terminal show up as **in a terminal**. atc can't attach to
  those, but you can read their transcript, and resume them once they have ended.
- Resuming always keeps the session's original options. Passing flags to Claude Code while
  resuming would start a copy instead, so atc never does.

## Third-party code

IBM Plex, Newsreader and Literata fonts are under the SIL Open Font License
(`web/vendor/fonts/OFL.txt`). xterm.js, Preact, htm and marked are MIT licensed, highlight.js and
jsdiff BSD licensed.
