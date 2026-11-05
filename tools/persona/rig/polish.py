"""polish.py <character dir> <out dir> [--erase x,y;x,y;...] [--move pose=dx,dy]...: repairs a built character and moves
its room into room.json, without needing its sources. Run with numpy, opencv and pillow.

- room: plate, vignette, glow and dust go from rig.json to room.json, which rig.js loads separately.
- body: --erase cuts a polygon (art px) out, then only the largest piece stays (stray chips of the portrait float otherwise).
- mouth drawings lose what they carried of the old room: scraps beside the jaw that show on any other background.
- knit brows: the brow's movement from the neutral drawing is exaggerated a little, since the drawings' own is faint.
- half and shut eyes: pixels the lid doesn't change go back to the neutral drawing, which removes ghost glasses.
- --move shifts a pose layer: a hand that doesn't reach the chin.
- --serious blends the small closed mouth with the resting one when there is no neutral drawing and the full one pouts.
Coordinates are in the portrait's pixels (rig.json "size")."""
import argparse, json, shutil
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("src", type=Path)
ap.add_argument("out", type=Path)
ap.add_argument("--erase", action="append", default=[])
ap.add_argument("--move", action="append", default=[])
ap.add_argument("--knit", type=float, default=1.5)
ap.add_argument("--serious", type=float)
a = ap.parse_args()
assert not json.load(open(a.src / "rig.json")).get("polished"), "already polished: start from a fresh build"
if a.out.exists():
    shutil.rmtree(a.out)
shutil.copytree(a.src, a.out)
R = json.load(open(a.out / "rig.json"))
parts = {p["name"]: p for p in R["parts"]}
tex = {}


def atlas(name):
    if name not in tex:
        tex[name] = np.asarray(Image.open(a.out / name).convert("RGBA"), np.float32).copy()
    return tex[name]


def rect(p):
    A = atlas(p["tex"])
    u0, v0, u1, v1 = p.get("uv", [0, 0, 1, 1])
    H, W = A.shape[:2]
    return round(u0 * W), round(v0 * H), round(u1 * W), round(v1 * H)


def get(p):
    x0, y0, x1, y1 = rect(p)
    return atlas(p["tex"])[y0:y1, x0:x1]


def put(p, img):
    x0, y0, x1, y1 = rect(p)
    atlas(p["tex"])[y0:y1, x0:x1] = img


def under(p, head):
    """The head drawing's pixels under patch p, at the patch's resolution."""
    h, pc, hb, pb = get(head), get(p), head["box"], p["box"]
    k = pc.shape[1] / pb[2]
    M = np.float32([[1, 0, (hb[0] - pb[0]) * k], [0, 1, (hb[1] - pb[1]) * k]])
    return cv2.warpAffine(h, M, (pc.shape[1], pc.shape[0]), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))


# ---- body
body = parts["body"]
b = get(body)
mask = np.ones(b.shape[:2], np.float32)
k = b.shape[1] / body["box"][2]
for poly in a.erase:
    pts = np.array([[float(v) for v in xy.split(",")] for xy in poly.split(";")])
    pts = (pts - np.array(body["box"][:2])) * k
    cut = np.zeros(b.shape[:2], np.float32)
    cv2.fillPoly(cut, [pts.round().astype(np.int32)], 1.)
    mask *= 1 - cv2.GaussianBlur(cut, (0, 0), 2.5)
b[..., 3] *= mask
n, lab, stats, _ = cv2.connectedComponentsWithStats((b[..., 3] > 8).astype(np.uint8), connectivity=8)
b[..., 3] *= (lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])))
put(body, b)

# ---- head angles
for angle in R["angles"]:
    head = parts[f"head.{angle}"]
    for p in [q for q in R["parts"] if q.get("angle") == angle and q.get("slot") == "mouth"]:
        pc = get(p)
        solid = ((under(p, head)[..., 3] > 128) | (under(p, body)[..., 3] > 128)).astype(np.uint8)
        near = cv2.GaussianBlur(cv2.dilate(solid, np.ones((17, 17), np.uint8)).astype(np.float32), (0, 0), 3)
        pc[..., 3] *= near
        put(p, pc)
    knit = parts.get(f"{angle}.brows.knit")
    if knit:
        pc, h = get(knit), under(knit, head)
        g0, g1 = (cv2.cvtColor(x[..., :3].clip(0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY) for x in (h, pc))
        F = cv2.GaussianBlur(cv2.calcOpticalFlowFarneback(g0, g1, None, .5, 4, 31, 3, 7, 1.5, 0), (0, 0), 9)
        yy, xx = np.mgrid[0:pc.shape[0], 0:pc.shape[1]].astype(np.float32)
        warped = cv2.remap(h[..., :3], xx - a.knit * F[..., 0], yy - a.knit * F[..., 1], cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        pc[..., :3] = warped
        put(knit, pc)
    for name in ("half", "shut"):
        p = parts.get(f"{angle}.eyes.{name}")
        if not p:
            continue
        pc, h = get(p), under(p, head)
        d = cv2.GaussianBlur(np.abs(pc[..., :3] - h[..., :3]).max(2), (0, 0), 7)
        lid = np.clip((d - 9) / 12, 0, 1)
        lid = cv2.GaussianBlur(cv2.dilate(lid, np.ones((9, 9), np.uint8)), (0, 0), 4)
        pc[..., 3] *= lid
        put(p, pc)

# ---- pose layers
for mv in a.move:
    name, xy = mv.split("=")
    dx, dy = (float(v) for v in xy.split(","))
    p = parts[f"pose.{name}"]
    p["box"] = [p["box"][0] + dx, p["box"][1] + dy, *p["box"][2:]]
    p["v"] = [v + (dy if i % 2 else dx) for i, v in enumerate(p["v"])]

for name, img in tex.items():
    Image.fromarray(img.clip(0, 255).astype(np.uint8), "RGBA").save(a.out / name, quality=92, method=6)

# ---- the room
if not R.get("room"):
    room = [p for p in R["parts"] if p["name"] in ("plate", "vignette", "glow")]
    R["parts"] = [p for p in R["parts"] if p not in room]
    json.dump({"parts": room, "dust": R.pop("dust", None)}, open(a.out / "room.json", "w"), separators=(",", ":"))
    R["room"] = "room.json"
    spec = json.load(open(a.out / "persona.json"))
    spec["files"] = sorted(set(spec["files"]) | {"room.json"})
    json.dump(spec, open(a.out / "persona.json", "w"))
R["polished"] = 1
if a.serious is not None:
    R["serious"] = a.serious
json.dump(R, open(a.out / "rig.json", "w"), separators=(",", ":"))
print("polished", a.out)
