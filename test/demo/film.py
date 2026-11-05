#!/usr/bin/env python3
"""Cuts callshot.js's recording into the README's film, once film.js has drawn test/demo/beats.json's panels:
film.py <call dir> <film dir: callfilm.py's screen.mp4, events.json> <panels dir> <out prefix>

The audio is the call's call.wav (left the caller, right the assistant, on talk.py's clock) and the phone is the device's
screen during that call. Only the panel beside the phone is drawn. beats.json holds the times of one recorded call, in
seconds on the video's clock, read from callfilm.py's events.json and the call's turns.jsonl; a new recording needs new times."""
import json
import subprocess
import sys
from pathlib import Path


def cut(call, film, panels, out):
    call = Path(call)
    video = Path(film) / "screen.mp4"
    accept = next(e["at"] for e in json.loads((Path(film) / "events.json").read_text()) if e.get("line", {}).get("event") == "active")
    answered = next(json.loads(l)["t"] for l in (call / "turns.jsonl").read_text().splitlines() if json.loads(l)["event"] == "answered")
    offset = accept - answered  # video time = call time + offset
    spec = json.loads((Path(panels) / "beats.json").read_text())
    start, stop = spec[0]["t"], spec[-1]["t"] + spec[-1].get("hold", 4)
    span = stop - start
    PW, PH, X, Y = 323, 700, 56, 40
    inputs = ["-loop", "1", "-i", f"{panels}/stage.png", "-ss", str(start), "-t", str(span), "-i", str(video),
              "-ss", str(max(0, start - offset)), "-t", str(span), "-i", str(call / "call.wav")]
    inputs += ["-loop", "1", "-i", f"{panels}/frame.png"]
    graph = [f"[1:v]scale={PW}:{PH}:flags=lanczos,tpad=stop_mode=clone:stop_duration=6[ph]",
             f"[0:v][ph]overlay={X}:{Y}:shortest=1[v00]", "[v00][3:v]overlay=0:0:shortest=1[v0]"]
    last = "v0"
    for i, b in enumerate(spec):
        t0, t1 = b["t"] - start, (spec[i + 1]["t"] - start) if i + 1 < len(spec) else span + 1
        inputs += ["-loop", "1", "-i", f"{panels}/{i:02d}.png"]
        graph.append(f"[{last}][{i + 4}:v]overlay=0:0:eof_action=pass:enable='between(t,{t0:.2f},{t1:.2f})'[v{i + 1}]")
        last = f"v{i + 1}"
    graph += [f"[{last}]fps=25,format=yuv420p[out]", "[2:a]pan=mono|c0=0.8*c0+0.8*c1,aresample=44100,apad[a]"]
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(graph), "-map", "[out]", "-map", "[a]",
                    "-c:v", "libx264", "-crf", "25", "-preset", "slow", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-t", str(span), f"{out}.mp4"], check=True)


if __name__ == "__main__":
    cut(*sys.argv[1:5])
