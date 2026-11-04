# Pages

An agent shows you something to look at (a report, a handover, a diagram, a screenshot) with
`atc show <file>`, and it opens next to the conversation that made it.

## How pages work

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
  of your devices for as long as the page is up. `<session>` is its title in link form
  (`/#/p/assistant/weekly-report`), `@agent`, or its id (or the id's first 8 characters); when two
  sessions share a title, the title link opens the one that showed that page last. **Pages** (`p`,
  or the page button above the list) shows every page from every session and machine, with previews,
  a filter and take-down.
- **Talking back.** A page that loads `/atc.js` gets `window.atc`: `atc.state.get()` and
  `atc.state.set(obj)` keep the page's data on the server, across devices; `atc.send(text)` sends
  a note straight to the session, like `atc send`; `atc.copy(text)` copies, in the browser and the
  app. Links to other sites open outside atc. Outside atc the same calls fall back to localStorage
  and the clipboard.
- **Looking like atc.** A page that links `/atc.css` gets atc's fonts, colors (light and dark)
  and a dense kit that draws a result the way atc draws itself (rules, square state marks, color
  only for state): page head, ruled sections, prose, stat tiles, tables, facts, meters with a
  pace tick, callouts, rows, links to sessions, PRs and files, buttons, code, diffs, changed
  files, figures, before and after, charts, event strips, checklists, timelines, empty and
  loading states, a side column and print. The classes of the kit before it (cards, `.stat`
  strips, pills, the `t-*` tones) still work. `atc.toast(text, label, fn)` shows a toast with
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
  stdin; anywhere else `atc state <session> [page]` prints it and `atc state -set <session> [page]`
  merges stdin into it; over HTTP it is `GET` and `PUT /api/sessions/<session>/pages/<name>/state`.

A folder shows its `index.html`, with the files beside it loading by relative path. HTML, images,
Markdown, PDF, CSV/TSV, video and audio render. Pages run sandboxed, away from atc's own login.
`atc show -h` is the reference agents read; atc's MCP instructions point every agent at it.
