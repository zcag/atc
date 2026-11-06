#!/usr/bin/env python3
"""Cuts callshot.js's recording into the README's film, an mp4 with sound, once film.js has drawn test/demo/beats.json's panels:
film.py <call dir> <film dir: callfilm.py's screen.mp4, events.json> <panels dir> <clips dir: 1.wav ...> <out prefix>

The assistant is the right channel of the call's call.wav (on talk.py's clock) and the phone is the device's screen during
that call. Only the panel beside the phone is drawn. The caller is the clean clips, each starting where the talker heard that
turn start (user-start in turns.jsonl), and not call.wav's left channel, which also holds any gap in what reached the talker. A
clip may differ in length from the one played on the call, as long as it fits before the reply. Each side's speech is brought
to SPEECH_DB, and ring.py's ring plays from the film's start until the answer. beats.json holds the times of one recorded call, in
seconds on the video's clock, read from callfilm.py's events.json and the call's turns.jsonl; a new recording or new clips need new times."""
import array
import json
import math
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import ring

SPEECH_DB, SILENCE_DB = -18, -45


def gain(samples, rate):
    """What brings this speech (the 50 ms windows above SILENCE_DB) to SPEECH_DB."""
    size, floor = rate // 20, 10 ** (SILENCE_DB / 10)
    powers = [sum(v * v for v in samples[i:i + size]) / size / 32768 ** 2 for i in range(0, len(samples) - size, size)]
    speech = [p for p in powers if p > floor]
    return 10 ** ((SPEECH_DB - 10 * math.log10(sum(speech) / len(speech))) / 20)


def read(wav):
    with wave.open(str(wav)) as w:
        return w.getframerate(), array.array("h", w.readframes(w.getnframes()))


def cut(call, film, panels, clips, out):
    call = Path(call)
    video = Path(film) / "screen.mp4"
    events = json.loads((Path(film) / "events.json").read_text())
    accept = next(e["at"] for e in events if e.get("line", {}).get("event") == "active")
    answered = next(json.loads(l)["t"] for l in (call / "turns.jsonl").read_text().splitlines() if json.loads(l)["event"] == "answered")
    offset = accept - answered  # video time = call time + offset
    spec = json.loads((Path(panels) / "beats.json").read_text())
    start, stop = spec[0]["t"], spec[-1]["t"] + spec[-1].get("hold", 4)
    span = stop - start
    PW, PH, X, Y = 323, 700, 56, 40
    inputs = ["-loop", "1", "-i", f"{panels}/stage.png", "-ss", str(start), "-t", str(span), "-i", str(video),
              "-ss", str(max(0, start - offset)), "-t", str(span), "-i", str(call / "call.wav")]
    inputs += ["-loop", "1", "-i", f"{panels}/frame.png"]
    graph = [f"[1:v]setpts=PTS-STARTPTS,scale={PW}:{PH}:flags=lanczos,tpad=stop_mode=clone:stop_duration=6[ph]",
             f"[0:v][ph]overlay={X}:{Y}:shortest=1[v00]", "[v00][3:v]overlay=0:0:shortest=1[v0]"]
    last = "v0"
    for i, b in enumerate(spec):
        t0, t1 = b["t"] - start, (spec[i + 1]["t"] - start) if i + 1 < len(spec) else span + 1
        inputs += ["-loop", "1", "-i", f"{panels}/{i:02d}.png"]
        graph.append(f"[{last}][{i + 4}:v]overlay=0:0:eof_action=pass:enable='between(t,{t0:.2f},{t1:.2f})'[v{i + 1}]")
        last = f"v{i + 1}"
    rate, both = read(call / "call.wav")
    assistant = gain(both[1::2], rate)
    graph += [f"[{last}]fps=25,format=yuv420p[out]", f"[2:a]pan=mono|c0={assistant:.3f}*c1,aresample=44100[it]"]
    heard = [json.loads(l)["t"] for l in (call / "turns.jsonl").read_text().splitlines() if json.loads(l)["event"] == "user-start"]
    rate, voiced = read(f"{clips}/1.wav")
    for n in range(2, len(heard) + 1):
        voiced += read(f"{clips}/{n}.wav")[1]
    caller = gain(voiced, rate)
    audio = ["[it]"]
    at = 4 + len(spec)
    for n, t in enumerate(heard, 1):
        inputs += ["-i", f"{clips}/{n}.wav"]
        graph.append(f"[{at}:a]volume={caller:.3f},aresample=44100,adelay={(t + offset - start) * 1000:.0f}:all=1[c{n}]")
        audio.append(f"[c{n}]")
        at += 1
    with tempfile.NamedTemporaryFile(suffix=".wav") as bell:
        ring.write(bell.name, next(e["at"] for e in events if "answer" in e) - start)
        inputs += ["-i", bell.name]
        audio.append(f"[{at}:a]")
        graph.append(f"{''.join(audio)}amix=inputs={len(audio)}:normalize=0:duration=longest,alimiter=limit=0.95:level=0,apad[a]")
        subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(graph), "-map", "[out]", "-map", "[a]",
                        "-c:v", "libx264", "-crf", "25", "-preset", "slow", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-t", str(span), f"{out}.mp4"], check=True)


if __name__ == "__main__":
    cut(*sys.argv[1:6])
