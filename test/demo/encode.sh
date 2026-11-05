#!/bin/bash
# Turns compose.js's PNGs into the README's WebP images in docs/img: test/demo/encode.sh <folder compose.js wrote to>.
set -eu
in=${1:-/tmp/atc-final}
out=$(cd "$(dirname "$0")/../.." && pwd)/docs/img
mkdir -p "$out"
width() {
	case "$1" in
	hero) echo 2400 ;;
	phones | call-ring) echo 2000 ;;
	palette | new | backlog | settings) echo 1400 ;;
	*) echo 1800 ;;
	esac
}
for f in "$in"/*/*.png; do
	name=$(basename "$f" .png)
	mode=$(basename "$(dirname "$f")")
	if [ "$name" = themes ]; then dst=$out/themes.webp; else dst=$out/$name-$mode.webp; fi
	magick "$f" -resize "$(width "$name")x" -quality 84 -define webp:method=6 -define webp:alpha-quality=90 "$dst"
done
du -ch "$out"/*.webp | tail -1
