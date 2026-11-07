# atc

A `CLAUDE.local.md` next to this file, when there is one, holds how a particular machine deploys it.

## The web UI is also the phone app

`android/` is a thin native shell around the same page (`web/`), so every web change ships to the
phone too. A web change is not done until it works there:

- **Phone width.** Check the layout under 900px (the `@media (max-width: 899px)` rules): the header
  wraps, `.wide` items hide, the list and the session are separate screens. Screenshot it at ~400px
  wide, light and dark, not just desktop.
- **Inside the app.** `APP` (`window.AtcApp`) is set there, and some paths branch on it: links go
  through `openOut` → `AtcApp.openExternal` (other hosts open in the phone's browser, atc's own files
  download into a viewer app), no browser notifications, calls through the bridge. New links or opens go
  through `openOut`, never `window.open` or `<a target>`.
- **Native pieces.** If the change needs something the WebView can't do, it belongs in `Bridge.kt`.
  If it changes what a session row carries, consider the home-screen widget feed (`APP.setSessions`,
  `Widget.kt`) and push (`internal/push`).
- Kotlin changes need a new APK: `make android`. Web-only changes reach the app when the server
  updates: an open page notices the new build (`web` in `/api/me`) and reloads when you come back to
  it, or offers Reload.

## Dependencies stay visible

`internal/caps/registry.go` is the one list of what each feature needs; Settings, `atc doctor` and first run all read it. A new
feature or setting gets a row there, with a real check, the fix and what it costs. A feature whose dependency is missing stays
discoverable: draw it and point at its row, don't hide it.

## The assistant's words

`modes/` holds the built-in, generic text. Nothing personal goes in this repo: a user's name, numbers, tools or
language belong in their own files in `~/.config/atc/modes/`, which replace the built-in ones (`lines.json` key by
key). `voice/lang/` holds a language's words for calls.

`atc prompts` prints what the assistant is told with those files applied, and `make check` fails when that differs
from a `prompts.golden` beside them: read the diff, then accept it with `atc prompts --update`. A `~/.config/atc/private-words`
(`git grep -Ef` patterns) makes it fail too when anything of yours reaches the tree.

## Characters

Characters and rooms are built, checked and published with [cel](https://github.com/zcag/cel), its own repo: follow its
docs, and look at a character in a real call after. atc only loads what cel publishes.

`web/rig.js`, `room.js`, `motion.js` and `ears.js` are copies of cel's `renderer/`. Change them in cel, run its tests, then
`make cel` here (`CEL=<checkout>`, default `../cel`) to copy them in; never edit the copies. `web/cel.rev` is the cel
commit they came from.

## Services

`make install` does atc only (`atc service install --only atc`, restarting is safe: `KillMode=process` keeps every session alive).
The hub (`internal/hub`: calls, channels, the assistant's conversation) is a separate binary and service that needs
`make install-hub`, and the call stack (`voice/`) `make install-voice`. Restart either only between calls (the call line's `/status`
shows `"call": "idle"`), or it drops the call. Test the call stack with `talk.py --sim` and a private ttsd and hub, never against a
live line.

## Terminal size and rendering problems

Every attached screen is logged to the journal, server and browser side, keyed by the session's
short id: `journalctl --user -u atc --since "1 hour ago" | grep "term 260ef954"` (an opencode
session's `ses_…` id is keyed by its last 8 characters).

- `term <sid> #N (device): …` is the server's view of viewer N: connected (size, hidden,
  reconnect), visible/hidden, resize, **takes the size** (and why: first viewer, became visible,
  joined visible, typed, someone hidden or left), the session size applied, how long Claude took to
  redraw, missed pongs, and how it went away.
- `term <sid> client (device): …` is what that browser saw, posted over plain HTTP so it arrives
  even when its socket is dead: show/hide, page visible/hidden, open/closed, every size it
  received, resizes it could not send. `viewer=#N` ties it to the server lines; `quiet=` is how long
  since the socket last heard anything.
- A session on a peer is served by that machine's atc: its server lines are in that machine's log,
  the browser lines in the one you opened.
