#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp"]
# ///
"""The call line as a WebSocket, for whatever holds the conversation: atc's phone app, and optionally a phone on USB.

device/CallBridge runs on the phone as the adb shell user and does the telephony: call state
with the caller's number, answer, hang up, dial, and call audio both ways through Android's
call-assistant redirection (no root). This side keeps it running, and gives clients one
WebSocket at ws://127.0.0.1:8807/call carrying JSON events and commands as text frames and the
call audio as binary frames (s16le, 16 kHz, mono). README.md is the contract.
DELTA_CALL_BRIDGE=0 runs without a phone: the app line only.
"""
import asyncio, hashlib, html, json, os, re, time
from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
DEX, REMOTE_DEX = os.path.join(HERE, "device", "callbridge.dex"), "/data/local/tmp/callbridge.dex"
CONTROL_PORT, AUDIO_PORT = 18807, 18808
PORT = int(os.environ.get("DELTA_CALL_PORT", "8807"))
DIAL_ALLOW = [re.sub(r"\D", "", n)[-10:] for n in os.environ.get("DELTA_CALL_DIAL_ALLOW", "").split(",") if n.strip()]
APP_NUMBER = os.environ.get("DELTA_CALL_APP_NUMBER", "atc")
APP_GRACE = float(os.environ.get("DELTA_CALL_APP_GRACE", "8"))
BRIDGE = os.environ.get("DELTA_CALL_BRIDGE", "1") != "0"
STATE = os.path.expanduser(os.environ.get("TALK_STATE") or "~/.local/state/atc/voice")
LOG = f"{STATE}/calls.jsonl"
TRACES = f"{STATE}/app-traces"
CONFIG = os.environ.get("ATC_CONFIG_DIR") or (os.environ["XDG_CONFIG_HOME"] + "/atc" if os.environ.get("XDG_CONFIG_HOME") else "~/.config/atc")
GUESTS = os.path.expanduser(f"{CONFIG}/guests")

status = {"bridge": "starting", "call": "idle", "precise": "idle", "number": None, "audio": False}
app_status = {"call": "idle", "precise": "idle", "number": None, "audio": False}
clients: dict[web.WebSocketResponse, str | None] = {}
control: asyncio.StreamWriter | None = None
audio: dict = {}
call: dict = {}
app_call: dict = {}
dropped = {"n": 0}


