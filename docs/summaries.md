# Summaries

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

In the session list and on the board, a session waiting on you shows its status with the gist's
bullets under it. **Settings, Appearance, Session list** turns that down to the status line alone,
per device.

## What it costs, and how to change it

Summaries come from `claude -p` with haiku and a fixed prompt, with no tools, no CLAUDE.md and no
saved session, so each costs about 2,500 tokens of your plan. Replies of a line or two keep their
own text as the status; the model only suggests what to send back. Each machine summarizes its own
sessions and keeps the result in `summaries.json` in its config folder. Set `ATC_SUMMARY_MODEL` for
another Claude model, `ATC_SUMMARY_URL` (with `ATC_SUMMARY_MODEL`) for an OpenAI-compatible endpoint
such as a local model, or `ATC_SUMMARY=off` to turn it off. The prompt is
`internal/summary/prompt.md`.

## In the API and the tools

Each session in `/api/sessions` carries `summary` (`status`, `gist`, `overview`, the `reply` it
describes) and `summarizing` while one is being made. `GET /api/sessions/{id}/summary?wait=30`
returns it, making one if needed (also for a past session), and `POST` makes it again.
`atc summary <session>` prints it, and the MCP tools include it in `sessions` and `wait`.
