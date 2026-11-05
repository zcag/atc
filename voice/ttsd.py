"""Streaming TTS over HTTP for talk.py: POST /v1/audio/speech {"input", "voice", "engine", "sample_rate"} answers with
s16le mono PCM at sample_rate (default 16 kHz; the phone line takes 16 kHz, atc's app line 24 kHz, Higgs' own rate),
chunked as the engine produces it, so the first audio leaves before the sentence is done.

  <engine venv>/bin/python ttsd.py --engine pocket[,higgs,...] [--port 8811]

Engines: pocket (Turkish, CPU, pocket-tts-turkish), pocket-en (English, CPU, Kyutai's pocket-tts), kokoro (English, CPU,
kokoro-onnx), piper (English, CPU, piper-tts), higgs (Higgs TTS 3 on the GPU, served by delta-higgs / audio.cpp on :8841,
voice = a cloned reference in its voice_dir; it speaks whatever language the text is in, and voices named en_* are the
English ones). fetch.py installs what each needs into the venv this runs from.
Higgs sometimes never ends a line (it ran on for 72 s of near-silence after an 8 s sentence), so its output stops after
1.5 s of near-silence, and in any case at 0.2 s per character plus 2 s, about three times normal speech.
Several engines can share one process; a request picks one with "engine", else the first.
GET /v1/voices lists the voices of the engines that have a catalog.

A voice named in persons.json is the same voice on every engine: the table there says what it is on each, an engine's own
name or a file in voices/ beside this one. On an engine it doesn't list, it is that engine's default.

It also answers atc's voice picker (ATC_CALL_VOICES): GET /api/voices lists each language's voices with the pick, POST
/api/voices {"lang", "voice"} picks one into voice.json, which the talker reads before each reply, and GET
/api/voices/sample?lang&voice&text renders a wav once and keeps it, answering 409 for a new one while a call is on.

One request is synthesised at a time.
"""
import argparse, asyncio, hashlib, http.client, json, os, threading, urllib.request, wave
import numpy as np
import soxr
from aiohttp import web


HIGGS = os.environ.get("HIGGS_URL", "http://127.0.0.1:8841/v1/audio/speech")
HIGGS_VOICES = os.path.expanduser(os.environ.get("HIGGS_VOICES") or "~/.local/share/atc/voice/audiocpp/voices")
MODELS = os.path.expanduser(os.environ.get("TALK_MODELS") or "~/.cache/atc/voice")
STATE = os.path.expanduser(os.environ.get("TALK_STATE") or "~/.local/state/atc/voice")
HERE = os.path.dirname(os.path.abspath(__file__))
LANGS = [os.environ.get("TALK_LANG") or "en", *(os.environ.get("TALK_ALSO") or "").split()]
SAMPLE_RATE = 24000
POCKET_EN_VOICES = "alba", "anna", "azelma", "charles", "cosette", "eponine", "fantine", "george", "javert", "jean", "marius", "paul", "vera"
with open(f"{HERE}/persons.json", encoding="utf-8") as f:
    SHIPPED = json.load(f)["voices"]


