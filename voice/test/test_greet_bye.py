#!/usr/bin/env python3
"""--back-min: a call soon after the last one gets the short greetings in turn, guests and late calls the full one.
--bye-wait-ms: after delta's goodbye it waits for theirs, and words that are more than a goodbye keep the call."""
import asyncio, json, os, sys, tempfile, time, unittest
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_press import talk
from langpack import Pack


def caller(out, ended_ago=None, guest=None, back_min=15):
    if ended_ago is not None:
        with open(os.path.join(out, "last-call.json"), "w") as f:
            json.dump({"end": time.time() - ended_ago}, f)
    t = talk.Talk.__new__(talk.Talk)
    t.a, t.guest, t.first = NS(back_min=back_min, out=out), guest, Pack("tr", "delta", "Ada")
    return t


class BackGreeting(unittest.TestCase):
    def test_soon_after_gets_the_short_ones_in_turn(self):
        out = tempfile.mkdtemp()
        got = [caller(out, 60).back_greeting() for _ in range(7)]
        lines = Pack("tr", "delta", "Ada").GREETING_BACK
        self.assertEqual(got, lines + lines[:1])
        self.assertIn("Efendim Ada.", got)

    def test_later_or_first_gets_a_casual_one(self):
        him = Pack("tr", "delta", "Ada").GREETING_HIM
        self.assertEqual(caller(tempfile.mkdtemp(), 20 * 60).back_greeting(), him[0])
        self.assertEqual(caller(tempfile.mkdtemp()).back_greeting(), him[0])
        self.assertEqual(him[0], "Selam Ada.")

    def test_guests_and_off_get_the_full_one(self):
        out = tempfile.mkdtemp()
        talk.GUESTS = os.path.join(out, "guests")
        self.assertIsNone(caller(out, 60, guest="pat").back_greeting())
        self.assertIsNone(caller(out, 60, back_min=0).back_greeting())

    def test_a_guest_with_a_name_is_greeted_by_it(self):
        out = tempfile.mkdtemp()
        talk.GUESTS = os.path.join(out, "guests")
        with open(talk.GUESTS, "w") as f:
            f.write("# atc's WhatsApp guests\npat 12025550121 Pat Lee\nsam 12025550122\n")
        self.assertEqual(talk.guest_of("+1 202 555 0121"), "pat")
        self.assertEqual(talk.guest_of("12025550122"), "sam")
        self.assertEqual(caller(out, guest="pat").back_greeting(), "Alo, merhaba Pat Lee, ben delta.")
        self.assertIsNone(caller(out, guest="sam").back_greeting())


def leaving(wait_ms):
    t = talk.Talk.__new__(talk.Talk)
    t.a, t.packs, t.lang = NS(bye_wait_ms=wait_ms, barge_words=3), {"tr": Pack("tr")}, "tr"
    t.in_speech, t.last_heard, t.bye_waiting = False, 0.0, False
    return t


class ByeWait(unittest.IsolatedAsyncioTestCase):
    async def test_hangs_up_after_the_wait_when_they_say_nothing(self):
        t, start = leaving(300), time.monotonic()
        await t.bye_wait()
        self.assertAlmostEqual(time.monotonic() - start, 0.3, delta=0.1)
        self.assertFalse(t.bye_waiting)

    async def test_waits_for_their_goodbye_to_end(self):
        t, start = leaving(300), time.monotonic()

        async def they_say_bye():
            await asyncio.sleep(0.1)
            t.in_speech, t.last_heard = True, time.monotonic()
            await asyncio.sleep(0.6)
            t.in_speech, t.last_heard = False, time.monotonic()
        asyncio.create_task(they_say_bye())
        await t.bye_wait()
        self.assertAlmostEqual(time.monotonic() - start, 1.2, delta=0.15)

    async def test_off_is_the_old_half_second(self):
        t, start = leaving(0), time.monotonic()
        await t.bye_wait()
        self.assertAlmostEqual(time.monotonic() - start, 0.5, delta=0.1)

    def test_a_goodbye_is_not_more(self):
        t = leaving(2500)
        for heard in ("görüşürüz", "tamam görüşürüz kolay gelsin", "sağ ol teşekkürler hadi iyi akşamlar", "tamam kapatabilirsin"):
            self.assertFalse(t.more_than_bye(heard), heard)
        self.assertTrue(t.more_than_bye("bi de şunu sormak istiyordum"))


if __name__ == "__main__":
    unittest.main()
