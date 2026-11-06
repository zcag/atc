#!/usr/bin/env python3
"""Turn-taking off the button, with a scripted VAD and no models: a pause shorter than end_ms sends nothing, and the
"still on it" line counts the caller's speech as the line not being quiet."""
import asyncio, os, sys, time, unittest
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_press import OFF, ON, fake, frames, talk

WINDOW_MS = 32


def ms(n):
    return n // WINDOW_MS + 1


class Commit(unittest.IsolatedAsyncioTestCase):
    def turn(self):
        t = fake()
        t.a.end_ms = 700
        return t

    async def test_a_short_pause_does_not_commit_and_speech_takes_it_back(self):
        t = self.turn()
        await frames(t, 10, ON)
        await frames(t, ms(400), OFF)
        self.assertEqual(len(t.turns_sent), 1)
        self.assertNotIn("committed", t.events)
        await frames(t, 10, ON)
        self.assertIn("turn-continued", t.events)
        self.assertNotIn("committed", t.events)

    async def test_the_wait_commits_it(self):
        t = self.turn()
        await frames(t, 10, ON)
        await frames(t, ms(700), OFF)
        self.assertIn("committed", t.events)
        self.assertFalse(t.in_speech)


class Hold(unittest.IsolatedAsyncioTestCase):
    def line(self, heard_ago):
        t = talk.Talk.__new__(talk.Talk)
        now = time.monotonic()
        t.a = NS(progress_max=1, progress_ms=400, progress_every_ms=0)
        t.tools_open, t.in_speech, t.speaking = 1, False, []
        t.last_voice, t.last_heard, t.canned_at = now - 60, now - heard_ago, 0.0
        t.lang, t.packs = "en", {"en": NS(HOLD=["still on it"])}
        t.said = []
        t.say = lambda text, _: t.said.append(text)
        t.log = lambda **_: None
        t.cache = {"still on it": b"x"}
        return t

    async def hold(self, t, seconds):
        task = asyncio.create_task(t.hold_on())
        await asyncio.sleep(seconds)
        task.cancel()

    async def test_not_right_after_the_caller_stopped(self):
        t = self.line(heard_ago=0)
        await self.hold(t, 0.25)
        self.assertEqual(t.said, [])

    async def test_once_the_line_has_been_quiet_that_long(self):
        t = self.line(heard_ago=0)
        await self.hold(t, 0.7)
        self.assertEqual(t.said, ["still on it"])

    async def test_a_caller_who_never_spoke_changes_nothing(self):
        t = self.line(heard_ago=60)
        await self.hold(t, 0.25)
        self.assertEqual(t.said, ["still on it"])


if __name__ == "__main__":
    unittest.main()
