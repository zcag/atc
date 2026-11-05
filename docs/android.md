# Android app and notifications

`android/` holds a small Android app that shows your atc server's page and adds what a browser
cannot: notifications, calls, and being your phone's digital assistant: holding the side key, even
on the lock screen, opens a screen with the call to the assistant one tap away, what waits on you,
and your sessions beside it.

## Install

`atc app update` downloads the latest app and call characters from atc's releases (`atc setup` offers it), and the server
offers it at `/app/`. Settings › Devices shows a QR code to its download. The app checks that folder
and updates itself, and only installs an update signed like the app you have. The folder is
`~/.local/share/atc/app`, or `ATC_APP_DIR`; a build of your own (`make android`) goes there too.

To build it you need the Android SDK and a JDK 17, from a source checkout:

```sh
make android                                      # builds android/dist/atc.apk and version.json
make android-publish APP_HOST=<machine>           # copies them to ~/.local/share/atc/app on that machine
```

Release builds are signed with the key in the `atc.secrets` folder (`keystore.env`), which you point
at with `atc.secrets=<folder>` in `~/.gradle/gradle.properties`.

## Pairing

On the setup screen tap Scan QR and scan the code from `atc pair` or Settings › Devices on a device
already logged in, or open the `atc://pair?...` link. The phone gets its own token, kept hashed on
the server, and appears under Devices with its last seen time and Revoke. The address field stays for
a server you log in to with a token.

## Setting up the phone

After the first server, a checklist shows the digital assistant role, battery exemption, links,
microphone, notifications and the push distributor, each with its state and a button to its system
screen. Back twice › Set up this phone, or Settings › Devices, reopens it.

## atc links

`atc://open?path=/%23/s/<id>` opens a page on the server the phone uses, on any build. To also handle
your server's `https` links, build with its host: `atc.appLinkHost=atc.example` in
`~/.gradle/gradle.properties`, or `APP_LINK_HOST=atc.example` in `app.env` in the `atc.secrets` folder
(next to the signing key's `keystore.env`). Without one the app claims no `https` links. Android does
not verify a private host, so turn it on once: the checklist's Links row, or Settings › Apps › atc ›
Set as default › Supported web addresses.

## Private certificates

If your server uses a certificate from its own authority (Caddy's `tls internal`, a home CA), a
pairing carries its fingerprint, so the app trusts that authority with no prompt and refuses, loudly
and before sending the code, a server that presents anything else. Entering the address by hand
instead, the app asks once whether to trust it. Either way it then trusts the authority, so renewals
keep working. Put the authority's certificate in the app folder as `ca.crt` (for Caddy:
`pki/authorities/local/root.crt` in its data folder); without it the app trusts the top certificate
the server sends, which breaks when that one rotates. A fingerprint needs `ATC_PUBLIC_URL`, or the
page opened on the https address, so atc knows which server to look at.

## Notifications

Notifications use [UnifiedPush](https://unifiedpush.org): install a distributor such as the
[ntfy](https://ntfy.sh) app, point it at your ntfy server, and the atc app registers with atc on its
own. You get a notification when a session starts waiting for you and when one finishes a turn, with
the start of its reply, unless you have that session open.

## Share to atc

Share a link, text, screenshot or file from any app and choose atc. It opens a screen to say what
Claude should do with it and where: a new session in a folder you pick on any of your machines,
optionally in its own git worktree, or a running session.

## Widget and Quick Settings tile

The home-screen widget lists sessions that need you, are your turn or are working, most urgent first,
kept current by a silent push (and a refresh button); tap one to open it. Its mic button and the
**Talk to assistant** tile open the assistant, and the tile shows how many sessions need you.

## The assistant on the side key

Choose atc under Settings → Apps → Default apps → Digital assistant app. Holding the side key then
opens the assistant screen; on a call, it opens the call. Its assistant line opens the session named
`assistant` in `ATC_ASSIST_DIR` (default: `~/.local/share/atc/assistant`), starting or resuming it as needed.

The assistant can also put a page straight on the phone's screen with `atc show <file> --open` (on a
call, say), or any session's or agent's page at a section with `atc open @reports/summary#intro`,
instead of a notification. It opens through the phone's assistant role, so atc must be the digital
assistant; anything else falls back to a notification. Other sessions can't use it.
