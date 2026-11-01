#!/bin/bash
# rec.sh <character dir> <out.mp4> [timeline.json] [query]: renders a simulated call through web/rig.js frame by
# frame on desktop's GPU at phone size (720x1560), and muxes the call's audio when the timeline has one.
set -e
R=$(cd "$(dirname "$0")" && pwd)
C=/home/user/.local/share/persona2d/rig/clip
mkdir -p $C
cp "$R/../../../web/rig.js" "$R/../../../web/motion.js" "$R/record.html" "$R/poses.json" $C/
TL=${3:-/home/user/.local/share/persona2d/clip/timeline.json}
cp "$TL" $C/timeline.json
rm -rf $C/p $C/frames
cp -r "$1" $C/p
python3 /home/user/.local/share/persona2d/serve.py $C $C/frames &
srv=$!
trap 'kill $srv' EXIT
sleep 1
cd /home/user/.local/share/persona2d
timeout 900 uv run -q --with playwright python rec.py "http://127.0.0.1:8932/record.html?${4}" 880 2>&1 | grep -v -E "Driver|ReadPixels" | tail -3
AUDIO=$(dirname "$TL")/mix.wav
if [ -z "$3" ] && [ -f "$AUDIO" ]; then
  ffmpeg -loglevel error -y -framerate 30 -i $C/frames/%04d.jpg -i "$AUDIO" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 96k -shortest -movflags +faststart "$2"
else
  ffmpeg -loglevel error -y -framerate 30 -i $C/frames/%04d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart "$2"
fi
echo "$2"
