"""The hub's Claude in the demo: speaks stream-json just enough for the hub to hold a conversation."""
import json
import sys
import time

args = sys.argv
sid = next((args[i + 1] for i, a in enumerate(args) if a in ("--resume", "--session-id")), "demo")


def put(**e):
    print(json.dumps(e), flush=True)


put(type="system", subtype="init", session_id=sid)
for raw in sys.stdin:
    m = json.loads(raw)
    put(type="user", isReplay=True, session_id=sid, message=m["message"])
    for ev in ({"type": "content_block_start", "content_block": {"type": "text"}},
               {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "This is a demo, so nothing happens. On your own atc I would do it now."}},
               {"type": "content_block_stop"}):
        put(type="stream_event", event=ev, session_id=sid)
        time.sleep(.1)
    put(type="result", subtype="success", session_id=sid)
