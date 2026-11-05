"""The hub's Claude in the demo: speaks stream-json just enough for the hub to hold a conversation.

On a call the words come from a written script, turn by turn, since no real Claude runs here: DIALOGUE below is what a
Claude under modes/phone.md might say. Everything around the words is the real pipeline. What the hub really handed it (the
talk-mode, the reason for the call, what was heard before a cut-in, what changed in atc) goes to ~/.claude/demo-brain.log."""
import json
import os
import sys
import time
from pathlib import Path

args = sys.argv
sid = next((args[i + 1] for i, a in enumerate(args) if a in ("--resume", "--session-id")), "demo")
HOME = Path(os.environ["HOME"])
LOG = HOME / ".claude/demo-brain.log"

# (seconds before the first word, tools, what it says before them, what it says after, what changes in atc first)
DIALOGUE = [
    (.8, [], "", "Hey, sorry to call. Checkout errors jumped to eight percent right after the last deploy, and the coupon change looks like the cause. Do you want me to roll it back, or look at it first?", []),
    (3.4, ["mcp__atc__read"], "", "That and a copy fix. The errors all come from the coupon code.", ["ios"]),
    (1.2, ["mcp__atc__send", "mcp__atc__start"], "", "Rolling back now, and I've started a session on the cause. The iOS build on the laptop just finished too, so that's one less thing.", ["ops", "cause"]),
    (1.0, ["Bash"], "", "About forty, in eleven minutes. I put the chart on your screen.", []),
    (.8, [], "", "I will. Talk soon. [HANGUP]", []),
]


def put(**e):
    print(json.dumps(e), flush=True)


def block(*events, step=.03):
    for ev in events:
        put(type="stream_event", event=ev, session_id=sid)
        time.sleep(step)


def text(s):
    block({"type": "content_block_start", "content_block": {"type": "text"}})
    for w in s.split(" "):
        block({"type": "content_block_delta", "delta": {"type": "text_delta", "text": w + " "}})
    block({"type": "content_block_stop"})


def tool(name):
    block({"type": "content_block_start", "content_block": {"type": "tool_use", "name": name}}, {"type": "content_block_stop"})
    time.sleep(1.1)
    put(type="user", session_id=sid, parent_tool_use_id="", message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]})


def change(what):
    """A session moves while the assistant talks, as it would on its own: the fake `claude agents` reports its new state,
    a session it started appears, and the transcript of one that is working starts moving."""
    for home in (HOME, Path("/home/laptop")):
        f = home / f".claude/demo-move-{what}"
        if not f.exists():
            continue
        move = json.loads(f.read_text())
        state = json.loads((home / ".claude/demo-agents.json").read_text())
        if "agent" in move:
            state.append(move["agent"])
            os.rename(move["path"] + ".pending", move["path"])
        for a in state:
            if a["sessionId"] == move["sid"]:
                a["state"], a["status"] = ("idle", "idle") if what == "ios" else ("working", "busy")
                (home / ".claude/jobs" / a["id"] / "state.json").unlink(missing_ok=True)
        (home / ".claude/demo-agents.json").write_text(json.dumps(state))
        if what != "ios":
            tick = home / ".claude/demo-tick.json"
            tick.write_text(json.dumps(json.loads(tick.read_text()) + [move["path"]]))


put(type="system", subtype="init", session_id=sid)
turn = 0
for raw in sys.stdin:
    m = json.loads(raw)
    if "message" not in m:
        continue
    words = m["message"]["content"]
    with open(LOG, "a") as f:
        f.write(json.dumps({"at": time.time(), "got": words}, ensure_ascii=False) + "\n")
    put(type="user", isReplay=True, session_id=sid, message=m["message"])
    if "· you called" in words:
        turn = 0
    if "(next: slow)" in words:  # charshot.js: the next call turn is the slow one, so a character is seen thinking
        turn = 1
        put(type="result", subtype="success", session_id=sid)
        continue
    if "my last message was only half" in words:
        turn = max(0, turn - 1)
    if "[talk-mode: phone" in words or "[phone ·" in words or turn:
        if "The call has ended" in words or "[call over]" in words:
            put(type="result", subtype="success", session_id=sid)
            continue
        wait, names, before, after, moves = DIALOGUE[min(turn, len(DIALOGUE) - 1)]
        turn += 1
        for move in moves:
            change(move)
        time.sleep(wait)
        if before:
            text(before)
        for name in names:
            tool(name)
        if names:
            time.sleep(.5)
        text(after)
    else:
        text("This is a demo, so nothing happens. On your own atc I would do it now.")
    put(type="result", subtype="success", session_id=sid)
