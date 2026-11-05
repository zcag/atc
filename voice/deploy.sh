#!/usr/bin/env bash
# Runs from the installed copy (atc voice install, or make install-voice): models and venv, then the units, each
# restarted only between calls.
set -euo pipefail
cd "$(dirname "$0")"
set -a
[ ! -f ~/.config/atc/voice.env ] || . ~/.config/atc/voice.env
[ "$(uname)" != Darwin ] || UV_PYTHON=3.12 # a Mac's newest Python, Homebrew's or uv's, can be newer than onnxruntime's wheels
set +a
chmod +x call.py talk.py fetch.py hub/cli.py device/build.sh

uv run -q --script fetch.py
uv run -q --script talk.py --help > /dev/null
mkdir -p "${TALK_STATE:-$HOME/.local/state/atc/voice}/calls"

port=${DELTA_CALL_PORT:-8807}
units=${ATC_VOICE_UNITS:-delta-call delta-tts delta-talk-app}
if [ "$(uname)" = Darwin ]; then
  atc=${ATC_BIN:-atc}
  active() { "$atc" voice unit active "$1"; }
  start() { "$atc" voice unit start "$1"; }
else
  mkdir -p ~/.config/systemd/user
  cp systemd/calls.slice ~/.config/systemd/user/
  for u in $units; do cp systemd/$u.service ~/.config/systemd/user/; done
  systemctl --user daemon-reload
  active() { systemctl --user is-active -q "$1.service"; }
  start() { systemctl --user enable "$1.service" && systemctl --user restart "$1.service"; }
fi
idle() {
  s=$(curl -sf --max-time 3 127.0.0.1:$port/status) || { [ $? = 7 ]; return; } # refused: the line is down or starting, so no call
  echo "$s" | uv run -q --no-project --python 3.12 python -c 'import json,sys; s=json.load(sys.stdin); sys.exit(not(s["call"] == "idle" and s.get("app") in (None, "connected")))'
}
quiet=0
while active delta-call && [ $quiet -lt 12 ]; do
  if idle; then quiet=$((quiet + 1)); else quiet=0; echo "a call is on, the deploy waits for a quiet minute"; fi
  sleep 5
done
for u in $units; do
  if active delta-call; then
    for i in $(seq 360); do idle && break; echo "a call is on, $u waits"; sleep 5; done
    idle || { echo "still not idle after 30 min, $u and the rest not restarted"; exit 1; }
  fi
  start $u
  sleep 1
done
for u in $units; do active $u && echo "$u: active" || echo "$u: not active"; done
