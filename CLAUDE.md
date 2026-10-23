# atc

## The web UI is also the phone app

`android/` is a thin native shell around the same page (`web/`), so every web change ships to the
phone too. A web change is not done until it works there:

- **Phone width.** Check the layout under 900px (the `@media (max-width: 899px)` rules): the header
  wraps, `.wide` items hide, the list and the session are separate screens. Screenshot it at ~400px
  wide, light and dark, not just desktop.
- **Inside the app.** `APP` (`window.AtcApp`) is set there, and some paths branch on it: links go
  through `openOut` → `AtcApp.openExternal` (other hosts open in the phone's browser, atc's own files
  download into a viewer app), no browser notifications, TTS through the bridge. New links or opens go
  through `openOut`, never `window.open` or `<a target>`.
- **Native pieces.** If the change needs something the WebView can't do, it belongs in `Bridge.kt`.
  If it changes what a session row carries, consider the home-screen widget feed (`APP.setSessions`,
  `Widget.kt`) and push (`internal/push`).
- Kotlin changes need a new APK: `make android && make android-publish` on laptop (the app updates
  itself from `https://atc.example/app/`). Web-only changes reach the app on `make install`.

## Shipping

Own it end to end: merge to master, push, `make install` on desktop (restarting is safe:
`KillMode=process` keeps every session alive). Settings live in `~/.config/atc/env`. Don't stop at a
branch.

## Terminal size and rendering problems

Every attached screen is logged to the journal, server and browser side, keyed by the session's
short id: `journalctl --user -u atc --since "1 hour ago" | grep "term 260ef954"`.

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
