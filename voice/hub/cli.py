#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp"]
# ///
"""Test client for hub.py: cli.py <channel> "message" [--interrupt-after S] [--note]

Prints the streamed reply, then time to first text delta and total."""
import argparse, asyncio, json, sys, time
import aiohttp


async def main(a):
    async with aiohttp.ClientSession() as http, http.ws_connect(f"{a.url}?channel={a.channel}") as ws:
        t0, first = time.time(), None
        await ws.send_json({"type": "note" if a.note else "message", "text": a.text})
        if a.interrupt_after:
            async def cut():
                await asyncio.sleep(a.interrupt_after)
                print(f"\n[interrupt at {time.time() - t0:.2f}s]", file=sys.stderr)
                await ws.send_json({"type": "interrupt"})
            asyncio.create_task(cut())
        async for msg in ws:
            m = json.loads(msg.data)
            if m["type"] == "text":
                first = first or time.time()
                print(m["delta"], end="", flush=True)
            elif m["type"] == "done":
                ttft = f"{first - t0:.2f}s" if first else "none"
                print(f"\n[done {m} first_text={ttft} total={time.time() - t0:.2f}s]", file=sys.stderr)
                return
            else:
                print(f"\n[{m['type']}: {m.get('name') or m.get('error') or m.get('text') or ''} at {time.time() - t0:.2f}s]",
                      file=sys.stderr)
                if m["type"] == "error":
                    return


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("channel")
    p.add_argument("text")
    p.add_argument("--url", default="ws://127.0.0.1:8820/ws")
    p.add_argument("--interrupt-after", type=float)
    p.add_argument("--note", action="store_true")
    asyncio.run(main(p.parse_args()))
