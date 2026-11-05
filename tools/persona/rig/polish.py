"""polish.py <character dir> <out dir> [--erase x,y;x,y;...] [--move pose=dx,dy]...: repairs a built character and moves
its room into room.json, without needing its sources. Run with numpy, opencv and pillow.

- room: plate, vignette, glow and dust go from rig.json to room.json, which rig.js loads separately.
- body: --erase cuts a polygon (art px) out, then only the largest piece stays (stray chips of the portrait float otherwise).
- mouth drawings lose what they carried of the old room: scraps beside the jaw that show on any other background.
- the head's edge is smoothed and pulled in a little: the matte's steps and rough rim show on any lighter room.
- knit brows: the brow's movement from the neutral drawing is exaggerated a little, since the drawings' own is faint.
- half and shut eyes: pixels the lid doesn't change go back to the neutral drawing, which removes ghost glasses.
- --move shifts a pose layer: a hand that doesn't reach the chin.
- --edge N: the outer N art px of the head and body take their colour from just inside, then lose a little alpha: the cut
  edge carries the portrait's dark room, which shows as an outline on a bright background. On the head, dark paint reached
  from outside the cut is removed first (room caught between hair tips).
- --scale K shrinks the whole figure about the bottom middle, and --zoom sets how far the view crops in: a portrait whose head
  fills more of the frame than the others'. verify.py measures the result.
- --serious blends the small closed mouth with the resting one when there is no neutral drawing and the full one pouts.
- --manner sets how the character acts: match it to the voice, in a real call.
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
ap.add_argument("--edge", type=int, default=0)
ap.add_argument("--scale", type=float, default=1)
ap.add_argument("--zoom", type=float)
ap.add_argument("--manner", type=json.loads, help="how he carries himself, Behaviour's manner in web/rig.js, as JSON")
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



def clean_edge(p, trim_dark=False):
    pc = get(p)
    n = max(1, round(a.edge * pc.shape[1] / p["box"][2]))
    if trim_dark:
        dark, reached = pc[..., :3].mean(2) < 60, (pc[..., 3] < 128).astype(np.uint8)
        for _ in range(5 * n):
            reached = cv2.dilate(reached, np.ones((3, 3), np.uint8)) & (dark | (reached > 0)).astype(np.uint8)
        pc[..., 3][reached > 0] = 0
    inner = cv2.erode((pc[..., 3] > 200).astype(np.uint8), np.ones((2 * n + 1, 2 * n + 1), np.uint8))
    _, labels = cv2.distanceTransformWithLabels(1 - inner, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(inner)
    by_label = np.zeros((labels.max() + 1, 3), np.float32)
    by_label[labels[ys, xs]] = pc[ys, xs, :3]
    rim = inner == 0
    pc[..., :3][rim] = by_label[labels[rim]]
    pc[..., 3] = cv2.GaussianBlur(cv2.erode(pc[..., 3], np.ones((3, 3), np.uint8)), (0, 0), 1)
    put(p, pc)


if a.edge:
    clean_edge(body)
    for angle in R["angles"]:
        clean_edge(parts[f"head.{angle}"], trim_dark=True)

# ---- head angles
for angle in R["angles"]:
    head = parts[f"head.{angle}"]
    h = get(head)
    h[..., 3] = np.clip((cv2.GaussianBlur(h[..., 3], (0, 0), 1.8) - 150) * 2.4 + 128, 0, 255)
    put(head, h)
    for p in [q for q in R["parts"] if q.get("angle") == angle and q.get("slot") == "mouth"]:
        pc = get(p)
        solid = ((under(p, head)[..., 3] > 128) | (under(p, body)[..., 3] > 128)).astype(np.uint8)
        near = cv2.GaussianBlur(cv2.dilate(solid, np.ones((9, 9), np.uint8)).astype(np.float32), (0, 0), 2.5)
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

# ---- the figure's size in the frame
W_, H_ = R["size"]
below = 40 if a.scale != 1 else 0
fit_x = lambda x: W_ / 2 + a.scale * (x - W_ / 2)
fit_y = lambda y: H_ + below + a.scale * (y - H_)
if a.scale != 1:
    for p in R["parts"]:
        if p["name"] in ("plate", "vignette", "glow"):
            continue
        p["v"] = [round(fit_y(v) if i % 2 else fit_x(v), 2) for i, v in enumerate(p["v"])]
        x, y, w, h = p["box"]
        p["box"] = [round(fit_x(x), 2), round(fit_y(y), 2), round(w * a.scale, 2), round(h * a.scale, 2)]
    for b in R["bones"].values():
        if b["o"] != [0, 0]:
            b["o"] = [round(fit_x(b["o"][0]), 4), round(fit_y(b["o"][1]), 4)]
        for m in b["p"].values():
            m[0] *= a.scale
            m[1] *= a.scale
    fx, fy = R["view"]["focus"]
    R["view"]["focus"] = [round(fit_x(fx * W_) / W_, 4), round(fit_y(fy * H_) / H_, 4)]
if a.zoom:
    R["view"]["zoom"] = a.zoom

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
if a.manner:
    R["manner"] = a.manner
json.dump(R, open(a.out / "rig.json", "w"), separators=(",", ":"))
print("polished", a.out)
