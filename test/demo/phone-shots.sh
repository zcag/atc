#!/bin/bash
# Shoots the real app on android14.sh's device, against run.sh with DEMO_LINE=real and voice-stack.sh: the ring, the call,
# the app around it. A debug build (assembleDebug -Patc.abi=x86_64 -Patc.secrets=/nonexistent), because only debug builds have
# the Fake hook that stands in for a push; from Push.handle on it's the release code. Hub on <port> + 1.
# The app takes its theme from the server, so nothing else may change the look while this runs: not shots.js's themes.
#   phone-shots.sh setup <apk> <port>                 install and point at the demo
#   phone-shots.sh shoot <port> <out dir> <dark|light>
#   phone-shots.sh character <port> <out dir> <dark|light> <person>    a call with that person as the assistant (june, arthur; run.sh's DEMO_PERSONAS)
set -eu
dev=127.0.0.1:${ADB_PORT:?the port android14.sh up printed}
adb=("$HOME/Android/sdk/platform-tools/adb" -s "$dev")
pkg=io.github.zcag.atc
reason="Checkout errors jumped to 8% after the last deploy."
open() { "${adb[@]}" shell am start -W -a android.intent.action.VIEW -d "'atc://open?path=/%23/$1'" -n "$pkg/.MainActivity" >/dev/null; }
tap_text() { # the centre of the first on-screen node with this text
	"${adb[@]}" shell uiautomator dump /data/local/tmp/ui.xml >/dev/null
	"${adb[@]}" shell cat /data/local/tmp/ui.xml | python3 -c "
import re, sys
for m in re.finditer(r'text=\"([^\"]*)\"[^>]*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', sys.stdin.read()):
    if sys.argv[1] in m.group(1):
        a, b, c, d = map(int, m.groups()[1:])
        print((a + c) // 2, (b + d) // 2)
        break" "$1"
}
ring() {
	curl -s -m 200 -X POST "http://127.0.0.1:$((port + 1))/call" -d "{\"reason\":\"$reason\",\"via\":\"app\",\"from\":\"[from session \\\"Checkout errors after the deploy\\\" (@ops on devbox) · report back when done]\"}" >/dev/null &
	sleep .6
	echo "am broadcast -f 32 -n $pkg/.Fake --es push '{\"ring\":{\"reason\":\"$reason\",\"at\":$(date +%s)}}'" >/tmp/atc-ring-cmd.sh
	"${adb[@]}" push /tmp/atc-ring-cmd.sh /data/local/tmp/ring.sh >/dev/null
	"${adb[@]}" shell sh /data/local/tmp/ring.sh >/dev/null
}
case "${1:-}" in
setup)
	port=$3
	"${adb[@]}" install -r -g "$2" >/dev/null
	"${adb[@]}" reverse "tcp:$port" "tcp:$port" >/dev/null
	for p in RECORD_AUDIO POST_NOTIFICATIONS READ_CONTACTS WRITE_CONTACTS READ_CALL_LOG READ_PHONE_STATE; do "${adb[@]}" shell pm grant $pkg android.permission.$p; done
	"${adb[@]}" shell appops set $pkg USE_FULL_SCREEN_INTENT allow
	"${adb[@]}" shell cmd role add-role-holder android.app.role.ASSISTANT $pkg
	"${adb[@]}" shell settings put secure voice_interaction_service $pkg/.AssistService
	"${adb[@]}" shell settings put secure assistant $pkg/.AssistService
	"${adb[@]}" shell am start -W -n $pkg/.MainActivity >/dev/null
	"${adb[@]}" shell am broadcast -f 32 -n $pkg/.Fake --es server "http://127.0.0.1:$port" >/dev/null
	;;
shoot)
	port=$2 out=$3/$4
	mkdir -p "$out"
	shot() { "${adb[@]}" exec-out screencap -p >"$out/$1.png"; }
	line() { curl -s -m 3 -X POST "http://127.0.0.1:$((port + 2))/hangup" >/dev/null; }
	list=$(curl -s "http://127.0.0.1:$port/api/sessions")
	id() { python3 -c "import json,sys; print(next(s['id'] for s in json.loads(sys.argv[1]) if s['title'].startswith(sys.argv[2])))" "$list" "$1"; }
	"${adb[@]}" shell cmd uimode night "$([ "$4" = dark ] && echo yes || echo no)" >/dev/null
	line
	"${adb[@]}" shell am force-stop $pkg
	"${adb[@]}" shell am start -W -n $pkg/.MainActivity >/dev/null
	sleep 5
	if at=$(tap_text "NOT NOW") && [ -n "$at" ]; then "${adb[@]}" shell input tap $at; sleep 1; fi
	sleep 1
	ring
	sleep 2.2
	shot ring-headsup
	"${adb[@]}" shell input tap 600 200
	sleep 1.5
	shot ring-full
	"${adb[@]}" shell input tap 676 2104
	sleep 6.5
	shot call-speaking
	sleep 3
	"${adb[@]}" shell input keyevent BACK
	sleep 2
	shot call-bar
	sleep 50
	line
	sleep 3
	"${adb[@]}" shell cmd notification cancel_all >/dev/null 2>&1 || true
	open hold
	sleep 3.5
	shot phone-hold
	open "s/$(id "Why checkout")"
	sleep 3
	if at=$(tap_text "src/checkout/expiry.ts") && [ -n "$at" ]; then "${adb[@]}" shell input tap $at; sleep 1.2; fi
	shot phone-read
	open "s/$(id "Cart totals")"
	sleep 3
	shot phone-reply
	open "p/@ops/checkout-errors"
	sleep 3.5
	shot phone-page
	;;
character)
	port=$2 out=$3/$4 who=$5
	mkdir -p "$out"
	shot() { "${adb[@]}" exec-out screencap -p >"$out/$1.png"; }
	"${adb[@]}" shell cmd uimode night "$([ "$4" = dark ] && echo yes || echo no)" >/dev/null
	curl -s -m 3 -X POST "http://127.0.0.1:$((port + 2))/hangup" >/dev/null
	sleep 1
	"${adb[@]}" shell am force-stop $pkg
	python3 -c "import json,sys; f=sys.argv[1]; d=json.load(open(f)); d['langs']['en']=sys.argv[2]; json.dump(d,open(f,'w'))" "$(ls -t /tmp/tmp.*/.config/atc/persons.json | head -1)" "$who"
	"${adb[@]}" shell am start -W -n $pkg/.MainActivity >/dev/null
	sleep 4
	ring
	sleep 2.2
	"${adb[@]}" shell input tap 600 200
	sleep 2
	"${adb[@]}" shell input tap 676 2104
	sleep 4
	shot "$who-1"
	sleep 2.5
	shot "$who-2"
	sleep 2.5
	shot "$who-3"
	sleep 4
	shot "$who-4"
	sleep 4
	shot "$who-5"
	curl -s -m 3 -X POST "http://127.0.0.1:$((port + 2))/hangup" >/dev/null
	;;
*)
	sed -n 2,7p "$0"
	exit 2
	;;
esac
