# atc

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
- Kotlin changes need a new APK: `make android && make android-publish` on laptop or desktop (the app
  updates itself from `https://atc.example/app/`). On desktop, `redroid up` starts a headless Android 12
  device for testing (`adb -s 127.0.0.1:5555`, arm64 libs through translation, the real GPU);
  `redroid install|start|shot|log`. desktop has no KVM, so no emulator. Web-only changes reach the app on `make install`: an open page notices the new build (`web` in `/api/me`) and reloads when you come back to it, or offers Reload.

## The assistant's words

`modes/` holds the built-in, generic text. Nothing personal goes in this repo: a user's name, numbers, tools or
language belong in their own files in `~/.config/atc/modes/`, which replace the built-in ones (`lines.json` key by
key). On desktop and laptop that folder links to the notes (`agents/assistant/modes/`), so **to change how the
assistant actually talks to the user, edit the file there**, not `modes/`.

`atc prompts` prints what the assistant is told with those files applied, and `make check` fails when that differs
from `prompts.golden` beside them: read the diff, then accept it with `atc prompts --update`. A new built-in file with
no override of their shows up in that diff, so write their version too if the generic one isn't what they want.

## Shipping

Own it end to end: merge to master, push, `make install` on desktop (restarting is safe:
`KillMode=process` keeps every session alive) **and** on laptop
(`ssh laptop 'cd ~/proj/atc && git pull --ff-only && make install-mac'`). desktop forwards laptop's
sessions to laptop's atc, so the two must never run different versions. `make install` ends by
fast-forwarding desktop's main checkout (`~/proj/atc`) to `origin/master` (`make sync-main`): a push
from a worktree doesn't move it, and a session started there would otherwise build stale code.
It leaves the checkout alone when it's off master or has local changes. Settings live in
`~/.config/atc/env` on each. Don't stop at a branch.

The hub (`internal/hub`: calls, channels, the assistant's conversation) is a separate binary,
`atc-hub.service`, which `make install` does not touch: a hub change also needs `make install-hub`
on desktop. Restart it only while delta is idle (`curl -s desktop:8807/status` shows `"call": "idle"`),
or it drops the call they are on.

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
- A session on laptop is served by laptop's atc: its server lines are in laptop's log
  (`ssh laptop grep "term <sid>" /tmp/atc.log`), the browser lines in desktop's.
