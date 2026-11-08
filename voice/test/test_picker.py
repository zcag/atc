#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp"]
# ///
"""The picker against a fake llama.cpp server: a good answer picks from the right kind, and a server that is down,
slow, broken or answering nonsense only ever gives FALLBACK (the old rules), never an error and never a wait past
its deadline; two misses turn it off for the call. Wording rotates within a kind and keeps its habits."""
import asyncio, json, math, os, random, sys, tempfile, time, unittest

import aiohttp
from aiohttp import web

VOICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VOICE)
from langpack import Pack
from picker import FALLBACK, Picker, Wording, bank_lines


class Server:
    """mode: ok (answers with self.answer), slow, error (500), junk (not JSON), down (not started)."""

    def __init__(self):
        self.mode, self.answer, self.second, self.text, self.asked = "ok", "A", "B", "Maillerine bakıyorum.", []

    async def chat(self, req):
        body = await req.json()
        self.asked.append(body)
        if self.mode == "slow":
            await asyncio.sleep(3)
        if self.mode == "error":
            return web.Response(status=500)
        if self.mode == "junk":
            return web.Response(text="<html>", content_type="text/html")
        if "grammar" in body:
            out = {"choices": [{"message": {"content": self.answer}, "logprobs": {"content": [
                {"top_logprobs": [{"token": self.answer, "logprob": math.log(0.9)}, {"token": self.second, "logprob": math.log(0.1)}]}]}}]}
        else:
            out = {"choices": [{"message": {"content": self.text}}]}
        return web.json_response(out)

    async def health(self, req):
        return web.json_response({"status": "ok"})

    async def start(self):
        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.chat)
        app.router.add_get("/health", self.health)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        return f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


