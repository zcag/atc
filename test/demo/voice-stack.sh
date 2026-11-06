#!/bin/bash
# The real call stack for test/demo: call.py, talk.py and ttsd.py from voice/, with the flags the units use and the
# English engine and pick `atc voice install` sets up (the voice of persons.json's assistant), against test/demo/run.sh's hub. Everything it keeps is under
# $dir, with its own HOME, so it reads nothing of a real setup and shares no port with one.
#   voice-stack.sh fetch          download the models and the voice's venv (about 2 GB)
#   voice-stack.sh run <port>     run on <port> + 2 (line) and + 6 (voice), <port> being what run.sh was given
#   voice-stack.sh say <voice> <out.wav> <text>   render a line, for the demo's made-up caller
#   voice-stack.sh clips <dir> [voice]            render the caller's lines in beats.json: 1.wav for film.py, 1.pcm for callfilm.py, ...
set -eu
here=$(cd "$(dirname "$0")" && pwd)
voice=$here/../../voice
dir=${ATC_DEMO_VOICE:-/tmp/atc-demo-voice}
mkdir -p "$dir/home" "$dir/state"
stack() {
	env -i HOME="$dir/home" PATH=/usr/bin:/bin UV_CACHE_DIR="$dir/uv" UV_PYTHON_INSTALL_DIR="$dir/py" \
		TALK_LANG=en TTS_ENGINES=pocket-en TALK_MODELS="$dir/models" TALK_STATE="$dir/state" TTS_VENV="$dir/tts-venv" \
		TTS_HF_HOME="$dir/hf" HF_HOME="$dir/hf" ATC_CONFIG_DIR="$dir/home/atc" "$@"
}
case "${1:-}" in
fetch) stack TTS_ENGINES=pocket-en,kokoro uv run --script "$voice/fetch.py" ;;
run)
	p=$2
	trap 'kill 0' EXIT
	python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
json.dump({"en": next(p["voices"]["en"] for p in d["persons"] if p["id"] == d["langs"]["en"])}, open(sys.argv[2], "w"))' "$voice/persons.json" "$dir/state/voice.json"
	stack "$dir/tts-venv/bin/python" "$voice/ttsd.py" --engine pocket-en --port $((p + 6)) &
	stack DELTA_CALL_BRIDGE=0 DELTA_CALL_HOST=127.0.0.1 DELTA_CALL_PORT=$((p + 2)) DELTA_CALL_DIAL_ALLOW=+15550100 uv run --script "$voice/call.py" &
	until curl -sf -o /dev/null "http://127.0.0.1:$((p + 6))/v1/voices" || curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$((p + 6))/" | grep -q 404; do sleep 1; done
	stack TALK_TTS="http://127.0.0.1:$((p + 6))/v1/audio/speech" uv run --script "$voice/talk.py" --loop --smart-turn --end-ms 1500 --stt stream \
		--brain hub --line app --out "$dir/state/calls" --url "ws://127.0.0.1:$((p + 2))/call" --hub "http://127.0.0.1:$((p + 1))" &
	wait
	;;
say)
	stack "$dir/tts-venv/bin/python" -I "$here/say.py" "$2" "$3" "$4"
	;;
clips)
	n=0
	python3 -c 'import json, sys; [print(b["you"]) for b in json.load(open(sys.argv[1])) if "you" in b]' "$here/beats.json" | while read -r line; do
		n=$((n + 1))
		stack "$dir/tts-venv/bin/python" -I "$here/say.py" "${3:-am_puck}" "$2/$n.wav" "$line" </dev/null
		ffmpeg -y -v error -i "$2/$n.wav" -ar 16000 -ac 1 -f s16le "$2/$n.pcm" </dev/null
	done
	;;
*)
	sed -n 2,8p "$0"
	exit 2
	;;
esac
