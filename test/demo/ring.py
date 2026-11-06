#!/usr/bin/env python3
"""The film's phone ring, synthesized: two soft sine notes a fourth apart, falling, each with a slow decay. ring.py <out.wav> <seconds>"""
import array
import math
import sys
import wave

RATE, PEAK, PERIOD, FADE = 44100, .08, 1.5, .15
NOTES = (0, 587.33), (.34, 440.0)
ATTACK, DECAY = .012, .38


def ring(seconds):
    """Samples of the pattern, starting on a note and fading out at the end."""
    n = int(seconds * RATE)
    out = [0.0] * n
    start = 0.0
    while start < seconds:
        for at, hz in NOTES:
            first = int((start + at) * RATE)
            for i in range(first, min(n, first + int(4 * DECAY * RATE))):
                t = (i - first) / RATE
                out[i] += min(t / ATTACK, 1) * math.exp(-t / DECAY) * (math.sin(2 * math.pi * hz * t) + .12 * math.sin(4 * math.pi * hz * t))
        start += PERIOD
    return array.array("h", (int(32767 * PEAK * v * min(1, (n - i) / (FADE * RATE))) for i, v in enumerate(out)))


def write(path, seconds):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(RATE)
        w.writeframes(ring(seconds).tobytes())


if __name__ == "__main__":
    write(sys.argv[1], float(sys.argv[2]))
