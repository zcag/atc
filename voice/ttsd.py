"""Streaming TTS over HTTP for talk.py: POST /v1/audio/speech {"input", "voice", "engine", "sample_rate"} answers with
s16le mono PCM at sample_rate (default 16 kHz; the phone line takes 16 kHz, atc's app line 24 kHz, Higgs' own rate),
chunked as the engine produces it, so the first audio leaves before the sentence is done.

  <engine venv>/bin/python ttsd.py --engine pocket[,higgs,...] [--port 8811]

Engines: pocket (Turkish, pocket-tts-turkish), higgs (Higgs TTS 3 on the GPU, served by delta-higgs / audio.cpp on
:8841, voice = a cloned reference in its voice_dir; it speaks whatever language the text is in, and voices named en_*
are the English ones), ema, antalia, trendyol.
Higgs sometimes never ends a line (it ran on for 72 s of near-silence after an 8 s sentence), so its output stops after
1.5 s of near-silence, and in any case at 0.2 s per character plus 2 s, about three times normal speech.
Several engines can share one process; a request picks one with "engine", else the first.
GET /v1/voices lists the voices of the engines that have a catalog (higgs).

trendyol runs on the GPU (ROCm) and compiles for ~3 min at start.

Each engine lives in its own venv (bench in a separate bench). One request is synthesised at a time.
"""
import argparse, asyncio, os, threading
import numpy as np
import soxr
from aiohttp import web


HIGGS = os.environ.get("HIGGS_URL", "http://127.0.0.1:8841/v1/audio/speech")
HIGGS_VOICES = os.path.expanduser(os.environ.get("HIGGS_VOICES", "~/srv/call-data/audiocpp/voices/prompt_text"))


def s16(a):
    return (np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()


def native(rate):
    def mark(gen):
        gen.rate = rate
        return gen
    return mark


def engine(name, threads):
    """A generator of float32 chunks at the engine's own rate (gen.rate) for (text, voice)."""
    if name == "higgs":
        import json, urllib.request

        @native(24000)
        def gen(text, voice):
            body = {"model": "higgs", "input": text, "voice": voice or "voice_a", "seed": 0,
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
        gen.voices = lambda: [line.split("|")[0] for line in open(HIGGS_VOICES) if "|" in line]
        return gen
    import torch
    torch.set_num_threads(threads)
    if name == "ema":
        from ema_lightning import EMA
        tts = EMA(device="cpu")
        return native(16000)(lambda text, voice: tts.stream(text, seed=0, sample_rate=16000))
    if name == "antalia":
        from antalia_mini import Antalia
        tts = Antalia(device="cpu", sample_rate=16000)
        return native(16000)(lambda text, voice: tts.stream(text, seed=0))
    if name == "pocket":
        from pocket_tts_turkish import TurkishTTS
        tts = TurkishTTS.from_pretrained(device="cpu")
        return native(tts.sample_rate)(lambda text, voice: tts.stream(text, voice=voice or "female_2"))
    if name == "trendyol":
        from voxcpm.core import VoxCPM
        tts = VoxCPM.from_pretrained(hf_model_id="Trendyol/Trendyol-TTS", load_denoiser=False, optimize=True, device="cuda")
        return native(tts.tts_model.sample_rate)(
            lambda text, voice: tts.generate_streaming(text=text, cfg_value=2.0, inference_timesteps=10, retry_badcase=False))
    raise SystemExit(f"unknown engine {name}")


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
    a = p.parse_args()
    names = a.engine.split(",")
    LOCK, ENGINES = threading.Lock(), {n: engine(n, a.threads) for n in names}
    DEFAULT = ENGINES[names[0]]
    for synth in ENGINES.values():
        for _ in synth("Merhaba, nasılsın?", None):
            pass
    app = web.Application()
    app.router.add_post("/v1/audio/speech", speech)
    app.router.add_get("/v1/voices", voices)
    web.run_app(app, host="127.0.0.1", port=a.port, print=lambda *_: print(f"ttsd {a.engine} on :{a.port}", flush=True))
