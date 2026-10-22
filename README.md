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
