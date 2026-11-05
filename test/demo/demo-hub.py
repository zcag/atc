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

# (seconds before the first word, tool or None, what it says before the tool, what it says after, what changes in atc first)
DIALOGUE = [
    (.8, None, "", "Hey, it's your assistant. The release session needs your okay before it pushes version zero nine, and CI is green on main. Should I tell it to go ahead?", None),
    (3.4, "mcp__atc__read", "", "Not yet. It's stuck on a question for you: should a percent coupon apply before or after shipping?", "ios"),
    (1.2, "mcp__atc__send", "", "Done, it has your words. And the iOS build on the laptop just finished, so that's one less thing.", "coupon"),
    (1.0, "Bash", "", "A date library was costing almost two seconds on phones. The fix takes it from about three seconds to just over one. I put the chart on your screen.", None),
    (1.0, "mcp__atc__send", "Telling it now, with your okay.", "It's pushing. I'll ring you if CI goes red.", "release"),
    (.8, None, "", "Talk soon. [HANGUP]", None),
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
    and its transcript starts moving if it is working."""
    for home in (HOME, Path("/home/laptop")):
        f = home / f".claude/demo-move-{what}"
        if not f.exists():
            continue
        move = json.loads(f.read_text())
        state = json.loads((home / ".claude/demo-agents.json").read_text())
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
    words = m["message"]["content"]
    with open(LOG, "a") as f:
        f.write(json.dumps({"at": time.time(), "got": words}, ensure_ascii=False) + "\n")
    put(type="user", isReplay=True, session_id=sid, message=m["message"])
    if "· you called" in words:
        turn = 0
    if "[talk-mode: phone" in words or "[phone ·" in words or turn:
        if "The call has ended" in words or "[call over]" in words:
            put(type="result", subtype="success", session_id=sid)
            continue
        wait, name, before, after, move = DIALOGUE[min(turn, len(DIALOGUE) - 1)]
        turn += 1
        if move:
            change(move)
        time.sleep(wait)
        if before:
            text(before)
        if name:
            tool(name)
            time.sleep(.5)
        text(after)
    else:
        text("This is a demo, so nothing happens. On your own atc I would do it now.")
    put(type="result", subtype="success", session_id=sid)
