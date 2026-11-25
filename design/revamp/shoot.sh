#!/usr/bin/env bash
# shoot.sh <mock.html> <out.png> <width> <height> [query]
# Screenshots a mock with headless Chromium at the given CSS size (query: dark, light).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=$(realpath "$1"); out=$2; w=$3; h=$4; q=${5:-}
chromium --headless=new --no-sandbox --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$w,$h" --virtual-time-budget=1500 \
  --screenshot="$(realpath -m "$out")" "file://$src${q:+?$q}" >/dev/null 2>&1
echo "$out"