class Rig(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.srv, self.dir = Server(), tempfile.mkdtemp()
        self.url = await self.srv.start()
        self.http = aiohttp.ClientSession()
        self.logged = []
        self.pack = Pack("tr")
        self.picker = Picker(self.url, self.http, lambda **kw: self.logged.append(kw),
                             Wording(os.path.join(self.dir, "said.json"), random.Random(1)), ("delta", "Ali"),
                             deadline_ms=300, greet_ms=300, tool_ms=300)

    async def asyncTearDown(self):
        await self.http.close()
        await self.srv.runner.cleanup()


class Picks(Rig):
    async def test_a_kind_gives_one_of_its_wordings(self):
        line = await self.picker.filler(self.pack, "", "Maillerime bakar mısın?", lambda t: True)
        self.assertIn(line, [t for t, _ in self.pack.PICK_FILLERS[0][1]])

    async def test_none_is_silence(self):
        self.srv.answer = "F"
        self.assertIsNone(await self.picker.filler(self.pack, "", "Evet", lambda t: True))

    async def test_a_kind_with_nothing_rendered_falls_back(self):
        self.assertIs(await self.picker.filler(self.pack, "", "Bakar mısın?", lambda t: False), FALLBACK)

    async def test_slow_is_a_miss_within_the_deadline(self):
        self.srv.mode = "slow"
        t0 = time.monotonic()
        self.assertIs(await self.picker.filler(self.pack, "", "Bakar mısın?", lambda t: True), FALLBACK)
        self.assertLess(time.monotonic() - t0, 0.6)

    async def test_two_misses_turn_it_off_for_the_call(self):
        self.srv.mode = "error"
        for _ in range(2):
            self.assertIs(await self.picker.filler(self.pack, "", "Bakar mısın?", lambda t: True), FALLBACK)
        self.assertTrue(self.picker.off)
        self.srv.mode, n = "ok", len(self.srv.asked)
        self.assertIs(await self.picker.greeting(self.pack, "Time: 09:00", lambda t: True), FALLBACK)
        self.assertEqual(len(self.srv.asked), n, "asked the server while off")

    async def test_a_good_answer_resets_the_misses(self):
        self.srv.mode = "error"
        await self.picker.filler(self.pack, "", "Bakar mısın?", lambda t: True)
        self.srv.mode = "ok"
        await self.picker.filler(self.pack, "", "Bakar mısın?", lambda t: True)
        self.srv.mode = "error"
        await self.picker.filler(self.pack, "", "Bakar mısın?", lambda t: True)
        self.assertFalse(self.picker.off)

    async def test_junk_and_a_letter_out_of_range_fall_back(self):
        self.srv.mode = "junk"
        self.assertIs(await self.picker.filler(self.pack, "", "Bakar mısın?", lambda t: True), FALLBACK)
        self.srv.mode, self.srv.answer, self.srv.second = "ok", "Z", "Y"
        self.assertIs(await self.picker.greeting(self.pack, "Time: 09:00", lambda t: True), FALLBACK)

    async def test_down_is_off_at_the_start_of_the_call(self):
        dead = Picker("http://127.0.0.1:9", self.http, lambda **kw: None, Wording(os.path.join(self.dir, "x.json")), ("d", "c"))
        t0 = time.monotonic()
        self.assertFalse(await dead.check())
        self.assertLess(time.monotonic() - t0, 0.5)
        self.assertIs(await dead.filler(self.pack, "", "Bakar mısın?", lambda t: True), FALLBACK)

    async def test_a_bug_inside_is_a_fallback_not_an_error(self):
        broken = Pack("tr")
        broken.PICK_FILLERS = None
        self.assertIs(await self.picker.filler(broken, "", "Bakar mısın?", lambda t: True), FALLBACK)


class ToolLines(Rig):
    async def test_a_written_line_passes(self):
        line = await self.picker.tool_line(self.pack, "Bash", '{"description": "Inbox status"}', "Maillerime bak", [])
        self.assertEqual(line, "Maillerine bakıyorum.")

    async def test_housekeeping_tools_get_no_line_and_no_request(self):
        self.assertIsNone(await self.picker.tool_line(self.pack, "ToolSearch", "{}", "", []))
        self.assertEqual(self.srv.asked, [])

    async def test_atc_reads_get_a_line(self):
        self.assertEqual(await self.picker.tool_line(self.pack, "mcp__atc__state", '{"agent": "@tracker"}', "Tracker'da ne var", []),
                         "Maillerine bakıyorum.")

    async def test_none_is_no_line(self):
        self.srv.text = "NONE"
        self.assertIsNone(await self.picker.tool_line(self.pack, "ToolSearch2", "{}", "", []))

    async def test_rejected_lines_fall_back(self):
        for bad in ("cd ~/proj/atc && make", "Session 86f96cd1'e bakıyorum.", "Shopping ajanına yazıyorum.",
                    "Bu çok uzun bir cümle ve hiç bitmiyor gibi duruyor", ""):
            self.srv.text = bad
            self.assertIs(await self.picker.tool_line(self.pack, "Bash", "{}", "", []), FALLBACK, bad)
            self.picker.misses = 0

    async def test_simdi_is_dropped_not_the_line(self):
        for said, want in (("Takipçiye bakıyorum şimdi.", "Takipçiye bakıyorum."), ("Şimdi maillerine bakıyorum.", "Maillerine bakıyorum.")):
            self.srv.text = said
            self.assertEqual(await self.picker.tool_line(self.pack, "Bash", "{}", "", []), want)

    async def test_a_repeat_falls_back(self):
        self.assertIs(await self.picker.tool_line(self.pack, "Bash", "{}", "", ["Maillerine bakıyorum."]), FALLBACK)


class Holds(unittest.TestCase):
    def test_kind_follows_the_tool_and_the_second_sounds_like_a_second(self):
        pack, w = Pack("tr"), Wording(os.path.join(tempfile.mkdtemp(), "s.json"))
        p = Picker("http://x", None, lambda **kw: None, w, ("d", "c"))
        self.assertIn(p.hold(pack, "mcp__atc__send", 0, lambda t: True), [t for t, _ in pack.PICK_HOLDS["session"]])
        self.assertIn(p.hold(pack, "WebSearch", 0, lambda t: True), [t for t, _ in pack.PICK_HOLDS["web"]])
        self.assertIn(p.hold(pack, "Bash", 1, lambda t: True), [t for t, _ in pack.PICK_HOLDS["again"]])
        self.assertIs(p.hold(pack, "Bash", 0, lambda t: False), FALLBACK)


class Wordings(unittest.TestCase):
    def test_never_twice_running_and_habits_lead(self):
        path = os.path.join(tempfile.mkdtemp(), "s.json")
        w = Wording(path, random.Random(4))
        variants = [["a", 2], ["b", 1], ["c", 1], ["d", 1]]
        picks = [w.pick(variants) for _ in range(3000)]
        for i in range(len(picks) - 1):
            self.assertNotEqual(picks[i], picks[i + 1])
        self.assertGreater(picks.count("a"), 1.25 * sum(picks.count(k) for k in "bcd") / 3)
        self.assertEqual(Wording(path).said, picks[-60:], "kept across calls")

    def test_a_single_variant_still_plays(self):
        w = Wording(os.path.join(tempfile.mkdtemp(), "s.json"))
        self.assertEqual([w.pick([["x", 1]]) for _ in range(3)], ["x", "x", "x"])

    def test_every_bank_line_is_plain_speech(self):
        for code in ("tr", "en"):
            pack = Pack(code)
            for line in bank_lines(pack):
                self.assertNotIn("{", line, f"{code}: unfilled slot in {line!r}")
            self.assertEqual(set(pack.PICK_HOLDS), {"session", "web", "any", "again"})


if __name__ == "__main__":
    unittest.main()
