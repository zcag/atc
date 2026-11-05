#!/usr/bin/env python3
"""Turn-taking with the talk button (Talk.press), with a scripted VAD and no models: holding, a pause does not end a turn,
letting go ends it at once, and off the button nothing changes."""
import asyncio, os, sys, types, unittest
from types import SimpleNamespace as NS

VOICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VOICE)
for name in ("aiohttp", "soxr", "numpy", "onnxruntime"):
    sys.modules.setdefault(name, types.ModuleType(name))
import talk

FRAME = bytes(talk.FRAME)
ON, OFF = 0.9, 0.1


class Script:
    def __init__(self):
        self.next = OFF

    def feed(self, _):
        return [self.next]

    def reset_fresh(self):
        pass


def fake():
    t = talk.Talk.__new__(talk.Talk)
    t.a = NS(vad_on=.5, vad_off=.35, min_speech=96, reopen_ms=1000, barge=300, barge_words=3, barge_max=2.0,
             spec_ms=250, end_ms=1500, preroll=.3, vad_reset_ms=0, turn_threshold=.5)
    t.vad, t.stt, t.turn = Script(), None, None
    t.utt, t.preroll, t.voiced_ms = bytearray(), b"", 0
    t.in_speech, t.speech_ms, t.silence_ms, t.barge_ms = False, 0, 0, 0
    t.commit, t.pending, t.live, t.reply = asyncio.Event(), False, False, None
    t.paused, t.paused_at, t.reopening, t.reopened = False, 0.0, False, False
    t.may_speak = asyncio.Event()
    t.opening = t.discard = t.holding = t.pressed = t.released = False
    t.speaking, t.unfinished, t.line_up = [], None, False
    t.events, t.turns_sent = [], []
    t.log = lambda **kw: t.events.append(kw["event"])
    t.place = t.tick = lambda *_: None
    t.interrupt = lambda: t.events.append("cut")

    async def respond(utt, ended, text, voiced):
        t.turns_sent.append(len(utt))
        await t.commit.wait()
        t.events.append("committed")
    t.respond = respond
    return t


async def frames(t, n, prob):
    t.vad.next = prob
    for _ in range(n):
        await t.on_audio(FRAME)
    await asyncio.sleep(0)


class Press(unittest.IsolatedAsyncioTestCase):
    async def test_a_pause_while_held_does_not_end_the_turn(self):
        t = fake()
        await t.press(True)
        await frames(t, 10, ON)
        await frames(t, 200, OFF)
        self.assertEqual(t.turns_sent, [])
        self.assertTrue(t.in_speech)
        await frames(t, 10, ON)
        self.assertEqual(t.turns_sent, [])

    async def test_letting_go_ends_the_turn_at_once(self):
        t = fake()
        await t.press(True)
        await frames(t, 10, ON)
        await t.press(False)
        await asyncio.sleep(0)
        self.assertEqual(len(t.turns_sent), 1)
        self.assertIn("committed", t.events)
        self.assertFalse(t.in_speech)
        self.assertFalse(t.released)

    async def test_one_voiced_window_is_enough_when_held(self):
        t = fake()
        await t.press(True)
        await frames(t, 1, ON)
        self.assertTrue(t.in_speech)
        await t.press(False)
        await asyncio.sleep(0)
        self.assertEqual(len(t.turns_sent), 1)

    async def test_a_press_with_no_speech_sends_nothing(self):
        t = fake()
        await t.press(True)
        await frames(t, 20, OFF)
        await t.press(False)
        await frames(t, 100, OFF)
        self.assertEqual(t.turns_sent, [])

    async def test_pressing_stops_delta(self):
        t = fake()
        t.live, t.speaking = True, [["sentence", 5, 0, b""]]
        await t.press(True)
        self.assertIn("cut", t.events)

    async def test_speech_while_held_stops_a_reply_that_started_meanwhile(self):
        t = fake()
        await t.press(True)
        t.live, t.speaking = True, [["sentence", 5, 0, b""]]
        await frames(t, 1, ON)
        self.assertIn("cut", t.events)
        self.assertFalse(t.paused)

    async def test_off_the_button_silence_still_ends_a_turn(self):
        t = fake()
        await frames(t, 10, ON)
        await frames(t, 7, OFF)
        self.assertEqual(t.turns_sent, [], "spec_ms not reached")
        await frames(t, 5, OFF)
        self.assertEqual(len(t.turns_sent), 1)
        self.assertNotIn("committed", t.events)
        await frames(t, 50, OFF)
        self.assertIn("committed", t.events)

    async def test_a_lost_release_is_covered_by_the_next_one(self):
        t = fake()
        await t.press(True)
        await frames(t, 5, ON)
        await t.press(True)
        await t.press(False)
        await asyncio.sleep(0)
        self.assertEqual(len(t.turns_sent), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
