"""flows.py <character dir>: measures how far each feature moves between neighbouring head angles once both are bent to
the same pose, and writes flows.png and rig.json's "flow". While two angles dissolve, rig.js warps each along this field,
so the glasses and eyes meet instead of showing twice. It draws both angles through web/rig.js itself, so bending is
included. Run with playwright, opencv, numpy and pillow."""
import json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

here = Path(__file__).resolve().parent
web = here.parents[2] / "web"
char = Path(sys.argv[1])
PORT, GRID, RANGE = 8933, (64, 96), 60.
R = json.load(open(char / "rig.json"))
W, H = R["size"]
angles = R["angles"]
heads = [p["box"] for p in R["parts"] if p["name"].startswith("head.")]
x0, y0 = min(b[0] for b in heads) - 60, min(b[1] for b in heads) - 60
x1, y1 = max(b[0] + b[2] for b in heads) + 60, max(b[1] + b[3] for b in heads) + 60
box = [round(x0), round(y0), round(x1 - x0), round(y1 - y0)]
N = dict(roll=0, sway=0, lean=0, breath=.5, gazeX=0, gazeY=0, blinkR=0, blinkL=0, brow=0, knit=0, smile=0, jaw=0, round=0, wide=0, serious=0, pose=None)
names = list(angles)
pairs = [(a, b) for i, a in enumerate(names) for b in names[i + 1:] if abs(angles[a][0] - angles[b][0]) <= 8 and abs(angles[a][1] - angles[b][1]) <= 6]
at = lambda Y, P: {**N, "yaw": -Y / 12, "pitch": P / 12}
seq = []
for a, b in pairs:
    mid = [(angles[a][i] + angles[b][i]) / 2 for i in (0, 1)]
    for key, start in ((a, angles[a]), (b, angles[b])):
        seq += [{"p": at(*start)}] * 30
        seq += [{"p": at(start[0] + (mid[0] - start[0]) * t / 44, start[1] + (mid[1] - start[1]) * t / 44)} for t in range(45)]
        seq += [{"p": at(*mid)}] * 29 + [{"p": at(*mid), "shot": f"{a}~{b}~{key}"}]

stage = Path(tempfile.mkdtemp(prefix="flows"))
shutil.copy(web / "rig.js", stage)
shutil.copy(web / "motion.js", stage)
shutil.copytree(char, stage / "p")
staged = {**R, "view": {"zoom": 1, "focus": [.5, .5]}, "parts": [p for p in R["parts"] if p.get("angle")]}
staged.pop("room", None); staged.pop("dust", None); staged.pop("flow", None)
json.dump(staged, open(stage / "p/rig.json", "w"))
json.dump(seq, open(stage / "seq.json", "w"))
(stage / "flows.html").write_text("""<!doctype html><canvas id="c" width="%d" height="%d"></canvas><script type="module">
import { rig } from "./rig.js";
const seq = await (await fetch("seq.json")).json();
let i = 0, seen = {};
const frame = await rig(document.getElementById("c"), "./p/", () => ({ state: "listening" }), { dt: 1 / 60, params: () => seq[i].p, tick: (p, d) => { if (seq[i].shot) seen[seq[i].shot] = d.angle.cur; } });
for (; i < seq.length; i++) {
  frame(i * 1000 / 60);
  if (!seq[i].shot) continue;
  const blob = await new Promise((r) => document.getElementById("c").toBlob(r, "image/png"));
  await fetch("/f/" + seq[i].shot, { method: "POST", body: blob });
}
await fetch("/f/states", { method: "POST", body: JSON.stringify(seen) });
document.title = "done";
</script>""" % (W // 2, H // 2))
srv = subprocess.Popen(["python3", str(here.parent / "serve.py"), str(stage), str(stage / "shots"), str(PORT)])
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("CHROME_BIN", "/usr/bin/chromium"), headless=True, args=["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 800, "height": 1400})
        pg.on("pageerror", lambda e: print("pageerror", e, flush=True))
        pg.goto(f"http://127.0.0.1:{PORT}/flows.html")
        t = time.time()
        while pg.title() != "done" and time.time() - t < 900:
            time.sleep(1)
        assert pg.title() == "done", "the page did not finish"
        b.close()
finally:
    srv.kill()

seen = json.load(open(stage / "shots/states"))
cells, fields = {}, []
if os.environ.get("FLOWS_DEBUG"):
    print("stage", stage, sorted(os.listdir(stage / "shots"))[:3], box, flush=True)
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
    print(a, b, "typical px", round(float(np.median(np.hypot(*small.transpose(2, 0, 1)))), 1), "max", round(float(np.hypot(*small.transpose(2, 0, 1)).max()), 1))
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
if not os.environ.get("FLOWS_DEBUG"):
    shutil.rmtree(stage)
print("flows", len(fields), "pairs, sheet", sheet.shape[:2])
