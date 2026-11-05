# Install

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

- Linux or macOS. On Windows, run atc inside WSL.
- Claude Code 2.1.139 or newer, the first with background sessions and `claude agents`, signed in
  on the machine that runs atc:

  ```sh
  curl -fsSL https://claude.ai/install.sh | bash
  claude auth login
  ```

- Go 1.26 or newer, only to build from source.

## Install atc

```sh
curl -fsSL https://github.com/zcag/atc/releases/latest/download/install.sh | sh
```

or from source:

```sh
go install github.com/zcag/atc@latest
atc service install
```

or clone the repository and run `make build`, then `./atc service install`.

## Run it as a service

```sh
atc service install                 # atc and the assistant's hub
atc service install --only atc      # only atc
atc service status
atc service uninstall               # stops and removes them; settings and sessions stay
```

This copies the binary to `~/.local/bin` and runs it as a service of your user: systemd on Linux,
launchd on macOS. Run it again to upgrade: sessions keep running, and a restart waits for a call to
end. Without a systemd for your user it still puts the binary in place, and you start it yourself
with `atc serve`.

Settings go in `~/.config/atc/env`, or in Settings on the page, which writes `settings.json` (see
[Settings and doctor](settings.md)):

```sh
ATC_ADDR=127.0.0.1:7272                 # where to listen
ATC_CLAUDE_ARGS=--model opus            # extra flags for sessions atc starts
ATC_ROOTS=/home/you/code:/home/you      # folders whose subfolders are offered for new sessions
```

The systemd unit uses `KillMode=process` on purpose, and the launchd agent `AbandonProcessGroup` for
the same reason. When atc starts Claude Code's background service, that service lands in atc's
process group, and a plain stop would take every session with it.

## Open it

`atc setup` and `atc serve` print a link with a login token. Open it once and the browser stays
logged in. `atc token` prints the token again.

## Reach it from other devices

atc listens on `127.0.0.1` unless you set `ATC_ADDR`. To reach it from other devices, put it behind
something that gives it HTTPS, or set `ATC_ADDR=:7272` on a network you trust. Every request needs a
login either way; read [Security](security.md) first, since a login is a shell on this machine.

- **Tailscale:** `tailscale serve --bg 7272` serves atc over HTTPS to your own devices. `atc setup`
  offers this when Tailscale is installed.
- **A reverse proxy with a certificate:** Caddy or similar, then set `ATC_PUBLIC_URL` to the address
  it answers at.

A browser only gives a page the microphone over HTTPS, so calls from a browser need one of these.

To log in a new device without typing the token, use `atc pair` (see
[Android app](android.md#pairing) and [Using atc](using.md#from-a-terminal)).

## Notes

- Claude Code only starts in folders you have trusted. New session says when a folder isn't yet;
  Start then opens Claude Code's own trust prompt in a terminal in the page, on a phone too, and
  starts the session with your message once you accept. `atc new` in a terminal does the same. The
  answer is yours, it is a real security decision: Claude Code's prompt starts on No, atc never
  answers it, and agents can't start there until you have (their `start` tool tells them so). A yes
  covers the folder and everything under it, and is kept by Claude Code in `~/.claude.json`.
- Claude Code doesn't remember a yes for your home folder itself, so a background session can't
  start there unless it already has one on record. Pick a folder under it instead.
- Agents need the same yes: see [Trusting its folder](presets-and-agents.md#trusting-its-folder).
- Sessions you started yourself in a terminal show up as **in a terminal**. atc can't attach to
  those, but you can read their transcript, and resume them once they have ended.
- Resuming always keeps the session's original options. Passing flags to Claude Code while
  resuming would start a copy instead, so atc never does.
