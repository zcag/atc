"""flows.py <character dir>: measures how far each feature moves between neighbouring head angles once both are bent to
the same pose, and writes flows.png and rig.json's "flow". While two angles dissolve, rig.js warps each along this field,
so the glasses and eyes meet instead of showing twice. Run with playwright, opencv, numpy and pillow."""
import json, shutil, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from rigpage import NEUTRAL, render

char = Path(sys.argv[1])
GRID, RANGE = (64, 96), 60.
R = json.load(open(char / "rig.json"))
W, H = R["size"]
angles = R["angles"]
heads = [p["box"] for p in R["parts"] if p["name"].startswith("head.")]
x0, y0 = min(b[0] for b in heads) - 60, min(b[1] for b in heads) - 60
x1, y1 = max(b[0] + b[2] for b in heads) + 60, max(b[1] + b[3] for b in heads) + 60
box = [round(x0), round(y0), round(x1 - x0), round(y1 - y0)]
names = list(angles)
pairs = [(a, b) for i, a in enumerate(names) for b in names[i + 1:] if abs(angles[a][0] - angles[b][0]) <= 8 and abs(angles[a][1] - angles[b][1]) <= 6]
at = lambda Y, P: {**NEUTRAL, "yaw": -Y / 12, "pitch": P / 12}
seq = []
for a, b in pairs:
    mid = [(angles[a][i] + angles[b][i]) / 2 for i in (0, 1)]
    for key, start in ((a, angles[a]), (b, angles[b])):
        seq += [{"p": at(*start)}] * 30
        seq += [{"p": at(start[0] + (mid[0] - start[0]) * t / 44, start[1] + (mid[1] - start[1]) * t / 44)} for t in range(45)]
        seq += [{"p": at(*mid)}] * 29 + [{"p": at(*mid), "shot": f"{a}~{b}~{key}"}]


def heads_only(r):
    r = {**r, "view": {"zoom": 1, "focus": [.5, .5]}, "parts": [p for p in r["parts"] if p.get("angle")]}
    for k in ("room", "dust", "flow"):
        r.pop(k, None)
    return r


stage, seen = render(char, seq, (W // 2, H // 2), room=False, rewrite=heads_only)
cells, fields = {}, []
gw, gh = GRID
sx0, sy0, sw, sh = [v // 2 for v in box]
for a, b in pairs:
    if seen[f"{a}~{b}~{a}"] != a or seen[f"{a}~{b}~{b}"] != b:
        print("no direct swap", a, b)
        continue
    A, B = [cv2.imread(str(stage / f"shots/{a}~{b}~{k}.jpg"), cv2.IMREAD_UNCHANGED)[sy0:sy0 + sh, sx0:sx0 + sw] for k in (a, b)]
    ga, gb = [cv2.cvtColor(i[..., :3], cv2.COLOR_BGR2GRAY) for i in (A, B)]
    F = cv2.calcOpticalFlowFarneback(ga, gb, None, .5, 5, 41, 4, 7, 1.5, 0) * 2
    both = (A[..., 3] / 255. * B[..., 3] / 255.).astype(np.float32)
    w = cv2.GaussianBlur(both, (0, 0), 14) + 1e-3
    F = np.dstack([cv2.GaussianBlur(F[..., i] * both, (0, 0), 14) / w for i in (0, 1)])
    small = cv2.resize(F, (gw, gh), interpolation=cv2.INTER_AREA)
    cells[f"{a}|{b}"] = len(fields)
    fields.append(np.clip(small / RANGE * 127 + 128, 1, 255))
nx = int(np.ceil(len(fields) ** .5))
ny = int(np.ceil(len(fields) / nx))
sheet = np.full((ny * gh, nx * gw, 4), 128, np.uint8)
sheet[..., 3] = 255
for i, f in enumerate(fields):
    y, x = (i // nx) * gh, (i % nx) * gw
    sheet[y:y + gh, x:x + gw, :2] = f.round().astype(np.uint8)
Image.fromarray(sheet, "RGBA").save(char / "flows.png")
R["flow"] = {"tex": "flows.png", "box": box, "grid": [nx, ny], "range": RANGE, "cells": cells}
json.dump(R, open(char / "rig.json", "w"), separators=(",", ":"))
spec = json.load(open(char / "persona.json"))
spec["files"] = sorted(set(spec["files"]) | {"flows.png"})
json.dump(spec, open(char / "persona.json", "w"))
shutil.rmtree(stage)
print("flows", len(fields), "pairs, sheet", sheet.shape[:2])
