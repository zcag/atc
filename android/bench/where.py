#!/usr/bin/env python3
"""Where did the assistant's voice bunch up on a call: atc's relay log (what came from the call line, how long each write toward
the phone took) beside the app's arrival trace (when each frame reached the phone).
  where.py <relay.jsonl>... -- <app-trace.jsonl>
Frames are matched in order; the phone's clock is aligned to the server's by the smallest one-way delay, so `delay` is
the extra time a frame took to reach the phone over the fastest frame of the call."""
import json, sys
sep = sys.argv.index("--")
def load(paths, key):
    """Absolute ms per frame. Relay logs written before an early version truncated each gap to whole ms (about
    0.5 ms lost a frame), so a window's frames are stretched to end where the next window's first frame says."""
    out = []
    for p in paths:
        ts = [json.loads(l) for l in open(p)]
        for k, t in enumerate(ts):
            at, span = t["at"], sum(t["gaps"][1:])
            if key == "relay" and k + 1 < len(ts):
                true = ts[k + 1]["at"] - ts[k + 1]["gaps"][0] - at
                scale = true / span if span and 0 < true - span < len(t["gaps"]) else 1
            else:
                scale = 1
            extra = t.get("writes") or [0] * len(t["gaps"])
            acc = 0
            for i, (g, w) in enumerate(zip(t["gaps"], extra)):
                acc += g if i else 0
                out.append((at + acc * scale, w, t.get("speech", "1" * len(t["gaps"]))[i] if key == "app" else None))
    return out
def cmp(relay, app):
    rg, ag = gaps([r[0] for r in relay]), gaps([a[0] for a in app])
    ws = [r[1] for r in relay]
    cnt = lambda v, s: sum(x >= s for x in v)
    print(f"frames: relay {len(relay)}, app {len(app)}")
    for s in (60, 100, 250, 500):
        print(f"gaps >= {s:3} ms: from the call line into atc {cnt(rg, s):4} | arriving at the phone {cnt(ag, s):4} | atc writes blocked that long {cnt(ws, s)}")
    print(f"max gap: into atc {max(rg)} ms, at the phone {max(ag)} ms, longest atc write {max(ws)} ms")
    n = min(len(relay), len(app))
    d = [app[i][0] - relay[i][0] for i in range(n)]
    late = sorted(x - min(d) for x in d)
    print(f"extra delay server->phone (n={n}): p50 {late[n//2]} p90 {late[int(n*.9)]} p99 {late[int(n*.99)]} max {late[-1]} ms")


def gaps(ts):
    return [b - a for a, b in zip(ts, ts[1:])]


app = load(sys.argv[sep + 1:], "app")
cuts = [0] + [i + 1 for i, g in enumerate(gaps([a[0] for a in app])) if g >= 1000] + [len(app)]
segments = [app[a:b] for a, b in zip(cuts, cuts[1:])]
for path in sys.argv[1:sep]:
    relay = load([path], "relay")
    seg = min(segments, key=lambda s: abs(s[0][0] - relay[0][0]))
    print(f"== {path.rsplit('/', 1)[-1]}: relay from {relay[0][0]}, phone segment from {seg[0][0]} ({(seg[0][0] - relay[0][0])} ms apart)")
    cmp(relay, seg)
