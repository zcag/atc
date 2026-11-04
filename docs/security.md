# Security

## What a login gives

**A login to atc is a shell on the machine it runs on.** The browser terminal runs Claude Code as
your user, and Claude Code runs commands. Anyone holding a token can do what you can do there. Treat
atc's address and tokens like an SSH key.

atc is built for one user per install. There are no accounts or roles: every login sees and can do
the same.

## How requests get in

- **The server token** is generated on first start and kept in `~/.config/atc/token`. `atc token`
  prints it. Opening `/?token=<token>` sets a login cookie (HttpOnly, SameSite=Strict) and redirects
  away from the URL. Every `/api/` request needs it, as that cookie or as a bearer header.
- **Device tokens** come from pairing: `atc pair`, or Settings › Devices, makes a one-time code that
  lasts 10 minutes. The device claims it and gets a token of its own, kept hashed on the server, with
  its last seen time and Revoke. Revoking also ends that device's live streams and terminals. Claims
  are rate limited by address. A pairing can also carry the server's certificate fingerprint, so the
  new device pins it and refuses anything else.
- **Tailscale, opt-in:** with `ATC_TRUST_TAILNET=1`, requests from devices on your own tailnet need
  no token. atc checks each with `tailscale whois`. Revoking a device in Settings does not stop that.
- **Behind a proxy:** with `ATC_TRUSTED_PROXIES` (CIDR list) atc takes the client's address from the
  forwarded header of those proxies only. It matters for the tailnet check and the claim rate limit.
- **`atc serve -no-auth`** turns the token off. Use it only behind something else that authenticates.
- Cross-site requests that change something are refused: a non-GET `/api/` request whose `Origin`
  host differs from the request's host gets a 403.

atc serves plain HTTP on `127.0.0.1` by default. Don't expose it on an untrusted network without
HTTPS in front, or the token travels in clear. See
[Reach it from other devices](install.md#reach-it-from-other-devices).

## What is not behind the token

- `/healthz`, the login and pairing-claim endpoints.
- The page's own files (HTML, scripts, styles), which hold no data.
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
instructions. Only the assistant can mark a message as your go-ahead (`approved`), and atc refuses
that flag from any other session: see
[Sessions driving sessions](sessions.md#sessions-talking-to-each-other). These are instructions to
Claude rather than a sandbox: what a session can really do is set by Claude Code's permissions.

## Secrets at rest

`settings.json` and `env` hold whatever keys you put there, with private file modes; the API never
returns a secret in clear. Secrets in command lines are hidden on the resources screens. Transcripts,
summaries and pages stay on the machine that made them, and on any device that opens them.

## Reporting a problem

Open a private security advisory on the GitHub repository.