async def adb(*args):
    p = await asyncio.create_subprocess_exec("adb", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    return (await p.communicate())[0].decode()


def guest_number(name, digits):
    """Whether atc's guest list (`name number` per line) gives this guest this number."""
    try:
        lines = open(GUESTS).read().splitlines()
    except OSError:
        return False
    return any(len(p) >= 2 and " ".join(p[:-1]) == name and re.sub(r"\D", "", p[-1])[-10:] == digits[-10:]
               for p in (line.split("#")[0].split() for line in lines))


async def broadcast(msg, line):
    """To the talkers of this line ("app" or "device", the SIM and WhatsApp on delta) and to clients of every line."""
    for ws, of in list(clients.items()):
        if of not in (None, line):
            continue
        try:
            await (ws.send_bytes(msg) if isinstance(msg, bytes) else ws.send_str(json.dumps(msg)))
        except ConnectionError:
            clients.pop(ws, None)


def listening(line):
    return any(of in (None, line) for of in clients.values())


def record(event, call):
    if event.get("number") and call:
        call["number"] = event["number"]
    if event.get("event") == "state":
        if event["call"] == "ringing" and not call:
            call.update(start=time.time(), direction="in", answered=False, number=event.get("number"), via=event.get("via", "phone"))
        elif event["call"] == "idle" and call:
            call["end"] = time.time()
            os.makedirs(os.path.dirname(LOG), exist_ok=True)
            with open(LOG, "a") as f:
                f.write(json.dumps(call) + "\n")
            call.clear()
    elif event.get("precise") == "active" and call:
        call["answered"] = True


NODE = re.compile(r'<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
WA_END = ("570", "1312")
wa: dict = {}
wa_ui = asyncio.Lock()


async def wa_nodes():
    """WhatsApp's screen as (text, description, x, y, top) per node, from a uiautomator dump (~3 s)."""
    xml = await adb("exec-out", "uiautomator", "dump", "/dev/tty")
    return [(re.sub(r"[‎‏‪-‮⁦-⁩]", "", html.unescape(t)), html.unescape(d), (int(a) + int(c)) // 2, (int(b) + int(e)) // 2, int(b))
            for t, d, a, b, c, e in NODE.findall(xml)]


def wa_find(nodes, pattern):
    return next((n for n in nodes if re.search(pattern, n[0] or n[1], re.I)), None)


async def wa_connected():
    """The latest Telecom call is WhatsApp's and has gone active (answered, either direction) without ending."""
    log = await adb("shell", "dumpsys telecom | grep -E ' - (CREATED|SET_ACTIVE|SET_DISCONNECTED) '")
    events = [line.split(" - ", 1)[1] for line in log.splitlines() if " - " in line]
    last = max((i for i, e in enumerate(events) if e.startswith("CREATED")), default=None)
    if last is None or not events[last].startswith("CREATED (com.whatsapp"):
        return False
    later = [e.split(" ", 1)[0] for e in events[last + 1:]]
    return "SET_ACTIVE" in later and "SET_DISCONNECTED" not in later


async def wa_caller():
    """The ringing WhatsApp call's caller, from its notification (shown whether the screen is on or off):
    (is a WhatsApp ring, number). The title is the number itself or the name of a contact saved on delta."""
    block = await adb("shell", "dumpsys notification --noredact | grep -A60 -m1 'pkg=com.whatsapp.*channel=voip_notification'")
    title = re.search(r"android\.title=String \((.*)\)", block)
    if "Incoming voice call" not in block or not title:
        return False, None
    name = re.sub(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]", "", title[1]).strip()
    if re.fullmatch(r"\+?[\d ()-]{10,}", name):
        return True, name
    if not re.fullmatch(r"[\w .-]+", name):
        return True, None
    rows = await adb("shell", f"content query --uri content://com.android.contacts/data --projection data1 "
                              f"--where \"display_name='{name}' AND mimetype='vnd.android.cursor.item/phone_v2'\"")
    number = re.search(r"data1=([+\d ()-]+)", rows)
    return True, number and number[1].strip()


async def wa_event(name, **changes):
    status.update(changes)
    event = {"event": name, "via": "whatsapp", **status}
    record(event, call)
    print("event:", json.dumps(event), flush=True)
    await broadcast(event, "device")


async def wa_active():
    wa["phase"] = "active"
    await wa_event("precise", call="offhook", precise="active")
    if listening("device") and not audio:
        asyncio.create_task(pump())


async def wa_end():
    wa.clear()
    if audio.get("w"):
        audio["w"].close()
    await wa_event("state", call="idle", precise="idle", number=None)


async def watch_whatsapp():
    """Promotes a ringing or dialed WhatsApp call to active once Telecom has it active; Telecom reports the end."""
    while True:
        await asyncio.sleep(0.5)
        if wa.get("phase") not in ("ringing", "dialing"):
            continue
        try:
            async with wa_ui:
                if await wa_connected() and wa.get("phase") in ("ringing", "dialing"):
                    await wa_active()
        except Exception as e:
            print("whatsapp:", repr(e), flush=True)


async def wa_ring(event):
    """A ring without a number is a WhatsApp call (a self-managed call in Telecom, number hidden) or a
    hidden-number phone call; WhatsApp's call notification tells which."""
    async with wa_ui:
        for _ in range(5):
            is_wa, number = await wa_caller()
            if is_wa:
                wa["phase"] = "ringing"
                await wa_event("state", call="ringing", precise="incoming", number=number)
                return
            await asyncio.sleep(0.4)
    status.update(call="ringing", number=None)
    record(event, call)
    await broadcast(event, "device")


app: dict = {}


async def app_send(msg):
    ws = app.get("ws")
    if ws is not None and not ws.closed:
        try:
            await (ws.send_bytes(msg) if isinstance(msg, bytes) else ws.send_str(json.dumps(msg)))
        except ConnectionError:
            pass


async def app_event(name, **changes):
    app_status.update(changes)
    event = {"event": name, "via": "app", "out_rate": app.get("out_rate", 16000), "bridge": status["bridge"], **app_status}
    record(event, app_call)
    print("event:", json.dumps(event), flush=True)
    await broadcast(event, "app")


async def app_active():
    app["phase"] = "active"
    await app_send({"event": "active"})
    await app_event("precise", call="offhook", precise="active", audio=True)


async def app_end(why):
    """A call still being dialed was never announced to the clients (the app had not rung yet), so it ends quietly."""
    phase = app.pop("phase", None)
    if not phase:
        return
    app.pop("out_rate", None)
    await app_send({"event": "ended", "why": why})
    app["ws"] = None
    if phase == "dialing":
        app_status.update(call="idle", precise="idle", number=None, audio=False)
        record({"event": "state", "call": "idle"}, app_call)
    else:
        await app_event("state", call="idle", precise="idle", number=None, audio=False)


async def app_command(msg):
    """Commands from the talker for a call on atc's app line. A dial stays quiet until the app reports that
    it rings: the hub falls back to the phone line when it never does, and the talker must not have started
    an opening for a call that never reached them."""
    cmd = msg["cmd"]
    if cmd == "dial":
        app["phase"] = "dialing"
        app_status.update(call="offhook", precise="dialing", number=msg["number"], audio=False)
    elif cmd == "answer" and app.get("phase") == "ringing":
        await app_active()
    elif cmd == "hangup":
        await app_end("hangup")
    return {"event": "sent", "cmd": cmd, "via": "app"}


async def ws_app(request):
    """atc's phone app, through atc's /api/call/line: one call at a time, their voice as binary frames
    (s16le, 16 kHz, mono) and these commands: call (they call), ringing (a call to them reached the phone),
    accept, resume (after a reconnect), hangup, interrupt (they tapped: the talker stops), and stats (its playback
    counters, kept in the call's log line). The talker's {"cmd": "persona", ...} reach it as {"event": "persona", ...}.
    call and ringing may say out_rate 24000: the talker then speaks at that rate (Higgs' own) instead of 16 kHz.
    It hears active, ended (with why) and the talker's audio.
    A call belongs to the connection that placed or took it. Another one (a second phone, an emulator) cannot
    take it over: its call is busy, its ringing and resume are told the call is gone, and its other commands and
    audio are ignored. Only a resume after the owner's connection has dropped carries the call on."""
    if request.remote not in ("127.0.0.1", "::1"):
        raise web.HTTPForbidden(text="the app line is only reachable through atc")
    ws = web.WebSocketResponse(heartbeat=10)
    await ws.prepare(request)

    async def reply(msg):
        try:
            await ws.send_str(json.dumps(msg))
        except ConnectionError:
            pass

    def owner():
        return app.get("ws") is ws

    def free():
        o = app.get("ws")
        return o is None or o.closed

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.BINARY:
                if owner() and app.get("phase") == "active":
                    await broadcast(msg.data, "app")
                continue
            if msg.type != web.WSMsgType.TEXT:
                continue
            m = json.loads(msg.data)
            cmd, phase = m.get("cmd"), app.get("phase")
            if cmd == "stats":
                if owner() and app_call:
                    app_call["app"] = {k: v for k, v in m.items() if k != "cmd"}
                continue
            if cmd == "trace":
                if owner() and app_call:
                    keep_trace(m)
                continue
            print("app:", cmd, f"({phase or 'idle'})", "" if owner() else "(not the call's connection)", flush=True)
            if cmd == "call":
                if app_status["call"] != "idle" or phase:
                    await reply({"event": "ended", "why": "busy"})
                elif not listening("app"):
                    await reply({"event": "ended", "why": "nobody"})
                else:
                    app["ws"], app["phase"] = ws, "ringing"
                    if m.get("out_rate") in (16000, 24000):
                        app["out_rate"] = m["out_rate"]
                    app_call.clear()
                    await app_event("state", call="ringing", precise="incoming", number=APP_NUMBER, audio=False)
            elif cmd == "ringing":
                if phase == "dialing" and free():
                    app["ws"], app["phase"] = ws, "alerting"
                    if m.get("out_rate") in (16000, 24000):
                        app["out_rate"] = m["out_rate"]
                    await app_event("precise", precise="alerting")
                elif not (owner() and phase == "alerting"):
                    await reply({"event": "ended", "why": "gone"})
            elif cmd == "resume":
                if phase == "active" and (owner() or free()):
                    app["ws"] = ws
                    await reply({"event": "active"})
                else:
                    await reply({"event": "ended", "why": "gone"})
            elif not owner():
                continue
            elif cmd == "accept" and phase in ("dialing", "alerting"):
                await app_active()
            elif cmd == "interrupt":
                if phase == "active":
                    await broadcast({"event": "interrupt", "via": "app"}, "app")
            elif cmd in ("hold", "unhold"):
                if phase == "active":
                    await broadcast({"event": "hold", "on": cmd == "hold", "via": "app"}, "app")
            elif cmd == "hangup":
                await app_end("hangup")
    finally:
        if owner():
            app["ws"] = None
            if app.get("phase") in ("ringing", "alerting", "active"):
                asyncio.create_task(app_lost())
    return ws


def keep_trace(m):
    """The app's arrival trace (each of delta's frames: ms since the one before, speech or silence), per call, so
    a call's playback can be lined up with atc's relay log and replayed on redroid (atc android/bench/replay.py)."""
    os.makedirs(TRACES, exist_ok=True)
    name = time.strftime("%Y%m%d-%H%M%S", time.localtime(app_call.get("start", time.time())))
    with open(os.path.join(TRACES, name + ".jsonl"), "a") as f:
        f.write(json.dumps({k: v for k, v in m.items() if k != "cmd"}) + "\n")


async def app_lost():
    """A dropped connection (the phone switched networks) gets a few seconds to come back with resume."""
    await asyncio.sleep(APP_GRACE)
    if app.get("ws") is None:
        await app_end("lost")


async def bridge_send(msg):
    control.write((json.dumps(msg) + "\n").encode())
    await control.drain()


async def wa_command(msg):
    """answer goes through Telecom; hangup and dial drive WhatsApp's screen (Telecom's endCall leaves
    WhatsApp's own call running)."""
    async with wa_ui:
        if msg["cmd"] == "answer":
            await bridge_send(msg)
        elif msg["cmd"] == "hangup":
            await adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
            top = await adb("shell", "dumpsys activity activities | grep -m1 topResumedActivity")
            if wa.get("phase") != "ringing" and "com.whatsapp/" in top and "Voip" in top:
                await adb("shell", "input", "tap", *WA_END)
                await asyncio.sleep(1.5)
                if not await wa_connected():
                    return {"event": "sent", "cmd": "hangup", "via": "whatsapp"}
            await bridge_send(msg)
        elif msg["cmd"] == "dial":
            await adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
            await adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-p", "com.whatsapp", "-d", "https://wa.me/" + re.sub(r"\D", "", msg["number"]))
            await asyncio.sleep(2.5)
            n = wa_find(await wa_nodes(), r"^(voice|audio) call$")
            if not n:
                return {"event": "error", "error": "whatsapp: no voice call button in the chat"}
            await adb("shell", "input", "tap", str(n[2]), str(n[3]))
            await asyncio.sleep(1.5)
            if confirm := wa_find(await wa_nodes(), r"^call$"):
                await adb("shell", "input", "tap", str(confirm[2]), str(confirm[3]))
            wa["phase"] = "dialing"
            await wa_event("state", call="offhook", precise="dialing", number=msg["number"])
        else:
            return {"event": "error", "error": f"whatsapp: {msg['cmd']} is not supported"}
    return {"event": "sent", "cmd": msg["cmd"], "via": "whatsapp"}


async def run_bridge():
    while True:
        await adb("wait-for-device")
        with open(DEX, "rb") as f:
            local = hashlib.md5(f.read()).hexdigest()
        if local not in await adb("shell", "md5sum", REMOTE_DEX):
            await adb("push", DEX, REMOTE_DEX)
        await adb("shell", "pkill", "-f", "CallBridge")
        await adb("forward", f"tcp:{CONTROL_PORT}", "localabstract:delta-call")
        await adb("forward", f"tcp:{AUDIO_PORT}", "localabstract:delta-call-audio")
        proc = await asyncio.create_subprocess_exec(
            "adb", "shell", f"CLASSPATH={REMOTE_DEX} app_process / CallBridge 2>&1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        reader = None
        async for line in proc.stdout:
            print("bridge:", line.decode().rstrip(), flush=True)
            if b"ready" in line and not reader:
                reader = asyncio.create_task(read_control())
        status["bridge"] = "down"
        if reader:
            reader.cancel()
        await broadcast({"event": "bridge", **status}, "device")
        await asyncio.sleep(3)


other: dict = {}


def tail(number):
    return re.sub(r"\D", "", number or "")[-10:]


def elsewhere(event):
    """A second call ringing (call waiting) during a phone call on delta: kept out of status and from the device line's
    talker, which would otherwise answer it (acceptRingingCall would take the waiting call and hold the one on) or end
    the call on its idle; it rings out unanswered and is logged as such. A WhatsApp call is not covered here: its events
    are rewritten to its own state. The app line is apart and never sees any of it."""
    if wa.get("phase") or status["call"] != "offhook":
        return False
    kind, number = event.get("event"), event.get("number")
    if kind == "number" and number and tail(number) != tail(status["number"]):
        other.setdefault("start", time.time())
        other["number"] = number
        return True
    if kind == "state" and event.get("call") == "ringing":
        other.setdefault("start", time.time())
        other.setdefault("number", number)
        return True
    if kind == "state" and other and event.get("call") in ("offhook", "idle"):
        missed = {"start": other["start"], "direction": "in", "answered": False, "number": other.get("number"),
                  "via": "phone" if other.get("number") else "whatsapp or hidden", "busy": "phone", "end": time.time()}
        other.clear()
        print("event (another call, not answered):", json.dumps(missed), flush=True)
        with open(LOG, "a") as f:
            f.write(json.dumps(missed) + "\n")
        return event.get("call") == "offhook"
    return False


async def read_control():
    global control
    r, control = await asyncio.open_connection("127.0.0.1", CONTROL_PORT)
    status["bridge"] = "up"
    await broadcast({"event": "bridge", **status}, "device")
    async for line in r:
        event = json.loads(line)
        if elsewhere(event):
            print("event (another call):", json.dumps(event), flush=True)
            continue
        if wa.get("phase"):
            if event.get("event") == "state" and event.get("call") == "idle":
                await wa_end()
                continue
            event.update(via="whatsapp", **{k: status[k] for k in ("call", "precise", "number")})
        elif event.get("event") == "state" and event.get("call") == "ringing" and not event.get("number"):
            asyncio.create_task(wa_ring(event))
            continue
        status.update(number=event.get("number"), **{k: event[k] for k in ("call", "precise", "audio") if k in event})
        record(event, call)
        print("event:", json.dumps(event), flush=True)
        await broadcast(event, "device")
        if event.get("precise") == "active" and listening("device") and not audio:
            asyncio.create_task(pump())


async def pump():
    audio["w"] = None
    r, w = await asyncio.open_connection("127.0.0.1", AUDIO_PORT)
    audio["w"] = w
    print("audio: stream open", flush=True)
    try:
        while chunk := await r.read(640):
            await broadcast(chunk, "device")
    finally:
        print("audio: stream closed", flush=True)
        audio.clear()
        w.close()


async def command(msg, line=None):
    """A talker's command, for its own line; a client of every line (or HTTP) is routed as before the split: by via,
    then to whichever line has a call."""
    on_app = line == "app" or line is None and (msg.get("via") == "app" or app.get("phase") and msg.get("cmd") in ("answer", "hangup", "mute", "persona", "flush"))
    if msg.get("cmd") in ("persona", "flush"):
        if app.get("phase") == "active" and on_app:
            await app_send({"event": msg["cmd"], **{k: v for k, v in msg.items() if k != "cmd"}})
        return None
    if msg.get("cmd") == "folder":
        (app_call if on_app else call)["talk"] = msg.get("id")
        return None
    if msg.get("cmd") == "dial":
        digits = re.sub(r"\D", "", str(msg.get("number", "")))
        if (app_status["call"] != "idle" or app.get("phase")) if msg.get("via") == "app" else (status["call"] != "idle" or wa.get("phase")):
            return {"event": "error", "error": "line busy"}
        guest = msg.get("guest") and guest_number(msg["guest"], digits) and msg["guest"]
        if not digits or digits[-10:] not in DIAL_ALLOW and not guest:
            return {"event": "error", "error": f"dial refused: {msg.get('number')} is in neither DELTA_CALL_DIAL_ALLOW nor atc's guest list under {msg.get('guest')!r}"}
        rec = app_call if msg.get("via") == "app" else call
        rec.clear()
        rec.update(start=time.time(), direction="out", answered=False, number=msg["number"], via=msg.get("via", "phone"),
                   **({"guest": guest} if guest else {}))
        await broadcast({"event": "dialing", "via": msg.get("via", "phone"), "number": msg["number"], "guest": guest or None,
                         "reason": msg.get("reason", "")}, "app" if msg.get("via") == "app" else "device")
    if on_app or msg.get("via") == "app":
        return await app_command(msg)
    if msg.get("via") == "whatsapp" or (wa.get("phase") and msg.get("cmd") in ("answer", "hangup")):
        return await wa_command(msg)
    if control is None:
        return {"event": "error", "error": "bridge not connected"}
    control.write((json.dumps(msg) + "\n").encode())
    await control.drain()
    return {"event": "sent", "cmd": msg.get("cmd")}


def hello(line):
    app_line = {"via": "app", "out_rate": app.get("out_rate", 16000), "bridge": status["bridge"], **app_status}
    if line == "app" or line is None and app.get("phase"):
        return {"event": "hello", **app_line}
    return {"event": "hello", **({"via": "whatsapp"} if wa.get("phase") else {}), **status}


async def ws_call(request):
    """A talker: ?line=app or ?line=device gets only that line's events, status and audio, and its commands go to that
    line, so one talker per line can hold a call each at the same time. With no line it gets everything (one talker
    for both, as before)."""
    line = request.query.get("line") if request.query.get("line") in ("app", "device") else None
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    clients[ws] = line
    await ws.send_str(json.dumps(hello(line)))
    if line != "app" and status["precise"] == "active" and not audio and not (line is None and app.get("phase")):
        asyncio.create_task(pump())
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.BINARY:
                if line == "app" or line is None and app.get("phase") == "active":
                    if app.get("phase") == "active":
                        await app_send(msg.data)
                elif audio.get("w"):
                    audio["w"].write(msg.data)
                else:
                    dropped["n"] += 1
                    if dropped["n"] % 50 == 1:
                        print(f"audio: uplink dropped, no stream ({dropped['n']} frames so far)", flush=True)
            elif msg.type == web.WSMsgType.TEXT:
                if (r := await command(json.loads(msg.data), line)) is not None:
                    await ws.send_str(json.dumps(r))
    finally:
        clients.pop(ws, None)
    return ws


async def http_command(request):
    body = await request.json() if request.can_read_body else {}
    return web.json_response(await command({"cmd": request.match_info["cmd"], **body}))


async def http_status(_):
    """Top level: the device line, or the app line's call while it has one ("call" is idle only when both are), as
    before the split; "lines" has each one."""
    top = {**status, **(app_status if app_status["call"] != "idle" else {})}
    if status["call"] != "idle":
        top["call"] = status["call"]
    return web.json_response({**top, "clients": len(clients), "talkers": {l: list(clients.values()).count(l) for l in ("app", "device", None)},
                              "app": app.get("phase") or ("connected" if app.get("ws") is not None else None),
                              "lines": {"app": {**app_status, "phase": app.get("phase")}, "device": {**status, "whatsapp": wa.get("phase")}}})


async def start(server):
    if BRIDGE:
        server["bridge"] = asyncio.create_task(run_bridge())
        server["whatsapp"] = asyncio.create_task(watch_whatsapp())


server = web.Application()
server.router.add_get("/call", ws_call)
server.router.add_get("/app", ws_app)
server.router.add_get("/status", http_status)
server.router.add_post("/{cmd:answer|hangup|dial|mute}", http_command)
server.on_startup.append(start)

if __name__ == "__main__":
    web.run_app(server, port=PORT, print=None, shutdown_timeout=1)
