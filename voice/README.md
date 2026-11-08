# voice: calls with the assistant

The runtime of `atc voice`, the add-on that lets the atc app (and optionally a phone on USB) call the assistant.
`atc voice install` carries these files in its binary and writes them to `~/.local/share/atc/voice`.

```
atc app ── atc (/api/call/line) ── call.py :8807 ── talk.py ── atc hub :8820 (the assistant)
                                   phone on USB ┘      │ VAD, turn end, streaming STT, barge-in
                                                    ttsd.py :8812 (TTS)
```

| file | what |
|---|---|
| `call.py` | the call line: app calls, and with `DELTA_CALL_BRIDGE=1` a phone over adb (`device/`, SIM and WhatsApp) |
| `talk.py` | the conversation on a call, one per line (`--line app`, `--line device`) |
| `ttsd.py` | streaming TTS over HTTP; `--engine` names one or more engines |
| `langpack.py`, `lang/<code>.json` | every word in a language (below) |
| `fetch.py` | downloads models and the TTS venv for the configured languages and engines; safe to rerun |
| `deploy.sh` | fetch, install the units, restart each only between calls; on macOS through `atc voice unit`, which is launchd's side |
| `systemd/` | the user units; generic, every value of a setup comes from `~/.config/atc/voice.env`. On macOS atc renders them into launchd plists (`unitCommand` in `voice.go`), so they are the only definition there too |
| `hub/cli.py` | type into the hub from a shell, for testing |
| `test/` | the pack test, `make check` runs it |

## Settings: `~/.config/atc/voice.env`

| setting | default | |
|---|---|---|
| `TALK_LANG`, `TALK_ALSO` | `en`, none | the languages this talker has, models and all: `TALK_LANG` and others (space separated) a call can switch to with `[LANG:xx]`. Calls start in Settings' Language when it is one of these (read at each call, no restart), else in `TALK_LANG` |
| `TALK_ASSISTANT`, `TALK_USER` | Settings' names (read at each call), then the pack's neutral names | the names in its lines |
| `TALK_TTS_ENGINE`, `TALK_TTS_VOICE`, `..._<CODE>` | ttsd's first engine, its default voice | per language, for example `TALK_TTS_VOICE_EN` |
| `TALK_ANSWER` | empty | numbers answered on the device line as the user; the app line always is |
| `TALK_STT` | empty | a Whisper endpoint for the second reading of short turns; empty skips that reading |
| `TALK_ARGS`, `TTS_ARGS` | empty | extra flags for `talk.py`, `ttsd.py` |
| `TTS_ENGINES`, `TTS_PORT`, `TTS_VENV`, `TTS_HF_HOME` | each language's default (`pocket-en`, `pocket,ahenk` for Turkish), `8812`, under the data dir, `~/.cache/atc/voice/hf` | ttsd; atc's voice picker (`ATC_CALL_VOICES`) is on the same port |
| `TTS_REMOTE_URL`, `TTS_REMOTE_MODEL`, `TTS_REMOTE_VOICE`, `TTS_REMOTE_RATE`, `TTS_REMOTE_KEY` | none, `tts-1`, the server's first, `24000`, none | the `remote` engine, your own server (`--tts-url`). The rate has to be what the server sends: raw PCM doesn't say, and a wrong one plays at the wrong pitch. Keep this file private if it holds a key |
| `ATC_VOICE_DIR` | `~/.local/share/atc/voice` | where the files run from |
| `ATC_VOICE_UNITS` | `delta-call delta-tts delta-talk-app` | what deploy.sh installs and restarts; add `delta-talk` for a phone, `delta-higgs` for Higgs |
| `TALK_MODELS`, `HF_HOME` | `~/.cache/atc/voice`, its `hf` | models and the rendered-phrase cache |
| `TALK_STATE` | `~/.local/state/atc/voice` | `calls/<talk-time>/`, `calls.jsonl`, `voice.json` |
| `DELTA_CALL_BRIDGE`, `DELTA_CALL_PORT`, `DELTA_CALL_HOST`, `DELTA_CALL_DIAL_ALLOW`, `ANDROID_SERIAL` | `0`, `8807`, `127.0.0.1` (empty is every interface), none, adb's pick | the line |
| `HIGGS_DIR`, `HIGGS_VOICES`, `HIGGS_URL` | under the data dir, `:8841` | Higgs, on a GPU, set up by hand |
| `TALK_PICKER`, `PICKER_DIR` | empty, `~/.local/share/atc/voice/picker` | the picker (below): `http://127.0.0.1:8842` turns it on, add `delta-picker` to the units; empty is the rules without it |

## Built-in voices

`persons.json` holds the people a new install starts with and what each one's voice is on each engine. To change a voice,
change its line in `voices`:

```json
"june": {"pocket-en": "june.safetensors", "pocket": "june.wav", "kokoro": "af_heart"},
```

