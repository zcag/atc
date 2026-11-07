#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp", "numpy", "soxr"]
# ///
"""The line's rate changing while delta's voice is queued or still streaming (an opening made while it rang at 16 kHz,
answered on a device that takes 24 kHz): what goes out keeps its pitch and its length."""
import asyncio, os, sys, types, unittest
from types import SimpleNamespace as NS

import numpy as np

VOICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VOICE)
sys.modules.setdefault("onnxruntime", types.ModuleType("onnxruntime"))
import talk

HZ = 440


def tone(rate, seconds):
    t = np.arange(int(rate * seconds)) / rate
    return (np.sin(2 * np.pi * HZ * t) * 8000).astype(np.int16).tobytes()


def make():
    t = talk.Talk.__new__(talk.Talk)
    t.a = NS(out_gain_db=0)
    t.rate, t.down, t.converting, t.cache, t.greeting = 16000, None, {}, {}, b""
    t.outbox, t.speaking, t.spoken, t.first_audio = asyncio.Queue(), [], [], {}
    t.log = lambda **kw: None

    async def prerender():
        pass
    t.prerender = prerender
    return t


def sent(t):
    frames = []
    while not t.outbox.empty():
        item, frame = t.outbox.get_nowait()
        assert len(frame) == t.frame, len(frame)
        frames.append(frame)
        item[1] -= 1
    return np.frombuffer(b"".join(frames), np.int16)


def pitch(pcm, rate):
    spectrum = np.abs(np.fft.rfft(pcm * np.hanning(len(pcm))))
    return np.argmax(spectrum) * rate / len(pcm)


class Rate(unittest.IsolatedAsyncioTestCase):
    async def test_queued_voice_is_resampled(self):
        t = make()
        item = ["hello", 0, False, b""]
        t.speaking.append(item)
        t.queue(item, tone(16000, 1), last=True)
        t.set_rate(24000)
        out = sent(t)
        self.assertAlmostEqual(len(out) / 24000, 1, delta=.03)
        self.assertAlmostEqual(pitch(out, 24000), HZ, delta=3)
        self.assertEqual(item[1], 0)

    async def test_a_voice_still_streaming_is_converted(self):
        t = make()
        item = ["hello", 0, False, b""]
        t.speaking.append(item)
        pcm = tone(16000, 1)
        half = len(pcm) // 2 + 1
        t.queue(item, pcm[:half], rate=16000)
        t.set_rate(24000)
        t.queue(item, pcm[half:], last=True, rate=16000)
        out = sent(t)
        self.assertAlmostEqual(len(out) / 24000, 1, delta=.03)
        self.assertAlmostEqual(pitch(out, 24000), HZ, delta=3)
        self.assertFalse(t.converting)

    async def test_same_rate_is_untouched(self):
        t = make()
        item = ["hello", 0, False, b""]
        pcm = tone(24000, .1)
        t.rate = 24000
        t.queue(item, pcm, last=True, rate=24000)
        self.assertEqual(sent(t).tobytes(), pcm)


if __name__ == "__main__":
    unittest.main()
