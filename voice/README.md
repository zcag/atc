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
| `deploy.sh` | fetch, install the units, restart each only between calls |
| `systemd/` | the user units; generic, every value of a setup comes from `~/.config/atc/voice.env` |
| `hub/cli.py` | type into the hub from a shell, for testing |
| `test/` | the pack test, `make check` runs it |

## Settings: `~/.config/atc/voice.env`

| setting | default | |
|---|---|---|
| `TALK_LANG`, `TALK_ALSO` | `en`, none | first language; others (space separated) a call can switch to with `[LANG:xx]` |
| `TALK_ASSISTANT`, `TALK_USER` | the pack's neutral names | the names in its lines |
| `TALK_TTS_ENGINE`, `TALK_TTS_VOICE`, `..._<CODE>` | ttsd's first engine, its default voice | per language, for example `TALK_TTS_VOICE_EN` |
| `TALK_ANSWER` | empty | numbers answered on the device line as the user; the app line always is |
| `TALK_STT` | empty | a Whisper endpoint for the second reading of short turns; empty skips that reading |
| `TALK_ARGS`, `TTS_ARGS` | empty | extra flags for `talk.py`, `ttsd.py` |
| `TTS_ENGINES`, `TTS_PORT`, `TTS_VENV`, `TTS_HF_HOME` | `pocket-en`, `8812`, under the data dir, `~/.cache/atc/voice/hf` | ttsd |
| `ATC_VOICE_DIR` | `~/.local/share/atc/voice` | where the files run from |
| `ATC_VOICE_UNITS` | `delta-call delta-tts delta-talk-app` | what deploy.sh installs and restarts; add `delta-talk` for a phone, `delta-higgs` for Higgs |
| `TALK_MODELS`, `HF_HOME` | `~/.cache/atc/voice`, its `hf` | models and the rendered-phrase cache |
| `TALK_STATE` | `~/.local/state/atc/voice` | `calls/<talk-time>/`, `calls.jsonl`, `voice.json` |
| `DELTA_CALL_BRIDGE`, `DELTA_CALL_PORT`, `DELTA_CALL_DIAL_ALLOW`, `ANDROID_SERIAL` | `0`, `8807`, none, adb's pick | the line |
| `HIGGS_DIR`, `HIGGS_VOICES`, `HIGGS_URL` | under the data dir, `:8841` | Higgs, on a GPU, set up by hand |

## Adding a language

Copy `lang/en.json` to `lang/<code>.json`, translate it and point `STT` at a streaming sherpa-onnx transducer (`hf`
for a Hugging Face repo, or `base` and `dir` for files at a URL); `test/test_lang.py` checks the keys and slots match.
The word lists (`BACKCHANNEL`, `STOP`, `UNFINISHED`, ...) come from the first language only, so put the words of the others
in it too if a call really mixes them; each language's own `ACKS`, `STT` and voice follow the call. The built-in modes
(`modes/phone.md`, `guest-call.md`) quote the English `CUT_OFF` and `[HANGUP]`; a language with other markers needs its
own copies of them in `~/.config/atc/modes`.

## Testing without a phone

`talk.py --sim caller.wav --hub http://127.0.0.1:<port> --lang en --smart-turn --end-ms 1500` plays a WAV as the caller through the
whole pipeline and leaves `call.wav`, `turns.jsonl` and `debug.jsonl` in its `--out`. `DELTA_CALL_BRIDGE=0
DELTA_CALL_PORT=8817 call.py` is a line with no phone; `ATC_CALL_TEST_LINE` sends test app calls to it.
