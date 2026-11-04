# Several machines in one list

One atc server can list sessions from others. Run atc on each machine, then on the one you open in
your browser, list the others in `~/.config/atc/peers.json` and restart it:

```json
[{ "name": "laptop", "url": "http://laptop:7272", "token": "<atc token on the laptop>" }]
```

`atc peer add [-name N] <pairing>` does the same from the text `atc pair` prints on the other
machine, so that machine gives this one a token of its own.

Sessions from every machine appear together, tagged with their machine. Opening, stopping,
resuming or uploading to one is forwarded to the machine it lives on, and **New session** asks
which machine to start on (`atc new -host laptop` from a terminal). A machine that is off shows as
offline and the rest keep working: after its first failed request atc stops asking it (requests
for its sessions fail at once instead of waiting out a timeout) and checks every ten seconds
whether it is back.

Keep the machines on the same atc version, since one forwards requests to the other.
