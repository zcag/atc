#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp"]
# ///
"""Records one call for the README's film: the real app on android14.sh's device, on the real line, with a made-up caller.

Sits between atc and the call line (run.sh with DEMO_LINE=film points atc's app line here, on <port> + 7) and passes
everything through, except that while a clip of the caller plays its frames replace the phone's microphone, which is silent
on this device. It reads the talker's persona events to know when to speak, as a person would, taps Answer on the device,
and records its screen. The assistant's words come from demo-hub.py; the hub, talk.py and the voice are real.
  callfilm.py <port> <clips dir: 1.pcm ... s16le 16 kHz> <out dir> <reason>
Leaves <out dir>/screen.mp4 and events.json, whose times are seconds on the recording's clock."""
import asyncio, json, os, subprocess, sys, time

import aiohttp
from aiohttp import web

port, clips, out, reason = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
ADB = [os.path.expanduser("~/Android/sdk/platform-tools/adb"), "-s", f"127.0.0.1:{os.environ['ADB_PORT']}"]
PKG = "io.github.zcag.atc"
HUB, LINE = f"http://127.0.0.1:{port + 1}", f"http://127.0.0.1:{port + 2}"
FRAME = 640
t0, events, waiters = time.time(), [], []
clip = bytearray()


def note(**e):
    events.append({"at": round(time.time() - t0, 3), **e})


def adb(*a):
    return subprocess.run([*ADB, *a], capture_output=True, text=True).stdout


async def app_line(request):
    down = web.WebSocketResponse(heartbeat=10)
    await down.prepare(request)
    async with aiohttp.ClientSession() as http, http.ws_connect(LINE.replace("http", "ws") + "/app") as up:
        async def from_app():
            async for m in down:
                if m.type == web.WSMsgType.BINARY:
                    if not clip:
                        await up.send_bytes(m.data)
                elif m.type == web.WSMsgType.TEXT:
                    await up.send_str(m.data)

        async def from_line():
            async for m in up:
                if m.type == aiohttp.WSMsgType.BINARY:
                    await down.send_bytes(m.data)
                else:
                    await down.send_str(m.data)
                    o = json.loads(m.data)
                    note(line=o)
                    for w in waiters[:]:
                        if w[0](o):
                            waiters.remove(w)
                            w[1].set_result(o)

        async def speak():
            while not up.closed:
                if clip:
                    await up.send_bytes(bytes(clip[:FRAME]).ljust(FRAME, b"\0"))
                    del clip[:FRAME]
                await asyncio.sleep(.02)

        done, pending = await asyncio.wait([asyncio.ensure_future(x) for x in (from_app(), from_line(), speak())], return_when=asyncio.FIRST_COMPLETED)
        [t.cancel() for t in pending]
    return down


async def status(_):
    async with aiohttp.ClientSession() as http, http.get(LINE + "/status") as r:
        return web.Response(body=await r.read(), content_type="application/json")


def until(test, secs=40):
    f = asyncio.get_running_loop().create_future()
    waiters.append((test, f))
    return asyncio.wait_for(f, secs)


def saying(word):
    return lambda o: word in (o.get("said") or "")


async def say(n):
    note(caller=n)
    data = open(f"{clips}/{n}.pcm", "rb").read()
    clip.extend(data)
    while clip:
        await asyncio.sleep(.02)
    note(caller_done=n)


async def spoke():
    """Until the reply is over: the talker goes back to thinking (its turn still closing) or listening."""
    await until(lambda o: o.get("state") in ("listening", "thinking"), 30)


async def direct():
    global t0
    rec = subprocess.Popen([*ADB, "shell", "screenrecord", "--bit-rate", "8000000", "--time-limit", "170", "/sdcard/call.mp4"])
    t0 = time.time()
    await asyncio.sleep(2.5)
    async with aiohttp.ClientSession() as http:
        ask = asyncio.ensure_future(http.post(HUB + "/call", json={"reason": reason, "via": "app", "from": '[from session "Checkout errors after the deploy" (@ops on devbox) · report back when done]'}, timeout=aiohttp.ClientTimeout(total=200)))
        await asyncio.sleep(.6)
        note(ring=True)
        cmd = "am broadcast -f 32 -n %s/.Fake --es push '%s'" % (PKG, json.dumps({"ring": {"reason": reason, "at": int(time.time())}}))
        open("/tmp/atc-ring-cmd.sh", "w").write(cmd + "\n")
        adb("push", "/tmp/atc-ring-cmd.sh", "/data/local/tmp/ring.sh")
        adb("shell", "sh", "/data/local/tmp/ring.sh")
        await asyncio.sleep(5)
        note(answer=True)
        adb("shell", "input", "tap", "722", "412")
        await until(lambda o: o.get("event") == "active", 15)
        note(active=True)

        await until(saying("jumped"), 25)
        await asyncio.sleep(float(os.environ.get("CUT_AFTER", "5.0")))
        await say(1)
        await until(saying("copy fix"), 25)
        await spoke()
        await asyncio.sleep(.7)
        await say(2)
        await until(saying("one less thing"), 30)
        await spoke()
        await asyncio.sleep(.6)
        await say(3)
        await until(saying("on your screen"), 30)
        await asyncio.sleep(1.6)
        note(open_page=True)
        cmd = "am broadcast -f 32 -n %s/.Fake --es push '%s'" % (PKG, json.dumps({"title": "assistant", "body": "Showing you the chart", "tag": "chart", "url": "/#/p/@ops/checkout-errors", "open": True}))
        open("/tmp/atc-ring-cmd.sh", "w").write(cmd + "\n")
        adb("push", "/tmp/atc-ring-cmd.sh", "/data/local/tmp/ring.sh")
        adb("shell", "sh", "/data/local/tmp/ring.sh")
        await asyncio.sleep(4.5)
        await say(4)
        await until(saying("Talk soon"), 25)
        await asyncio.sleep(3.5)
        note(end=True)
        ask.cancel()
    adb("shell", "pkill", "-INT", "screenrecord")
    await asyncio.sleep(1.5)
    rec.wait()
    adb("pull", "/sdcard/call.mp4", f"{out}/screen.mp4")
    json.dump(events, open(f"{out}/events.json", "w"), ensure_ascii=False, indent=0)
    os._exit(0)


async def main():
    os.makedirs(out, exist_ok=True)
    app = web.Application()
    app.router.add_get("/app", app_line)
    app.router.add_get("/status", status)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port + 7).start()
    if len(sys.argv) > 5 and sys.argv[5] == "go":
        await direct()
    else:
        await asyncio.Event().wait()


asyncio.run(main())
