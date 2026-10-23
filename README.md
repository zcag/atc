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
- **Transcript** shows the conversation as readable text, which is easier on a phone.
- **New session** starts Claude in any folder, with an optional name and first message.
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
```

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

## Outputs

Each session has an **Outputs** tab with what it produced, so you can check its work from a phone:

- **Running:** servers the session started (a dev server, a preview), as links on the machine's
  name. A server that listens only on localhost is marked as such, since it opens only on that
  machine. Running servers also show on the session's strip.
- **Files** it wrote, plus images, pages, notes, PDFs and media it mentioned or looked at, with
  previews. Tap one to view it: images, pages (with their stylesheets and scripts, sandboxed),
  rendered Markdown, video and audio, and plain text for code.
- **Links** it gave in its replies, such as a page it published.
- **Code it touched**, newest first, readable in place.

Files open through links that are signed for that session and folder and expire after 12 hours,
and pages run sandboxed, away from atc's own login.

## Usage and limits

The bar at the bottom of the session list shows how much of your Claude plan's current 5-hour
session and weekly limit you have used. Click it (or press `u`) for every limit with its reset
time, and tokens per day across all your sessions and machines.

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

`atc mcp` gives Claude tools to see and drive your other sessions: list them with what each is
doing, read a conversation, type a message into one (resuming it first if it was stopped), wait
for its answer, start new ones (optionally in their own git worktree) and stop them. The voice
assistant session has these tools from the start, so you can say "what is the deploy session up
to?" or "tell the docs session to also cover the CLI" without opening either. To give them to any
session, add atc as an MCP server once:

    claude mcp add atc -- atc mcp

Sessions open in a terminal can be read but not typed into. A session never sends to itself.

## Voice

Open a session and press **Voice** to talk to it. atc listens through the browser, decides when
you have finished speaking (a pause of about a second and a half), transcribes what you said and
types it into the session. When the session finishes its turn, atc reads the reply back, shortened
to a sentence or two when it is long. Talking over it stops the reading. Saying "stop" sends Esc to
Claude, and "yes" answers a permission prompt.

Voice needs a speech-to-text service that speaks the OpenAI transcription API (a local Whisper
server works), and optionally a chat model to shorten replies and a text-to-speech service for a
voice other than the device's own:

```sh
ATC_STT_URL=http://localhost:8000/v1/audio/transcriptions
ATC_SPEECH_LLM_URL=http://localhost:8001/v1/chat/completions   # optional
ATC_SPEECH_LLM_MODEL=qwen
ATC_TTS_URL=http://localhost:8002/v1/audio/speech                # optional
ATC_TTS_MODEL=tts-1
ATC_TTS_VOICE=alloy
```

Without `ATC_TTS_URL`, replies are read by the device's built-in voice, which is instant. The
microphone needs HTTPS. On a phone, keep the screen on: browsers stop the microphone when the
screen locks.

## Notes

- Claude Code only starts in folders you have trusted. If atc reports a folder is not trusted,
  run `claude` there once and accept the prompt.
- Sessions you started yourself in a terminal show up as **in a terminal**. atc can't attach to
  those, but you can read their transcript, and resume them once they have ended.
- Resuming always keeps the session's original options. Passing flags to Claude Code while
  resuming would start a copy instead, so atc never does.

## Third-party code

IBM Plex fonts are under the SIL Open Font License (`web/vendor/fonts/OFL.txt`). xterm.js, Preact
and htm are MIT licensed.
