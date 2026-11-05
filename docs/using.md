# Using atc

## In a browser

`atc serve` prints a link with a login token. Open it once and the browser stays logged in.
`atc token` prints the token again.

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
    a draft is kept per session. Attach files with the clip, by pasting or by dropping them. A
    message shows in the transcript the moment you send it, and stays there with "Try again" if it
    could not be sent. Above the box, the summary's suggested replies send with one tap.
  - Select any text for **Quote**, **Explain**, **Push back** or **Do this** (each quotes it into
    the box with a start you can edit), **Copy** or **Find**.
- **New session** starts Claude in any folder, with an optional name and first message. In a folder
  Claude Code doesn't trust yet, Start shows you its trust prompt first ([Install](install.md#notes)).
- **Assistant** (the chat button, or `a`) opens one session with the atc tools, for asking about
  your other sessions or driving them. It is the same session the phone's side key opens, and with
  a hub (see [The assistant](assistant.md)) the same conversation as WhatsApp and calls.
- **Earlier** lists past conversations, folded until you open it. Open one and press **Resume** to continue it.
- On a phone, a row of keys above the keyboard gives you Esc, Tab, Shift+Tab, Ctrl and arrows.
  Drag on the terminal to scroll.
- Press `?` for keyboard shortcuts.

When two screens show the same session, the one you last typed in decides the terminal size, and
the other scales to fit. **Fit to this one** takes it back.

## From a terminal

```sh
atc login https://atc.example.internal <token>   # once, on each computer
atc pair                                         # on a logged-in machine: a QR code and text for a new device
atc login <pairing text>                         # on the new one: it gets a token of its own
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
atc top                                          # memory, CPU, disk per session, and what outlived its session
atc top api                                      # one session's processes
```

Commands that print something take `-json`. `atc limits -short` is one line, for a status line or
a shell prompt. `atc help` lists every command.

In the terminal UI, the line above the keys shows your plan limits, checked every two minutes. `o`
shows the highlighted session's outputs, `u` its tokens and estimated cost, and `U` the plan
limits with tokens per day.

`atc new` without a folder uses the current one, written relative to your home folder, so the
same path works on a server where your projects live under the same names.

Inside an attached session, Ctrl+Z detaches. So does Esc from Claude's agent view.

## Where you left off, on every device

What you last looked at, what you were typing and how your bays are laid out live in atc, not in
one browser, so the phone and the desk agree. Each is a small file in the config dir
(`seen.json`, `drafts.json`, `bays.json`), and each change reaches open pages over `/api/events`.
They stay on the atc the page talks to, and are not passed to peers.

- **Seen marks**, for "since you last looked": `GET /api/seen` returns `{session: time}`;
  `PUT /api/seen` with `{sessionId, at}` records one, keeping the later of the two (no `at`, or one
  in the future, means now). Marks older than 30 days are dropped. Event `seen`: `{sessionId, at}`.
- **Drafts**: `GET /api/drafts` returns `{session: {text, at}}`; `PUT /api/drafts/<session>` with
  `{text}` saves one, empty text deletes it, the last write wins. Event `drafts`:
  `{sessionId, text, at}` (empty text when deleted). Drafts untouched for 30 days are dropped.
- **Bays** (a bay is a project, as the session list groups them): `GET /api/bays` returns
  `{order: [bay], memory: {bay: {sid, view, panes, at}}}`; `PUT /api/bays` with `{order}` saves
  the order; `PATCH /api/bays/<bay>` with any of `{sid, view, panes}` merges into that bay's memory
  (`panes` is whatever JSON the page keeps; `null` clears it). Event `bays`: the whole object.

Every write may carry `from` (any id the page picks), which comes back in its event, so a page can
tell its own echo from another device's change.
