#!/bin/bash
# An Android 14 device of the demo's own, in Docker, for shooting the app's native call screens (redroid; the usual
# `redroid` command is Android 12, where calls don't run). Reaches only the demo: the app's 127.0.0.1:<port> is reversed to
# this machine's over adb. Each device is named after its port, so sessions can't land on each other's: without a port it
# takes a free one, and it refuses a port that's taken. It prints the port; give it to the other scripts as ADB_PORT.
# Stopping it removes the device and its data.
#   android14.sh up [adb port] | down <adb port>
set -eu
adb=$HOME/Android/sdk/platform-tools/adb
taken() { ss -ltn | grep -q "127.0.0.1:$1 "; }
case "${1:-}" in
up)
	port=${2:-}
	if [ -z "$port" ]; then
		port=5600
		while taken "$port"; do port=$((port + 1)); done
	elif taken "$port"; then
		echo "port $port is taken: another device may be on it" >&2
		exit 1
	fi
	dev=127.0.0.1:$port
	docker run -d --privileged --name "atc-demo-android14-$port" -p "$dev:5555" redroid/redroid:14.0.0_64only-latest \
		androidboot.redroid_width=1080 androidboot.redroid_height=2340 androidboot.redroid_dpi=420 \
		androidboot.redroid_gpu_mode=host androidboot.redroid_net_ndns=1 androidboot.redroid_net_dns1=9.9.9.9 >/dev/null
	"$adb" connect "$dev" >/dev/null
	for _ in $(seq 1 90); do
		[ "$("$adb" -s "$dev" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
		sleep 2
	done
	echo "$port"
	;;
down)
	"$adb" disconnect "127.0.0.1:$2" >/dev/null 2>&1 || true
	docker rm -f "atc-demo-android14-$2" >/dev/null
	;;
*)
	sed -n 2,7p "$0"
	exit 2
	;;
esac
