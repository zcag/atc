#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp"]
# ///
"""A call to the user on the app line, rung on the phone and in a browser at once: the first to answer has it, the
others are told it was answered elsewhere, a decline on either ends it, and a browser counts as the call reaching the
user (so the hub stops waiting to fall back to the SIM line) only when they used that page moments ago."""
import asyncio, json, os, sys, tempfile, unittest

VOICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VOICE)
os.environ.update(DELTA_CALL_BRIDGE="0", DELTA_CALL_DIAL_ALLOW="5550100", DELTA_CALL_APP_GRACE=".1", TALK_STATE=tempfile.mkdtemp())
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import call


def line():
    app = web.Application()
    for route in call.server.router.routes():
        app.router.add_route(route.method, route.resource.canonical, route.handler)
    return app


class Ring(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        call.app.clear(), call.also.clear(), call.app_call.clear()
        call.app_status.update(call="idle", precise="idle", number=None, audio=False)
        self.c = TestClient(TestServer(line()))
        await self.c.start_server()
        await self.c.post("/dial", json={"number": "5550100", "via": "app"})

    async def asyncTearDown(self):
        await self.c.close()

    async def device(self, hello, **more):
        ws = await self.c.ws_connect("/app")
        await ws.send_json({"cmd": hello, "out_rate": 24000, **more})
        await asyncio.sleep(.05)
        return ws

    async def precise(self):
        return (await (await self.c.get("/status")).json())["lines"]["app"]["precise"]

    async def heard(self, ws):
        return json.loads((await ws.receive(timeout=1)).data)

    async def test_browser_answers_the_phones_ring(self):
        phone, web = await self.device("ringing"), await self.device("ring-here")
        self.assertEqual(await self.precise(), "alerting")
        await web.send_json({"cmd": "accept"})
        self.assertEqual(await self.heard(web), {"event": "active"})
        self.assertEqual(await self.heard(phone), {"event": "ended", "why": call.ELSEWHERE})
        self.assertEqual(await self.precise(), "active")
        self.assertEqual(call.app["out_rate"], 24000)

    async def test_phone_answers_and_the_browser_stops(self):
        phone, web = await self.device("ringing"), await self.device("ring-here")
        await phone.send_json({"cmd": "accept"})
        self.assertEqual(await self.heard(phone), {"event": "active"})
        self.assertEqual(await self.heard(web), {"event": "ended", "why": call.ELSEWHERE})

    async def test_browser_declines_for_both(self):
        phone, web = await self.device("ringing"), await self.device("ring-here")
        await web.send_json({"cmd": "hangup"})
        self.assertEqual(await self.heard(phone), {"event": "ended", "why": "hangup"})
        self.assertEqual(await self.precise(), "idle")

    async def test_browser_alone_is_not_the_phone_ringing(self):
        web = await self.device("ring-here")
        self.assertEqual(await self.precise(), "dialing")
        await self.c.post("/hangup", json={})
        self.assertEqual(await self.heard(web), {"event": "ended", "why": "hangup"})

    async def test_a_browser_in_use_is_reaching_the_user(self):
        await self.device("ring-here", here=True)
        self.assertEqual(await self.precise(), "alerting")

    async def test_the_phone_still_rings_after_a_browser_in_use(self):
        web = await self.device("ring-here", here=True)
        phone = await self.device("ringing")
        await phone.send_json({"cmd": "accept"})
        self.assertEqual(await self.heard(phone), {"event": "active"})
        self.assertEqual(await self.heard(web), {"event": "ended", "why": call.ELSEWHERE})

    async def test_the_last_browser_leaving_ends_a_call_only_it_rang(self):
        web = await self.device("ring-here", here=True)
        await web.close()
        await asyncio.sleep(.3)
        self.assertEqual(await self.precise(), "idle")

    async def test_browser_alone_can_answer(self):
        web = await self.device("ring-here")
        await web.send_json({"cmd": "accept"})
        self.assertEqual(await self.heard(web), {"event": "active"})

    async def test_closing_the_tab_leaves_the_phone_ringing(self):
        phone, web = await self.device("ringing"), await self.device("ring-here")
        await web.close()
        await asyncio.sleep(.05)
        self.assertEqual(await self.precise(), "alerting")
        self.assertFalse(call.also)

    async def test_too_late_to_ring(self):
        await self.c.post("/hangup", json={})
        web = await self.device("ring-here")
        self.assertEqual(await self.heard(web), {"event": "ended", "why": "gone"})


if __name__ == "__main__":
    unittest.main()
