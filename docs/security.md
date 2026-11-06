# Security

## What a login gives

**A login to atc is a shell on the machine it runs on.** The browser terminal runs Claude Code as
your user, and Claude Code runs commands. Anyone holding a token can do what you can do there. Treat
atc's address and tokens like an SSH key.

atc is built for one user per install. There are no accounts or roles: every login sees and can do
the same.

**Don't serve atc on the public internet.** By default it answers only this machine, your local network and your tailnet, and refuses
public addresses; `ATC_ADDR=127.0.0.1:7272` narrows that to this machine. A port forward keeps the public address, so it is refused too,
but setting `ATC_ADDR` yourself or a proxy on the same machine bypasses the check. atc has not been
hardened or audited for exposure to strangers: pairing claims, the login and the webhook would all face the whole internet, with
a shell behind them. [Reach it from other devices](install.md#reach-it-from-other-devices) lists the private ways in.

## How requests get in

- **The server token** is generated on first start and kept in `~/.config/atc/token`. `atc token`
  prints it. Opening `/?token=<token>` sets a login cookie (HttpOnly, SameSite=Strict) and redirects
  away from the URL. Every `/api/` request needs it, as that cookie or as a bearer header.
- **Device tokens** come from pairing: `atc pair`, or Settings › Devices, makes a one-time code that
  lasts 10 minutes. The device claims it and gets a token of its own, kept hashed on the server, with
  its last seen time and Revoke. Revoking also ends that device's live streams and terminals. Claims
  are rate limited by address. A pairing can also carry the server's certificate fingerprint, so the
  new device pins it and refuses anything else. A device token opens the same API as the server
  token, with no scopes: the difference is that it can be revoked.
- **Tailscale, opt-in:** `atc setup` asks, and the answer is no unless you say yes. With `ATC_TRUST_TAILNET=1`, requests from devices of your own Tailscale user
  need no token. atc checks each with `tailscale whois`. That trusts the device, not a person: any
  program or other user on it gets a full login. Revoking a device in Settings does not stop that;
  removing it from your tailnet does. Requests a browser marks as cross-site are refused. The address
  alone is not enough: the request's Host must be an IP, a name with no dot, a `.ts.net` name, the host of
  `ATC_PUBLIC_URL`, or one listed in `ATC_ALLOWED_HOSTS` (space separated), so a site can't reach atc by
  rebinding its own name to this machine. On any other name you get the login prompt.
- **Behind a proxy:** with `ATC_TRUSTED_PROXIES` (CIDR list) atc takes the client's address from the
  forwarded header of those proxies only. It matters for the tailnet check and the claim rate limit.
- **`atc serve -no-auth`** turns the token off. Use it only behind something else that authenticates.
- Cross-site requests that change something are refused: a non-GET `/api/` request whose `Origin`
  host differs from the request's host gets a 403.

atc serves plain HTTP by default, and anyone on your local network can reach its login page, the Android app's download and whatever
else [is not behind the token](#what-is-not-behind-the-token). On a network you don't fully trust, set
`ATC_ADDR=127.0.0.1:7272` or put HTTPS in front, or the token travels in clear. See
[Reach it from other devices](install.md#reach-it-from-other-devices).

## What is not behind the token

- `/healthz`, the login and pairing-claim endpoints.
- The page's own files (HTML, scripts, styles), which hold no data.
- `/app/`: the Android app and the call characters, for a phone that isn't logged in yet.
- `/api/whatsapp/hook`, which checks the webhook's signature against `ATC_WHATSAPP_SECRET` and then
  the sender.
- Output file links, which are signed for a session and folder and expire after 12 hours.

## Pages and files

Pages and previews are written by agents and can hold text nobody vetted (mail, web pages). They run
sandboxed through a CSP `sandbox` header, away from atc's own login. A page can run only the commands
its session declared with `atc show --action`, without a shell, for at most 30 seconds, and each run
is logged. Declare only commands that are safe with any arguments: see [Pages](pages.md#how-pages-work).

## Sessions and approval

A message from another session is not your approval. atc tells every session that through its tools'
instructions. atc's own tools and `atc send` set `approved` only for the assistant: see
[Sessions driving sessions](sessions.md#sessions-talking-to-each-other). None of this is a sandbox:
what a session can really do is set by Claude Code's permissions, and the next section says what
follows from that.

## What atc does not enforce

The server checks none of what follows. The first two hold only while Claude follows its instructions
and the sender uses atc's client; the rest are what a login means.

- **The approval line is text.** "relays the user's own go-ahead" is the last line of a message, added
  and refused in atc's client (`internal/client/self.go`), not by the server, and what acts on it is
  the receiving Claude reading it. Any session with a shell can read your token (`~/.config/atc/token`)
  and post a message that ends in that line. A session
  talked into it by something it read can therefore approve work in another session.
- **The assistant acts without a tap.** Nobody can approve a tool on a call or on WhatsApp, so what it may do is set up front:
  [its level](assistant.md#what-it-may-do-alone), `daily` by default. At `daily` it reads your files and the web, so a page that
  talks it into something has more to work with than at `limited`; at `full` there are no checks at all.
- **So does an agent on a call,** [at the same level](presets-and-agents.md#on-a-call), with its own folder in place of the
  assistant's. A deny in its `settings.json` wins over every level, since Claude Code checks denies before allow rules and before
  `--dangerously-skip-permissions`. Those denies are a list of patterns, not a sandbox: `Bash(*send*)` doesn't cover an atc tool or a
  script that sends. At `daily` it reads your files and the web like the assistant, but it may not run `atc guest`: a guest gets a channel
  to you, and only the assistant's brief says to add one only when you ask. At `full`, or with `--dangerously-skip-permissions` in `ATC_CLAUDE_ARGS`,
  nothing stops it. It can't pass on your approval: `approved` is only for the assistant.
- **Guest isolation is the same kind of thing.** The guests' conversation is kept apart by its brief,
  `--strict-mcp-config` (no MCP servers but atc's) and the name check in `atc wa`. It runs as your user,
  so a shell that Claude Code's permissions allow it reaches your files and your atc login. A guest's
  words are followed by an end marker, so they can't be a message's last line; that stops a guest from
  writing the approval line, not from persuading Claude.
- **A page's `atc.run` does not ask.** A page can run the actions its session declared, with any
  arguments, as soon as it is open. Only `atc.send` asks you first. Pages show text nobody vetted, so
  an action is as safe as the worst arguments it can be given.
- **A device token equals the server token.** A paired phone can read every session, type into them
  and pair more devices. A lost device stays that powerful until you revoke it.
- **The hub has no login.** It listens on `127.0.0.1:8820` by default, and whatever reaches it speaks
  to the assistant as you. It refuses web pages (a request with an `Origin` or `Sec-Fetch-Site` header,
  or addressed to a dotted host name), so a browser on the machine can't reach it, but any program or
  local user can. Pointing `ATC_HUB_ADDR` at anything but loopback hands that to the network.

## The phone app

The app gives the page native powers (start a call, read what was shared to it, the widget's feed,
open and copy files with your login). They reach only frames of the server's own origin: every frame
sees one object that does nothing without a per-WebView secret, and that secret is injected only into
those frames, so sandboxed pages and other sites get nothing. A WebView too old to inject by origin
gets no bridge at all and the page runs as it would in a browser: no native call, no share target, no
widget feed. Whoever controls the server still controls the page, and so these powers. Only the main
frame can open an outside app by navigating, and a file shared to the app sits at a random path that
only `shared()` gives out. A page opened as the app's whole screen, rather than in a frame, can still
send you to an outside app (a `tel:` link opens the dialer, say) without a tap.

An update is installed only if `version.json` names a path on the server, and the file is this app
(same package name) signed by the certificate of the installed app. The checksum only catches a damaged
download, since it comes from the same server. A server can't push another app or another signer's
build, though it can offer any newer build you signed.

## Secrets at rest

`settings.json` and `env` hold whatever keys you put there, with private file modes; the API never
returns a secret in clear. Secrets in command lines are hidden on the resources screens, but other
local users can still read a command line with `ps`, so atc keeps its own token out of the ones it
starts: `atc browser mcp` gives Playwright a private file that is removed once Playwright has answered.
The one left is yours to type: `atc login <url> <token>` shows the token in `ps` while it runs.
Transcripts, summaries and pages stay on the machine that made them, and on any device that opens them.

## Reporting a problem

Open a private security advisory on the GitHub repository.
