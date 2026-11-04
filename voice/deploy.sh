#!/usr/bin/env bash
# Runs ON desktop after rsync into ~/srv/call/: the phone is on desktop's USB.
set -euo pipefail
cd "$(dirname "$0")"
chmod +x call.py echo.py talk.py hub/cli.py device/build.sh

data=~/srv/call-data
if [ ! -x $data/tts-venv/bin/python ]; then
  uv venv --python 3.12 $data/tts-venv
  uv pip install --python $data/tts-venv/bin/python --extra-index-url https://download.pytorch.org/whl/cpu \
    "torch==2.15.0+cpu" "pocket-tts-turkish==0.1.0" soxr aiohttp
fi
models=~/.cache/delta-talk
mkdir -p $models ~/.local/state/delta-call/calls
[ -s $models/silero_vad.onnx ] || curl -sfLo $models/silero_vad.onnx https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
[ -s $models/smart-turn-v3.2-cpu.onnx ] || curl -sfLo $models/smart-turn-v3.2-cpu.onnx https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx
for m in sherpa-onnx-streaming-zipformer-en-2023-06-26; do
  [ -d $models/$m ] || curl -sfL https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$m.tar.bz2 | tar xj -C $models
done

units="delta-call delta-higgs delta-tts delta-talk delta-talk-app"
mkdir -p ~/.config/systemd/user
cp calls.slice ~/.config/systemd/user/
for u in $units; do cp $u.service ~/.config/systemd/user/; done
systemctl --user daemon-reload
idle() {
  curl -sf --max-time 3 127.0.0.1:8807/status | python3 -c 'import json,sys; s=json.load(sys.stdin); sys.exit(not(s["call"] == "idle" and s.get("app") in (None, "connected")))'
}
quiet=0
while systemctl --user is-active -q delta-call.service && [ $quiet -lt 12 ]; do
  if idle; then quiet=$((quiet + 1)); else quiet=0; echo "a call is on, the deploy waits for a quiet minute"; fi
  sleep 5
done
for u in $units; do
  systemctl --user enable $u.service
  if systemctl --user is-active -q delta-call.service; then
    for i in $(seq 360); do idle && break; echo "a call is on, $u waits"; sleep 5; done
    idle || { echo "still not idle after 30 min, $u and the rest not restarted"; exit 1; }
  fi
  systemctl --user restart $u.service
  sleep 1
done
systemctl --user status $units --no-pager | grep -E "●|Active:" || true