def s16(a):
    return (np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()


def native(rate, warm="Hello, how are you?"):
    def mark(gen):
        gen.rate, gen.warm = rate, warm
        return gen
    return mark


def engine(name, threads):
    """A generator of float32 chunks at the engine's own rate (gen.rate) for (text, voice)."""
    if name == "higgs":
        import json, urllib.request

        def voices():
            return [line.split("|")[0] for line in open(f"{HIGGS_VOICES}/prompt_text") if "|" in line]

        @native(24000, "Merhaba, nasılsın?")
        def gen(text, voice):
            body = {"model": "higgs", "input": text, "voice": voice or voices()[0], "seed": 0,
                    "response_format": "pcm", "stream_format": "audio"}
            r = urllib.request.urlopen(urllib.request.Request(HIGGS, json.dumps(body).encode(),
                                                              {"content-type": "application/json"}), timeout=60)
            odd, left = b"", int((2 + 0.2 * len(text)) * 24000 * 2)
            quiet = []
            while left > 0 and (chunk := r.read1(1 << 14)):
                left -= len(chunk)
                chunk, odd = odd + chunk, b""
                if len(chunk) % 2:
                    chunk, odd = chunk[:-1], chunk[-1:]
                out = np.frombuffer(chunk, "<i2").astype(np.float32) / 32768
                if len(out) and np.sqrt(np.mean(out ** 2)) < 0.01:
                    quiet.append(out)
                    if sum(map(len, quiet)) > 1.5 * 24000:
                        break
                    continue
                yield np.concatenate(quiet + [out])
                quiet = []
            r.close()
        gen.voices = voices
        return gen
    if name == "kokoro":
        from kokoro_onnx import Kokoro
        os.environ["ONNX_NUM_THREADS"] = str(threads)
        tts = Kokoro(f"{MODELS}/kokoro/kokoro-v1.0.int8.onnx", f"{MODELS}/kokoro/voices-v1.0.bin")
        gen = native(24000)(lambda text, voice: kokoro_stream(tts, text, voice or "af_heart"))
        gen.voices = tts.get_voices
        return gen
    if name == "piper":
        from piper import PiperVoice
        tts = PiperVoice.load(f"{MODELS}/piper/en_US-amy-medium.onnx")
        gen = native(tts.config.sample_rate)(lambda text, voice: (c.audio_float_array for c in tts.synthesize(text)))
        gen.voices = lambda: ["amy"]
        return gen
    import torch
    torch.set_num_threads(threads)
    if name == "pocket-en":
        from pocket_tts import TTSModel
        tts, states = TTSModel.load_model(), {}

        def state(voice):
            if voice not in states:
                try:
                    states[voice] = tts.get_state_for_audio_prompt(voice)
                except Exception as e:  # a recording needs Kyutai's gated weights; a call must still be heard
                    if voice == "alba":
                        raise
                    print(f"voice {voice} did not load, so this speaks as alba: {e}", flush=True)
                    states[voice] = state("alba")
            return states[voice]

        def gen(text, voice):
            return (c.numpy() for c in tts.generate_audio_stream(state(voice or "alba"), text))
        gen.voices = lambda: list(POCKET_EN_VOICES)
        return native(tts.sample_rate)(gen)
    if name == "pocket":
        from pocket_tts_turkish import TurkishTTS
        tts = TurkishTTS.from_pretrained(device="cpu")

        def gen(text, voice):
            if voice and os.path.isfile(voice):
                name = os.path.basename(voice)
                voice = name if name in tts.voices else tts.voice_from_file(voice, name=name)
            return tts.stream(text, voice=voice or "female_2")
        gen.voices = lambda: tts.voices
        return native(tts.sample_rate, "Merhaba, nasılsın?")(gen)
    raise SystemExit(f"unknown engine {name}")


def kokoro_stream(tts, text, voice):
    import asyncio
    stream = tts.create_stream(text, voice=voice, lang="en-us")
    loop = asyncio.new_event_loop()
    try:
        while True:
            yield loop.run_until_complete(anext(stream))[0]
    except StopAsyncIteration:
        pass
    finally:
        loop.close()


def pcm(synth, text, voice, rate):
    """The engine's chunks as s16le at rate."""
    rs = None if synth.rate == rate else soxr.ResampleStream(synth.rate, rate, 1, dtype="float32")
    for c in synth(text, voice):
        c = np.asarray(c, np.float32)
        yield s16(rs.resample_chunk(c) if rs else c)
    if rs:
        yield s16(rs.resample_chunk(np.zeros(0, np.float32), last=True))


async def voices(request):
    return web.json_response({n: synth.voices() for n, synth in ENGINES.items() if hasattr(synth, "voices")})


def as_engine(voice, name):
    """What a voice is on this engine: persons.json's table for its own voices, a file in voices/ when there is one."""
    if voice not in SHIPPED:
        return voice
    got = SHIPPED[voice].get(name)
    path = f"{HERE}/voices/{got}"
    return path if got and os.path.isfile(path) else got


def lang_engine(lang):
    """The engine this language speaks with, as the talker chooses it."""
    name = os.environ.get(f"TALK_TTS_ENGINE_{lang.upper()}") or (os.environ.get("TALK_TTS_ENGINE") if lang == LANGS[0] else None)
    return name if name in ENGINES else NAMES[0]


def lang_voices(lang):
    name = lang_engine(lang)
    own = ENGINES[name].voices() if hasattr(ENGINES[name], "voices") else []
    if name == "higgs":
        own = [v for v in own if v.startswith("en_") == (lang == "en")]
    return list(dict.fromkeys([*SHIPPED, *own]))


def picks():
    try:
        with open(f"{STATE}/voice.json", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def voice_list():
    chosen, out = picks(), {}
    for lang in LANGS:
        with open(f"{HERE}/lang/{lang}.json", encoding="utf-8") as f:
            line = json.load(f)["VOICE_SAMPLE"]
        env = os.environ.get(f"TALK_TTS_VOICE_{lang.upper()}") or (os.environ.get("TALK_TTS_VOICE") if lang == LANGS[0] else None)
        out[lang] = {"voices": lang_voices(lang), "current": chosen.get(lang) or env, "sample": line}
    return out


async def voice_get(request):
    return web.json_response(await asyncio.to_thread(voice_list))


async def voice_pick(request):
    body = await request.json()
    lang, voice = body.get("lang"), body.get("voice")
    if lang not in LANGS or voice not in await asyncio.to_thread(lang_voices, lang):
        return web.Response(status=400, text=f"no voice {voice} in {lang}")
    chosen = {**picks(), lang: voice}
    os.makedirs(STATE, exist_ok=True)
    with open(f"{STATE}/voice.json.tmp", "w", encoding="utf-8") as f:
        json.dump(chosen, f)
    os.replace(f"{STATE}/voice.json.tmp", f"{STATE}/voice.json")
    return web.json_response(await asyncio.to_thread(voice_list))


def on_call():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{os.environ.get('DELTA_CALL_PORT') or 8807}/status", timeout=2) as r:
            st = json.load(r)
    except (OSError, ValueError, http.client.HTTPException):
        return False
    return st.get("call") != "idle" or st.get("app") not in (None, "connected")


def render_sample(path, name, voice, text):
    with LOCK:
        audio = b"".join(pcm(ENGINES[name], text, voice, SAMPLE_RATE))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path + ".tmp", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(audio)
    os.replace(path + ".tmp", path)


async def voice_sample(request):
    lang, voice, text = (request.query.get(k, "") for k in ("lang", "voice", "text"))
    if lang not in LANGS or not text or voice not in await asyncio.to_thread(lang_voices, lang):
        return web.Response(status=400, text="want a language this line speaks, one of its voices and a text")
    name = lang_engine(lang)
    made = as_engine(voice, name)
    path = f"{MODELS}/samples/" + hashlib.sha1(f"{name}|{made}|{text[:1000]}".encode()).hexdigest() + ".wav"
    if not os.path.exists(path):
        if await asyncio.to_thread(on_call):
            return web.Response(status=409, text="a call is on")
        await asyncio.to_thread(render_sample, path, name, made, text[:1000])
    return web.FileResponse(path, headers={"content-type": "audio/wav"})


async def speech(request):
    body = await request.json()
    resp = web.StreamResponse(headers={"content-type": "audio/pcm"})
    await resp.prepare(request)
    loop, q, gone = asyncio.get_running_loop(), asyncio.Queue(), threading.Event()

    def run():
        try:
            with LOCK:
                name = body.get("engine") if body.get("engine") in ENGINES else NAMES[0]
                for b in pcm(ENGINES[name], body["input"], as_engine(body.get("voice"), name), int(body.get("sample_rate") or 16000)):
                    if gone.is_set():
                        break
                    loop.call_soon_threadsafe(q.put_nowait, b)
        finally:
            loop.call_soon_threadsafe(q.put_nowait, None)

    threading.Thread(target=run, daemon=True).start()
    try:
        while (b := await q.get()) is not None:
            await resp.write(b)
        await resp.write_eof()
    finally:
        gone.set()
    return resp


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--engine", required=True)
    p.add_argument("--port", type=int, default=8811)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--warm-only", action="store_true", help="fetch and load the engines, then exit")
    a = p.parse_args()
    NAMES = a.engine.split(",")
    LOCK, ENGINES = threading.Lock(), {n: engine(n, a.threads) for n in NAMES}
    for synth in ENGINES.values():
        for _ in synth(synth.warm, None):
            pass
    if a.warm_only:
        raise SystemExit
    app = web.Application()
    app.router.add_post("/v1/audio/speech", speech)
    app.router.add_get("/v1/voices", voices)
    app.router.add_get("/api/voices", voice_get)
    app.router.add_post("/api/voices", voice_pick)
    app.router.add_get("/api/voices/sample", voice_sample)
    web.run_app(app, host="127.0.0.1", port=a.port, print=lambda *_: print(f"ttsd {a.engine} on :{a.port}", flush=True))
