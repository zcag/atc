#!/usr/bin/env bash
cd "$(dirname "$0")/../../.."
# Needs playwright-core on NODE_PATH; CHROME_BIN picks the browser, else Playwright's own.
base=${1:-http://127.0.0.1:7299}
sid=$(curl -s "$base/api/sessions" | python3 -c "import json,sys; d=json.load(sys.stdin); d=d if isinstance(d,list) else d['sessions']; print(next(s['sessionId'] for s in d if s['state'] in ('working','your-turn')))")
for t in shell board settings pages pagezen transcript phone needs pins landing seen asks assistant hold callmenu ptt ring; do timeout 600 node "test/ui/build/$t.js" "$base"; done
timeout 200 node test/ui/build/header.js "$base" "$sid"
timeout 400 node test/ui/build/screens.js "$base"
