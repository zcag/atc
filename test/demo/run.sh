#!/bin/bash
# Serves atc on 127.0.0.1:<port> (default 7399) with made-up sessions, for the README's screenshots.
# Runs in its own Linux namespaces: the hostname is devbox, /home holds only /home/you (the temp
# HOME), so no real path, process or Claude Code state can reach a page. Stopping this script removes it all.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
port=${1:-7399}
tmp=$(mktemp -d)
ns=
stop() {
	[ -n "$ns" ] && pkill -KILL -P "$ns"
	wait
	rm -rf "$tmp"
}
trap stop EXIT
trap exit INT TERM

mkdir -p "$tmp/.local/bin"
(cd "$here/../.." && go build -o "$tmp/.local/bin/atc" .)
install -m755 "$here/claude" "$tmp/.local/bin/claude"
ln -s /bin/cat "$tmp/.local/bin/cat"
cp "$here/seed.py" "$tmp/.seed.py"

unshare -Urmu --pid --fork --kill-child --mount-proc /bin/sh -c '
	set -e
	hostname devbox
	mount -t tmpfs tmpfs /home
	mkdir /home/you
	mount --bind "$1" /home/you
	cd /home/you
	env -i HOME=/home/you python3 .seed.py
	exec env -i HOME=/home/you PATH=/home/you/.local/bin ATC_ADDR=127.0.0.1:"$2" atc serve --no-auth
' demo "$tmp" "$port" &
ns=$!
wait "$ns"
