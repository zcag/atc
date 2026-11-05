#!/bin/bash
# Serves atc on 127.0.0.1:<port> (default 7399) with made-up sessions, for the README's screenshots.
# Next to it, on the following ports: a real hub on a fake Claude (+1), a scripted call line (+2), a
# second atc as the peer "laptop" (+3), a Chromium of its own for session tabs (+4) and the shop those tabs
# open (+5). They share the host's network, so every address is set here and nothing falls back to atc's
# default ports, where a real atc may be running.
# With DEMO_LINE=real, +2 is left to voice-stack.sh (the real call.py, talk.py and ttsd.py) instead of the scripted line, and
# with DEMO_LINE=film atc's app line also goes through callfilm.py on +7. A third atc, the peer "gpu", is on +8.
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
(cd "$here/../.." && go build -o "$tmp/.local/bin/atc" . && go build -o "$tmp/.local/bin/demo-line" ./test/demo/line)
install -m755 "$here/claude" "$tmp/.local/bin/claude"
ln -s /bin/cat "$tmp/.local/bin/cat"
cp "$here/seed.py" "$tmp/.seed.py"
cp -r "$here/pages" "$tmp/.demo-pages"
cp -r "$here/agents" "$tmp/.demo-agents"
cp "$here/demo-hub.py" "$here/demo-browser.py" "$here/demo-tick.py" "$tmp/.local/bin/"
cp -r "$here/shop" "$tmp/.demo-shop"
# Characters are not in the repo: DEMO_PERSONAS names a folder of them (a personas/ as in docs/calls.md) for the call screens.
if [ -n "${DEMO_PERSONAS:-}" ]; then mkdir -p "$tmp/.local/share/atc/app" && cp -r "$DEMO_PERSONAS" "$tmp/.local/share/atc/app/personas"; fi
chrome=$(command -v chromium || command -v google-chrome-stable || true)

unshare -Urmu --pid --fork --kill-child --mount-proc /bin/bash -c '
	set -e
	hostname devbox
	mount -t tmpfs tmpfs /home
	mkdir /home/you /home/laptop /home/gpu
	mount --bind "$1" /home/you
	mkdir -p /home/laptop/.local
	ln -s /home/you/.local/bin /home/laptop/.local/bin
	mkdir -p /home/gpu/.local
	ln -s /home/you/.local/bin /home/gpu/.local/bin
	cd /home/you
	p=$2
	env -i HOME=/home/you DEMO_PEER=http://127.0.0.1:$((p + 3)) DEMO_PEER2=http://127.0.0.1:$((p + 8)) python3 .seed.py
	env -i HOME=/home/laptop python3 .seed.py laptop
	env -i HOME=/home/gpu python3 .seed.py gpu
	base="PATH=/home/you/.local/bin ATC_CALL_LINE=http://127.0.0.1:$((p + 2)) ATC_HUB=http://127.0.0.1:$((p + 1)) ATC_URL=http://127.0.0.1:$p ATC_CALL_NUMBER=+15550100 ATC_CALL_LINE_NUMBER=+15550101"
	if [ -n "$3" ]; then
		env -i HOME=/home/you /usr/bin/python3 -m http.server --bind 127.0.0.1 --directory .demo-shop $((p + 5)) >/dev/null 2>&1 &
		env -i HOME=/home/you "$3" --headless=new --no-sandbox --disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=$((p + 4)) \
			--user-data-dir=/home/you/.demo-chrome --window-size=1000,860 --host-resolver-rules="MAP shop.example 127.0.0.1" about:blank >/dev/null 2>&1 &
		env -i HOME=/home/you /usr/bin/python3 .local/bin/demo-browser.py http://127.0.0.1:$((p + 4)) http://shop.example:$((p + 5))/
		base="$base ATC_BROWSER=http://127.0.0.1:$((p + 4))"
	fi
	[ "$4" != scripted ] || env -i HOME=/home/you $base demo-line 127.0.0.1:$((p + 2)) &
	env -i HOME=/home/you /usr/bin/python3 .local/bin/demo-tick.py &
	env -i HOME=/home/you $base atc hub -addr 127.0.0.1:$((p + 1)) &
	(cd /home/laptop; exec env -i HOME=/home/laptop PATH=/home/you/.local/bin ATC_URL=http://127.0.0.1:$((p + 3)) ATC_ADDR=127.0.0.1:$((p + 3)) atc serve --no-auth) &
	(cd /home/gpu; exec env -i HOME=/home/gpu PATH=/home/you/.local/bin ATC_URL=http://127.0.0.1:$((p + 8)) ATC_ADDR=127.0.0.1:$((p + 8)) atc serve --no-auth) &
	[ "$4" != film ] || base="$base ATC_CALL_LINE=http://127.0.0.1:$((p + 7))"
	exec env -i HOME=/home/you $base ATC_ADDR=127.0.0.1:$p atc serve --no-auth
' demo "$tmp" "$port" "$chrome" "${DEMO_LINE:-scripted}" &
ns=$!
wait "$ns"
