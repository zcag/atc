#!/usr/bin/env bash
# Replay each trace into each build on redroid and print the app's counters.
#   beforeafter.sh <serial> <before.apk> <after.apk> <trace>...
set -e
serial=$1 before=$2 after=$3; shift 3
here=$(dirname "$0")
for build in before after; do
  apk=$before; [ $build = after ] && apk=$after
  adb -s "$serial" install -r -d "$apk" >/dev/null
  for trace in "$@"; do
    echo "$build $(basename "$trace") $(uv run --script "$here/replay.py" "$trace" --serial "$serial" 2>/dev/null | tail -1)"
  done
done
