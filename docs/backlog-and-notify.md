# Backlog and notify

## Backlog

Work you want an agent to do, but not now. **Backlog** (the line under the session list, the top of
the board, or `/`) is its own screen, filtered by project like the list:

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
