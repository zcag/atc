"""rooms.py <room.json> <character dir>... [--publish]: checks a room and draws each character in it through web/rig.js,
writing <room>-verify.png beside the room: look at it, since no number judges whether a person belongs in a room.
--publish copies the picture and settings to atc's personas/_rooms when the checks pass. The room's picture has the same
name as its .json. A room's main light should come from the left: the characters have a lamp baked in on that side.
Run with playwright, opencv, numpy and pillow."""
import json, shutil, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw
from rigpage import NEUTRAL, render

args = [a for a in sys.argv[1:] if a != "--publish"]
publish = "--publish" in sys.argv
path = Path(args[0])
spec = json.load(open(path))
chars = [Path(a) for a in args[1:]]
results = []


def check(name, ok, detail):
    results.append((name, bool(ok), detail))


pics = [path.with_suffix(e) for e in (".jpg", ".jpeg", ".png", ".webp") if path.with_suffix(e).exists()]
check("picture beside it", len(pics) == 1, f"{[p.name for p in pics]}")
pic = pics[0]
img = Image.open(pic).convert("RGB")
check("picture shape", abs(img.width / img.height - 768 / 1344) < .03 and img.width >= 720, f"{img.width}x{img.height}: 768x1344 fits a character's frame")
source = spec.get("source") or {}
check("source recorded", source.get("prompt") or source.get("lost"), "\"source\" needs \"prompt\" and \"model\", or \"lost\"")
check("title", spec.get("title"), spec.get("title", ""))
inside = lambda v: all(0 <= x <= 1 for x in v)
bad = [g for g in spec.get("glows", []) if not inside(g["at"])] + [s for s in spec.get("shafts", []) if not all(inside(p) for p in s["poly"])] + [p for p in spec.get("particles", []) if not inside(p.get("box", [0, 0, 1, 1])) or p.get("kind", "dust") not in ("dust", "rain", "snow", "ember")]
check("positions and kinds", not bad, f"{bad[:2]}")
known = {"lamp", "fire", "neon", "sun", "steady", None}
check("flicker kinds", all(g.get("flicker") in known for g in spec.get("glows", []) + spec.get("shafts", [])) and spec.get("light", {}).get("flicker") in known, "lamp, fire, neon, sun or steady")
gray = np.asarray(img.convert("L"), np.float32)
H, W = gray.shape
around = float(np.r_[gray[int(H * .14):int(H * .4), int(W * .02):int(W * .18)].ravel(), gray[int(H * .14):int(H * .4), int(W * .82):int(W * .98)].ravel()].mean()) * spec.get("dim", .62)
check("a head stands out against it", around < 165, f"brightness beside the head {around:.0f} of 255 after dimming")
moods = spec.get("moods", {})
check("moods stay subtle", all(.8 < m.get("exposure", 1) < 1.15 and abs(m.get("warm", 0)) < .06 for m in moods.values()), "exposure .8 to 1.15, warm under .06")

at = lambda **k: {**NEUTRAL, **k}
seq = [{"p": at()}] * 60 + [{"p": at(), "shot": "listening"}]
seq += [{"p": at(pose="think", knit=.6, serious=1)}] * 60 + [{"p": at(pose="think", knit=.6, serious=1), "shot": "thinking"}]
seq += [{"p": at()}] * 30 + [{"p": at(jaw=.45, yaw=-.3)}] * 40 + [{"p": at(jaw=.45, yaw=-.3), "shot": "speaking"}]
sheets = []
for c in chars:
    stage, _ = render(c, seq, (720, 1560), room=True, background=(pic, path))
    row = []
    for n in ("listening", "thinking", "speaking"):
        im = Image.open(stage / f"shots/{n}.jpg").convert("RGB").resize((360, 780))
        ImageDraw.Draw(im).text((6, 6), f"{c.name} {n}", fill=(250, 230, 120))
        row.append(im)
    sheets.append(row)
    shutil.rmtree(stage)
if sheets:
    sheet = Image.new("RGB", (len(sheets[0]) * len(sheets) * 360, 780))
    for i, row in enumerate(sheets):
        for j, im in enumerate(row):
            sheet.paste(im, ((i * len(row) + j) * 360, 0))
    sheet.save(path.with_name(path.stem + "-verify.png"))

passed = all(ok for _, ok, _ in results)
for name, ok, detail in results:
    print("ok  " if ok else "FAIL", name, "-", detail)
print("PASS" if passed else "FAIL", path.stem)
if publish and passed:
    dst = Path.home() / ".local/share/atc/app/personas/_rooms"
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copy(pic, dst)
    shutil.copy(path, dst)
    print("published", pic.name)
sys.exit(0 if passed else 1)
