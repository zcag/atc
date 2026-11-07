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


class LongReading(unittest.IsolatedAsyncioTestCase):
    def line(self, reading):
        t = talk.Talk.__new__(talk.Talk)
        t.lang = "en"
        t.packs = {"en": talk.Pack("en")}
        t.events = []
        t.log = lambda **kw: t.events.append(kw)

        async def whisper(utt, lang, prompt="", timeout=None):
            if isinstance(reading, Exception):
                raise reading
            return reading
        t.whisper = whisper
        return t

    async def note(self, reading, text="we can skip these"):
        t = self.line(reading)
        return await t.long_reading(b"x", text, 3000), t.events[0]

    async def test_a_different_reading_is_a_note_beside_the_words(self):
        note, event = await self.note("we can keep these")
        self.assertIn("we can keep these", note)
        self.assertNotIn("skip", note)
        self.assertTrue(event["used"])

    async def test_the_same_words_are_no_note_whatever_the_punctuation(self):
        note, event = await self.note("We can skip, these.")
        self.assertEqual(note, "")
        self.assertFalse(event["used"])

    async def test_junk_is_no_note(self):
        note, event = await self.note("Thanks for watching")
        self.assertEqual(note, "")
        self.assertTrue(event["junk"])

    async def test_more_words_than_the_speech_could_hold_is_no_note(self):
        note, event = await self.note(" ".join(["word"] * 40))
        self.assertEqual(note, "")
        self.assertTrue(event["junk"])

    async def test_a_late_or_failed_reading_is_no_note(self):
        note, event = await self.note(TimeoutError())
        self.assertEqual(note, "")
        self.assertIn("error", event)

    def test_another_alphabet_is_junk_in_turkish(self):
        pack = talk.Pack("tr")
        self.assertTrue(pack.WHISPER_JUNK.search("Jók, listeðar, tíkar það"))
        self.assertFalse(pack.WHISPER_JUNK.search("Yok, listeden çıkartabiliriz, şöyle değil mi?"))


if __name__ == "__main__":
    unittest.main()
