#!/bin/bash
# probe.sh [query] [seconds]: runs the record page already staged by rec.sh for a while and prints what it logs.
C=/home/user/.local/share/persona2d/rig/clip
R=$(cd "$(dirname "$0")" && pwd)
cp "$R/../../../web/rig.js" "$R/../../../web/motion.js" "$R/record.html" "$R/poses.json" $C/
rm -rf $C/frames
python3 /home/user/.local/share/persona2d/serve.py $C $C/frames &
srv=$!
trap 'kill $srv' EXIT
sleep 1
cd /home/user/.local/share/persona2d
timeout ${2:-40} uv run -q --with playwright python rec.py "http://127.0.0.1:8932/record.html?${1}" ${2:-30} 2>&1 | grep -v -E "Driver|ReadPixels"
ls $C/frames | wc -l
