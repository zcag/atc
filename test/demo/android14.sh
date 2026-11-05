#!/bin/bash
# An Android 14 device of the demo's own, in Docker, for shooting the app's native call screens (redroid; the usual
# `redroid` command is Android 12, where calls don't run). Reaches only the demo: the app's 127.0.0.1:<port> is reversed to
# this machine's over adb. Stopping it removes the device and its data.
#   android14.sh up <adb port> | down
set -eu
name=atc-demo-android14
adbp=${2:-5599}
dev=127.0.0.1:$adbp
adb=$HOME/Android/sdk/platform-tools/adb
case "${1:-}" in
up)
	docker run -d --privileged --name $name -p "$dev:5555" redroid/redroid:14.0.0_64only-latest \
		androidboot.redroid_width=1080 androidboot.redroid_height=2340 androidboot.redroid_dpi=420 \
		androidboot.redroid_gpu_mode=host androidboot.redroid_net_ndns=1 androidboot.redroid_net_dns1=9.9.9.9 >/dev/null
	"$adb" connect "$dev" >/dev/null
	for _ in $(seq 1 90); do
		[ "$("$adb" -s "$dev" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
		sleep 2
	done
	"$adb" -s "$dev" shell getprop ro.build.version.release
	;;
down)
	"$adb" disconnect "$dev" >/dev/null 2>&1 || true
	docker rm -f $name >/dev/null
	;;
*)
	sed -n 2,5p "$0"
	exit 2
	;;
esac