A value is the engine's own voice name, or a file in `voices/` beside it, which `atc voice install` writes with the rest
of the stack. A voice can choose its engine: June lists `ahenk` and not `pocket`, so she speaks Turkish on Ahenk Cep even
though the language's engine is `pocket`. With no entry for any engine that is loaded and speaks the language, it is the
default voice of the language's engine. pocket-en takes a voice exported to `.safetensors` on any
machine, and a recording only where Kyutai's gated weights are available, so ship the export (without those weights a
recording falls back to `alba`, with a line in the log). pocket takes a recording. A file in `voices/` is compiled into the
binary, so keep it small.

## macOS

`docs/calls.md`, "On a Mac", says what a user gets. For working on it: the labels are `io.github.zcag.atc.<unit>` in the
user's launchd domain, which is per user and not per `HOME`, so a test in a scratch `HOME` has real labels (its plists
spell out that `HOME`). Logs are `/tmp/<unit>.log`. `UV_PYTHON=3.12` is set there because uv otherwise takes the newest Python
it finds, which can be newer than onnxruntime's wheels. On Linux it isn't, to leave a working setup's environments alone.

## Adding a language

Copy `lang/en.json` to `lang/<code>.json`, translate it and point `STT` at a streaming sherpa-onnx transducer (`hf`
for a Hugging Face repo, or `base` and `dir` for files at a URL); `test/test_lang.py` checks the keys and slots match.
Everything heard and said follows the call's language: its word lists (`BACKCHANNEL`, `STOP`, ...), `STT`,
voice, markers and spoken lines. Any language's hangup tag ends a call, whichever language it is in.
`GARBLES_OTHERS` says this language's transcriber turns the call's other languages into noise (English's does, Turkish's spells
English well enough): then a turn also carries another transcriber's reading when the two disagree, so the assistant can
tell the user switched. The built-in modes
(`modes/phone.md`, `guest-call.md`) quote the English `CUT_OFF` and `[HANGUP]`; a language with other markers needs its
own copies of them in `~/.config/atc/modes`.

## Reading a turn twice

With `TALK_STT` set, a short turn is also read by Whisper, because the streaming transcriber has no context for a lone word.
`--second-all <language>` (in `TALK_ARGS`) does the same for every longer turn in that language, with `TALK_STT_WORDS` as
Whisper's prompt: the terms you use that it would otherwise misspell, a short list. The assistant gets the second reading as
a note beside your words when the two differ, and your words on screen stay the streaming ones. A reading later than 0.8 s,
or one that `WHISPER_JUNK` catches, is left out. `second` lines in `turns.jsonl` carry both readings and how long Whisper took.

## The picker

`picker.py` lets a small local model choose what delta says around the assistant's reply, from the pack's `PICK_*`
lines. `delta-picker` serves it: llama.cpp's `llama-server` (Vulkan build) in `$PICKER_DIR/bin` and the model as
`$PICKER_DIR/model.gguf`, set up by hand like Higgs. Gemma 4 E4B (Q4_K_M) takes about 5 GB beside Higgs on a 16 GB GPU,
which slows a Higgs render by 1% loaded and 3% at four picks a second.

- **Fillers** say nothing: the model only picks the kind of sound for the turn (looking, thinking, waiting on a request,
  listening, a complaint) or none for a bare yes, asked when the turn is sent so the answer is in by `--ack-ms`.
- **Greetings** by the clock and how long ago the last call ended (not for guests).
- **Tool lines** are written by the model from the tool call itself (the hub's `tool_input` event: the input, and for
  Bash the assistant's own description), 2 to 5 words; only housekeeping (tool lookups, todo lists) gets none. A written line
  may follow a filler, and the filler waits while one is coming.
- **Hold lines** come from `PICK_HOLDS` by what the open tool waits on, with no model.

The wording within a kind is chosen in `Wording`: a line never comes twice running, and the weight beside it is a habit.
Only lines already rendered are offered, so a take that failed never plays.

It only advises. Each choice has a deadline (`--picker-ms`, `--picker-greet-ms`, `--picker-tool-ms`); a late answer, an
error, a line that fails its check (too long, code, a repeat) or a bug in `picker.py` gives `FALLBACK`, and that moment
goes to the rules without it. A server that is down at the start of a call, or two misses in a row, turn it off for the
call. `pick`, `picker` (misses) and `progress` lines in `turns.jsonl` show each choice and its time.
`test/test_picker.py` runs it against a fake server that is down, slow, broken or talking nonsense.

## Testing without a phone

`talk.py --sim caller.wav --hub http://127.0.0.1:<port> --lang en --end-ms 700` plays a WAV as the caller through the
whole pipeline and leaves `call.wav`, `turns.jsonl` and `debug.jsonl` in its `--out`. `DELTA_CALL_BRIDGE=0
DELTA_CALL_PORT=8817 call.py` is a line with no phone; `ATC_CALL_TEST_LINE` sends test app calls to it.
