#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp", "numpy"]
# ///
"""Replay a call's recorded arrival trace into the app's playback, on redroid, and print what the app counted.

The trace is what the app reported during a real call (delta-call keeps it in
~/.local/state/delta-call/app-traces/<call>.jsonl): every one of delta's frames with the ms since the one before and
whether it was speech. This serves the app line protocol on :PORT (call -> active), sends speech frames as a tone and
silent ones as zeros on that same schedule, then hangs up and prints the app's last stats, and how the frames reached
it (its own trace of this run). The debug build's Replay activity is the client:
  replay.py trace.jsonl [--port 8818] [--seconds N] [--serial 127.0.0.1:5555]"""
import argparse, asyncio, json, subprocess, time
import numpy as np
from aiohttp import web

p = argparse.ArgumentParser()
p.add_argument("trace")
p.add_argument("--port", type=int, default=8818)
p.add_argument("--host", default="127.0.0.1")
p.add_argument("--seconds", type=float, default=0, help="replay only the first N seconds")
p.add_argument("--serial", default="127.0.0.1:5555")
a = p.parse_args()

gaps, speech = [], ""
for line in open(a.trace):
    t = json.loads(line)
    gaps += t["gaps"]
    speech += t["speech"]
gaps[0] = 0
if a.seconds:
    keep = int(np.searchsorted(np.cumsum(gaps), a.seconds * 1000))
    gaps, speech = gaps[:keep], speech[:keep]
TONE = (np.sin(np.arange(480) * 2 * np.pi * 220 / 24000) * 6000).astype(np.int16).tobytes()
SPEECH, SILENCE = TONE, bytes(960)
done = asyncio.Event()
got = {"stats": None, "trace": []}


async def app(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async def play():
        await ws.send_str(json.dumps({"event": "active"}))
        start = time.monotonic()
        due = 0.0
        for gap, s in zip(gaps, speech):
            due += gap / 1000
            wait = start + due - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            await ws.send_bytes(SPEECH if s == "1" else SILENCE)
        await asyncio.sleep(3)
        await ws.send_str(json.dumps({"event": "ended", "why": "hangup"}))

    async for msg in ws:
        if msg.type != web.WSMsgType.TEXT:
            continue
        m = json.loads(msg.data)
        if m.get("cmd") == "call":
            asyncio.create_task(play())
        elif m.get("cmd") == "stats":
            got["stats"] = m
        elif m.get("cmd") == "trace":
            got["trace"].append(m)
    done.set()
    return ws


async def main():
    runner = web.AppRunner(web.Application())
    runner.app.router.add_get("/app", app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", a.port).start()
    subprocess.run(["adb", "-s", a.serial, "shell", "am", "start", "-S", "-n", "io.github.zcag.atc/.Replay",
                    "--es", "url", f"http://{a.host}:{a.port}/app"], check=True, capture_output=True)
    await asyncio.wait_for(done.wait(), sum(gaps) / 1000 + 60)
    await asyncio.sleep(1)
    s, sent = got["stats"] or {}, len(gaps)
    heard = [g for t in got["trace"] for g in t["gaps"]][1:]
    src = sorted(gaps[1:])
    q = lambda v, f: v[min(len(v) - 1, int(len(v) * f))] if v else 0
    print(json.dumps({
        "frames": sent, "speech_frames": speech.count("1"), "seconds": round(sum(gaps) / 1000, 1),
        "source_gaps": {"p99": q(src, .99), "max": max(src or [0]), "over_250": sum(g >= 250 for g in src)},
        "replayed_gaps": {"p99": q(sorted(heard), .99), "max": max(heard or [0]), "over_250": sum(g >= 250 for g in heard)},
        "app": {k: s.get(k) for k in ("played", "underruns", "breaks", "break_ms", "dropped", "speech_dropped",
                                      "hold_ms", "hold_max_ms", "deepest_ms")},
    }))


asyncio.run(main())
