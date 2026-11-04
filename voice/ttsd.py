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

One request is synthesised at a time.
"""
import argparse, asyncio, os, threading
import numpy as np
import soxr
from aiohttp import web


HIGGS = os.environ.get("HIGGS_URL", "http://127.0.0.1:8841/v1/audio/speech")
HIGGS_VOICES = os.path.expanduser(os.environ.get("HIGGS_VOICES") or "~/.local/share/atc/voice/audiocpp/voices")
MODELS = os.path.expanduser(os.environ.get("TALK_MODELS") or "~/.cache/atc/voice")


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
        return native(24000)(lambda text, voice: kokoro_stream(tts, text, voice or "af_heart"))
    if name == "piper":
        from piper import PiperVoice
        tts = PiperVoice.load(f"{MODELS}/piper/en_US-amy-medium.onnx")
        return native(tts.config.sample_rate)(lambda text, voice: (c.audio_float_array for c in tts.synthesize(text)))
    import torch
    torch.set_num_threads(threads)
    if name == "pocket-en":
        from pocket_tts import TTSModel
        tts, states = TTSModel.load_model(), {}

        def gen(text, voice):
            voice = voice or "alba"
            states.setdefault(voice, tts.get_state_for_audio_prompt(voice))
            return (c.numpy() for c in tts.generate_audio_stream(states[voice], text))
        return native(tts.sample_rate)(gen)
    if name == "pocket":
        from pocket_tts_turkish import TurkishTTS
        tts = TurkishTTS.from_pretrained(device="cpu")
        return native(tts.sample_rate, "Merhaba, nasılsın?")(lambda text, voice: tts.stream(text, voice=voice or "female_2"))
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


async def speech(request):
    body = await request.json()
    resp = web.StreamResponse(headers={"content-type": "audio/pcm"})
    await resp.prepare(request)
    loop, q, gone = asyncio.get_running_loop(), asyncio.Queue(), threading.Event()

    def run():
        try:
            with LOCK:
                synth = ENGINES.get(body.get("engine"), DEFAULT)
                for b in pcm(synth, body["input"], body.get("voice"), int(body.get("sample_rate") or 16000)):
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
    names = a.engine.split(",")
    LOCK, ENGINES = threading.Lock(), {n: engine(n, a.threads) for n in names}
    DEFAULT = ENGINES[names[0]]
    for synth in ENGINES.values():
        for _ in synth(synth.warm, None):
            pass
    if a.warm_only:
        raise SystemExit
    app = web.Application()
    app.router.add_post("/v1/audio/speech", speech)
    app.router.add_get("/v1/voices", voices)
    web.run_app(app, host="127.0.0.1", port=a.port, print=lambda *_: print(f"ttsd {a.engine} on :{a.port}", flush=True))
