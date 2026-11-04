# A browser for sessions

One Chrome can be shared by every session on a machine, each seeing only its own tabs. Point
`ATC_BROWSER` at Chrome's debugging address (`ATC_BROWSER=http://127.0.0.1:9222`) and give
sessions Playwright's MCP server through atc:

```sh
claude mcp add -s user browser -- atc browser mcp
```

`atc browser mcp` runs `@playwright/mcp` against atc instead of Chrome. atc relays it as that
session: tabs the session opens (and popups they open) are its own, every other tab is hidden
from it, and the profile, so the logins, stay shared. Which session owns which tab is kept in
`browser.json`.

A session with tabs gets a **Browser** entry next to its pages. It shows the tab live, and you
can click, scroll, type and go to an address in it, which is how you step in for a login or a
captcha; on a phone the tab takes the phone's size while you watch, and goes back when you leave.
Chrome can run headless for this, since atc is the screen.

Use a profile of its own for this Chrome (`--user-data-dir`): every session can reach whatever that
profile is logged in to.
