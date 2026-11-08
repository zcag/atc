#!/usr/bin/env python3
"""--back-min: a call soon after the last one gets the short greetings in turn, guests and late calls the full one.
--bye-wait-ms: after delta's goodbye it waits for theirs, and words that are more than a goodbye keep the call.
A call delta makes: when none of the opening is ready by release, a short «Alo?» answers them at once."""
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



class CalloutHello(unittest.IsolatedAsyncioTestCase):
    def callout(self, ready):
        t = talk.Talk.__new__(talk.Talk)
        t.a, t.lang, t.packs = NS(hold_ms=60, hold_max_ms=200), "tr", {"tr": Pack("tr", "delta", "Ada")}
        t.holding, t.opening, t.in_speech, t.discard, t.canned_at = True, True, False, False, 0.0
        t.speaking = [["Selam Ada, ben delta.", 0, False, b""]] if ready else []
        t.cache, t.said, t.events = {"Alo?": b"x"}, [], []
        t.say = lambda text, _: t.said.append(text)
        t.log = lambda **kw: t.events.append(kw)
        return t

    async def test_an_opening_not_ready_gets_alo_at_once(self):
        t = self.callout(ready=False)
        await t.release()
        self.assertEqual(t.said, ["Alo?"])
        self.assertEqual(t.events[-1]["hello"], "Alo?")

    async def test_a_ready_opening_plays_alone(self):
        t = self.callout(ready=True)
        await t.release()
        self.assertEqual(t.said, [])

    async def test_nothing_rendered_means_nothing_said(self):
        t = self.callout(ready=False)
        t.cache = {}
        await t.release()
        self.assertEqual(t.said, [])



class LocalOpening(unittest.IsolatedAsyncioTestCase):
    """A call to the user opens with the picker's line, voiced while it rings; anything short of that is the
    assistant's opening, as before."""

    def callout(self, line, pcm=b"x", up=True):
        t = talk.Talk.__new__(talk.Talk)
        t.lang, t.packs, t.first = "tr", {"tr": Pack("tr", "delta", "Ada")}, None
        t.history, t.said, t.events, t.asked, t.opened = [], [], [], [], None
        t.say = lambda text, _: t.said.append(text)
        t.log = lambda **kw: t.events.append(kw)

        async def check(_):
            return up

        async def opening(_, reason):
            if isinstance(line, Exception):
                raise line
            return line
        t.picker = NS(check=check, opening=opening)

        async def tts(_):
            if isinstance(pcm, Exception):
                raise pcm
            yield pcm
        t.tts = tts

        async def respond(utt, ended, text):
            t.asked.append(text)
        t.respond = respond
        return t

    async def test_a_voiced_line_opens_and_the_assistant_hears_it_with_his_reply(self):
        t = self.callout("Selam Ada, ben delta. Test için aradım.")
        await t.open_locally("test", "[OUTBOUND]")
        self.assertEqual((t.said, t.asked, t.opened), (["Selam Ada, ben delta. Test için aradım."], [], "Selam Ada, ben delta. Test için aradım."))
        self.assertIn("«Selam Ada, ben delta. Test için aradım.» dedin", talk.fill(t.pack.OPENED, said=t.opened, text="Alo"))

    async def test_anything_short_of_a_voiced_line_is_the_assistants_opening(self):
        for t in (self.callout(talk.FALLBACK), self.callout("Selam Ada.", pcm=b""), self.callout("Selam Ada.", up=False),
                  self.callout("Selam Ada.", pcm=RuntimeError("tts down"))):
            await t.open_locally("test", "[OUTBOUND]")
            self.assertEqual((t.said, t.asked, t.opened), ([], ["[OUTBOUND]"], None))


if __name__ == "__main__":
    unittest.main()
