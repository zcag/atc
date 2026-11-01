"""build.py <work dir> <drawings dir> <out dir>: the character from its drawing library.

The work dir holds the 2x portrait (base2.png), the character matte, and the cached LaMa fills (room without him,
body without the head). The drawings dir holds LivePortrait renders of the head region (crop.json says where) named
<angle>.<feature> (drawings.py). For every head angle the head becomes a mesh, and each feature class (eyes, brows,
mouth) becomes patches: the part of each drawing that differs from that angle's neutral one, under one shared,
feathered mask per class, so swapping drawings never shows a seam. Everything gets the same grade (contrast, warm
key light from the lamp side, cool shadows); the room is darkened and softened for depth. Overlays add a vignette,
the lamp's glow and drifting dust. Parts are skinned to parallax bones (body, neck, head, face, back) as before.
"""
import sys, os, json, glob, numpy as np, cv2, triangle
from scipy.interpolate import griddata
from PIL import Image
from common import *

W_DIR, D_DIR, OUT = sys.argv[1:4]
POSES = sys.argv[4] if len(sys.argv) > 4 else None
os.makedirs(OUT, exist_ok=True)
w = lambda f: os.path.join(W_DIR, f)
SCALE = .65  # texture resolution relative to the 2x portrait: a phone canvas (824 px wide at DPR 2) shows it at about .6
base = load(w("base2.png"))
H, W = base.shape[:2]
cx0, cy0, cx1, cy1 = json.load(open(w("crop.json")))["box"]
P0 = landmarks(base, MODEL)
P2 = P0[:, :2]
FW = np.linalg.norm(P2[454] - P2[234])
hc = P2[OVAL].mean(0)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

# ---- the grade -----------------------------------------------------------------------------------------------
LAMP = np.array(json.load(open(w("char.json")))["lamp"], float)
key_c = hc + np.array([-.25, -.1]) * FW
KEY = .74 + .36 * np.exp(-(((xx - key_c[0]) / (1.05 * FW)) ** 2 + ((yy - key_c[1]) / (1.5 * FW)) ** 2))


def sharpen(img):
    """LivePortrait draws a little softer than the painting: an unsharp mask brings the detail back."""
    return np.clip(img + .45 * (img - cv2.GaussianBlur(img, (0, 0), 1.4)), 0, 255)


def grade(rgb, key=None):
    """Moodier: more contrast, slightly deeper mids, cool shadows and warm highlights, a key light on the face."""
    c = np.clip(rgb / 255, 0, 1) ** 1.12
    c = c + (c * c * (3 - 2 * c) - c) * .5
    lum = c.mean(2, keepdims=True)
    c = c * (1 + np.clip(1 - 2 * lum, 0, 1) * np.array([-.08, -.02, .07])) * (1 + np.clip(2 * lum - 1, 0, 1) * np.array([.06, .01, -.07]))
    if key is not None:
        c = c * key[..., None]
    return np.clip(c * 255, 0, 255)


# ---- mesh helpers ---------------------------------------------------------------------------------------------
def resample(poly, step):
    pts = np.r_[poly, poly[:1]]
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    t = np.linspace(0, d[-1], max(3, int(d[-1] / step)), endpoint=False)
    return np.stack([np.interp(t, d, pts[:, 0]), np.interp(t, d, pts[:, 1])], 1)


def outline(alpha, step, eps=2):
    c = max(cv2.findContours((alpha > .5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], key=cv2.contourArea)
    return resample(cv2.approxPolyDP(c, eps, True)[:, 0].astype(np.float64), step)


def tri(boundary, opts):
    n = len(boundary)
    t = triangle.triangulate({"vertices": boundary, "segments": np.array([[i, (i + 1) % n] for i in range(n)])}, opts)
    return t["vertices"], t["triangles"]


def grid(box, nx, ny):
    x, y, bw, bh = box
    v = np.array([[x + bw * i / nx, y + bh * j / ny] for j in range(ny + 1) for i in range(nx + 1)], float)
    t = [[j * (nx + 1) + i, j * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i] for j in range(ny) for i in range(nx)]
    t += [[j * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i] for j in range(ny) for i in range(nx)]
    return v, t


BONES = ["root", "body", "neck", "head", "face", "back"]


def skin(ws, n):
    """Up to four (bone index, weight) pairs per vertex from named weight arrays."""
    names = list(ws)
    Wm = np.stack([np.broadcast_to(np.asarray(ws[k], float), (n,)) for k in names], 1)
    o = np.argsort(-Wm, 1)[:, :4]
    wt = np.take_along_axis(Wm, o, 1)
    wt = wt / np.maximum(wt.sum(1, keepdims=True), 1e-6)
    idx = np.array([BONES.index(k) for k in names])[o]
    pad = 4 - idx.shape[1]
    return np.pad(idx, ((0, 0), (0, pad))).tolist(), np.round(np.pad(wt, ((0, 0), (0, pad))), 4).tolist()


class Atlas:
    """Shelf-packs part images (tallest first) into one texture per group, at SCALE. add() returns a slot number;
    write() places them and returns each slot's uv rectangle."""
    def __init__(self, name, width=2048):
        self.name, self.width, self.items = name, width, []

    def add(self, rgba):
        self.items.append(cv2.resize(rgba, (max(1, round(rgba.shape[1] * SCALE)), max(1, round(rgba.shape[0] * SCALE))), interpolation=cv2.INTER_AREA))
        return len(self.items) - 1

    def write(self):
        x = y = row = 0
        at = {}
        for i in sorted(range(len(self.items)), key=lambda i: -self.items[i].shape[0]):
            h, wd = self.items[i].shape[:2]
            if x + wd + 2 > self.width:
                x, y, row = 0, y + row + 2, 0
            at[i] = (x + 1, y + 1)
            x += wd + 2
            row = max(row, h)
        H_ = y + row + 2
        out = np.zeros((H_, self.width, 4), np.float32)
        for i, (px, py) in at.items():
            img = self.items[i]
            out[py:py + img.shape[0], px:px + img.shape[1]] = img
        Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA").save(os.path.join(OUT, self.name), quality=90, method=6)
        return {i: [round(px / self.width, 6), round(py / H_, 6), round((px + self.items[i].shape[1]) / self.width, 6), round((py + self.items[i].shape[0]) / H_, 6)] for i, (px, py) in at.items()}


parts, atlases = [], []


def write_tex(name, img, scale=SCALE, q=90):
    img = cv2.resize(img.clip(0, 255).astype(np.float32), (round(img.shape[1] * scale), round(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    Image.fromarray(img.astype(np.uint8), "RGBA" if img.shape[2] == 4 else "RGB").save(os.path.join(OUT, name), quality=q, method=6)


def part(name, verts, tris, tex, box, bones, rect=None, **extra):
    bi, bw = skin(bones, len(verts))
    p = {"name": name, "tex": tex, "box": [round(float(v), 2) for v in box], "v": np.round(verts, 2).ravel().tolist(), "t": np.asarray(tris).ravel().tolist(), "bi": bi, "bw": bw, **extra}
    if rect is not None:
        p["rect"] = rect
    parts.append(p)
    return p


def crop_rgba(rgba, pad=2):
    ys, xs = np.nonzero(rgba[..., 3] > 1)
    x0, y0, x1, y1 = max(0, xs.min() - pad), max(0, ys.min() - pad), min(rgba.shape[1], xs.max() + pad + 1), min(rgba.shape[0], ys.max() + pad + 1)
    return rgba[y0:y1, x0:x1], [x0, y0, x1 - x0, y1 - y0]


def depth_field(P):
    """Parallax weight from landmark depth: 1 at the nose tip, 0 at the face's rim and beyond."""
    z = -P[:, 2]
    zn = np.clip((z - z[OVAL].mean()) / (z[1] - z[OVAL].mean()), 0, 1)
    oval = P[OVAL, :2].astype(np.float32)

    def at(pts):
        d = griddata(P[:, :2], zn, pts, method="linear")
        rim = np.array([cv2.pointPolygonTest(oval, (float(p[0]), float(p[1])), True) for p in pts])
        return np.clip(np.where(np.isnan(d), 0, d) * np.clip(rim / 40 + .5, 0, 1), 0, 1)
    return at


def bone_weights(dep, ear=0):
    f, b = .9 * dep, .9 * np.asarray(ear, float)
    return dict(head=np.clip(1 - f - b, 0, 1), face=f, back=b)


# ---- room and body --------------------------------------------------------------------------------------------
matte = cv2.resize(np.array(Image.open(w("matte.png")).convert("RGBA"))[..., 3], (W, H), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
plate = grade(load(w("fill_plate.png"))) * .62
plate = cv2.GaussianBlur(plate, (0, 0), 5)
write_tex("plate.webp", plate, .5, 86)
part("plate", np.array([[0, 0], [W, 0], [0, H], [W, H]], float), [[0, 1, 2], [1, 3, 2]], "plate.webp", [0, 0, W, H], dict(root=1.))

hm0 = head_mask(parse(base))
headbig = cv2.dilate(hm0, np.ones((9, 9), np.uint8)) > 0
MC = P2[[13, 14]].mean(0)
cut = MC[1] - .1 * FW
body_a = np.where(headbig, np.where(yy > cut, np.maximum(matte, (yy > cut) * cv2.GaussianBlur(cv2.dilate(hm0, np.ones((41, 41), np.uint8)).astype(np.float32), (0, 0), 6)), 0), matte)
body_a *= 1 - cv2.GaussianBlur(((yy <= cut) & headbig).astype(np.float32), (0, 0), 2)
bt, bbox = crop_rgba(np.dstack([grade(load(w("fill_body.png")), KEY), body_a * 255]))
write_tex("body.webp", bt)
bv, btri = tri(outline(body_a, 40, 3), "pq28a2500")
neck_bot = MC[1] + .45 * FW
nw = np.clip((neck_bot - bv[:, 1]) / (neck_bot - cut + .05 * FW), 0, 1) ** 1.5 * np.exp(-(np.abs(bv[:, 0] - MC[0]) / (.6 * FW)) ** 4)
part("body", bv, btri, "body.webp", bbox, dict(body=1 - nw, neck=nw))

# ---- head angles and their feature drawings -------------------------------------------------------------------
names = sorted(os.path.basename(f)[:-4] for f in glob.glob(os.path.join(D_DIR, "lp", "*.png")))
angles = sorted({n.split(".")[0] for n in names}, key=lambda a: (int(a[1:].split("p")[1]), int(a[1:].split("p")[0])))
ANG = {a: [int(a[1:].split("p")[0]), int(a[1:].split("p")[1])] for a in angles}
KEYc = KEY[cy0:cy1, cx0:cx1]
calib = {}


def zone(P, cls, shape):
    """Where a feature class may change the drawing, softly bounded, in crop coordinates."""
    ys, xs = np.mgrid[0:shape[0], 0:shape[1]].astype(np.float32)
    eyes = P[EYE["R"] + EYE["L"], :2]
    brows = P[BROW["R"] + BROW["L"], :2]
    yb, ye, yn, ych = brows[:, 1].mean(), eyes[:, 1].mean(), P[2, 1], P[152, 1]
    ramp = lambda v, a, b: np.clip((v - a) / (b - a), 0, 1)
    if cls == "eyes":
        x0, x1 = eyes[:, 0].min() - .1 * FW, eyes[:, 0].max() + .1 * FW
        y0, y1 = yb + .45 * (ye - yb), ye + .45 * (yn - ye)
    elif cls == "brows":
        x0, x1 = brows[:, 0].min() - .08 * FW, brows[:, 0].max() + .08 * FW
        y0, y1 = yb - 1.1 * (ye - yb), yb + .6 * (ye - yb)
    else:
        lips = P[LIP_OUT, :2]
        x0, x1 = lips[:, 0].min() - .2 * FW, lips[:, 0].max() + .2 * FW
        y0, y1 = yn + .02 * FW, ych + .3 * (ych - yn)
    f = .04 * FW
    return ramp(xs, x0, x0 + f) * (1 - ramp(xs, x1 - f, x1)) * ramp(ys, y0, y0 + f) * (1 - ramp(ys, y1 - f, y1))


def feather(m, grow, soft):
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1)))
    return cv2.GaussianBlur(m.astype(np.float32), (0, 0), soft)


for a in angles:
    at = Atlas(f"head_{a}.webp")
    atlases.append(at)
    img0 = sharpen(load(os.path.join(D_DIR, "lp", f"{a}.base.png")))
    P = landmarks(img0, MODEL)
    lab = parse(img0)
    hm = head_mask(lab).astype(np.float32)
    alpha = cv2.GaussianBlur(hm, (0, 0), 1.2)
    off = np.array([cx0, cy0], float)
    dep = depth_field(np.c_[P[:, :2] + off, P[:, 2]])
    ears = cv2.GaussianBlur(np.isin(lab, [8, 9, 15]).astype(np.float32), (0, 0), 8)
    calib[a] = P[1, :2] + off
    rgba, hb = crop_rgba(np.dstack([grade(img0, KEYc), alpha * 255]))
    rect = at.add(rgba)
    hv, ht = tri(outline(alpha[hb[1]:hb[1] + hb[3], hb[0]:hb[0] + hb[2]], 18) + hb[:2], "pq28a600")
    ev = np.array([ears[int(min(max(y, 0), ears.shape[0] - 1)), int(min(max(x, 0), ears.shape[1] - 1))] for x, y in hv])
    hv = hv + off
    part(f"head.{a}", hv, ht, at.name, [hb[0] + cx0, hb[1] + cy0, hb[2], hb[3]], bone_weights(dep(hv), ev), rect, angle=a)
    for cls in ("eyes", "brows", "mouth"):
        feats = [n for n in names if n.startswith(f"{a}.{cls}.")]
        imgs = {n: sharpen(load(os.path.join(D_DIR, "lp", n + ".png"))) for n in feats}
        z = zone(P, cls, img0.shape)
        diff = np.zeros(img0.shape[:2], bool)
        for im in imgs.values():
            diff |= cv2.GaussianBlur(np.abs(im - img0).max(2), (0, 0), 1.5) > 10
        m = feather(diff & (z > 0), 10, 6) * z
        m = np.minimum(m, cv2.dilate(hm, np.ones((25, 25), np.uint8)) if cls != "mouth" else 1)
        ys, xs = np.nonzero(m > .01)
        bx = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
        gv, gt = grid([bx[0] + cx0, bx[1] + cy0, bx[2], bx[3]], 6, 6)
        bwts = bone_weights(dep(gv))
        for n, im in imgs.items():
            rgba = np.dstack([grade(im, KEYc), m * 255])[bx[1]:bx[1] + bx[3], bx[0]:bx[0] + bx[2]]
            part(n, gv, gt, at.name, [bx[0] + cx0, bx[1] + cy0, bx[2], bx[3]], bwts, at.add(rgba), angle=a, slot=cls, draw=n.split(".", 2)[2])
    print(a, "done", flush=True)

# ---- pose layers (poses.py): an arm, hands, a notebook; near the chin they follow the head ------------------------
for f in sorted(glob.glob(w("pose_*.png"))):
    name = os.path.basename(f)[5:-4]
    rgba, pb = crop_rgba(load(f, "RGBA"))
    rgba[..., :3] = grade(rgba[..., :3], KEY[pb[1]:pb[1] + pb[3], pb[0]:pb[0] + pb[2]])
    write_tex(f"pose_{name}.webp", rgba)
    gv, gt = grid(pb, 8, 10)
    up = .7 * np.clip((MC[1] + .45 * FW - gv[:, 1]) / (.35 * FW), 0, 1)
    part(f"pose.{name}", gv, gt, f"pose_{name}.webp", pb, dict(body=1 - up, head=up), slot="pose", draw=name)

# ---- overlays: vignette (multiply), the lamp's glow (add) ---------------------------------------------------------
vy, vx = np.mgrid[0:112, 0:64].astype(np.float32)
u, v = vx / 63 - hc[0] / W, vy / 111 - (hc[1] + .4 * FW) / H
vig = np.clip(1 - 1.25 * (u ** 2 * 1.6 + v ** 2 * .9), .32, 1) ** 1.3
tint = np.stack([1 + .05 * (1 - vx / 63), np.ones_like(vx), 1 + .06 * vx / 63], -1)
mul = np.dstack([np.clip(vig[..., None] * tint, 0, 1) * 255, np.full(vig.shape, 255)])
Image.fromarray(mul.astype(np.uint8), "RGBA").save(os.path.join(OUT, "vignette.webp"), quality=95, method=6)
part("vignette", np.array([[0, 0], [W, 0], [0, H], [W, H]], float), [[0, 1, 2], [1, 3, 2]], "vignette.webp", [0, 0, W, H], dict(root=1.), blend="mul")
R = 420
gy_, gx_ = np.mgrid[-R:R, -R:R].astype(np.float32)
g = np.exp(-(np.hypot(gx_, gy_) / (R * .38)) ** 2) * .55 + np.exp(-(np.hypot(gx_, gy_) / (R * .1)) ** 2) * .35
glow = np.dstack([np.broadcast_to(np.array([255., 178, 105]), g.shape + (3,)), np.clip(g, 0, 1) * 255])
Image.fromarray(np.clip(glow, 0, 255).astype(np.uint8), "RGBA").save(os.path.join(OUT, "glow.webp"), quality=92, method=6)
part("glow", np.array([LAMP + [-R, -R], LAMP + [R, -R], LAMP + [-R, R], LAMP + [R, R]], float), [[0, 1, 2], [1, 3, 2]], "glow.webp", [LAMP[0] - R, LAMP[1] - R, 2 * R, 2 * R], dict(root=1.), blend="add", flicker=1)

for at in atlases:
    uvs = at.write()
    for p in parts:
        if p["tex"] == at.name and "rect" in p:
            p["uv"] = uvs[p.pop("rect")]

# ---- bones: parallax per degree, measured between the drawings' nose tips -------------------------------------
yaw_px = (calib["y8p0"] - calib["y-8p0"]) / 16
pitch_px = (calib["y0p6"] - calib["y0p-6"]) / 12
r = lambda v: [round(float(a), 4) for a in v]
neck_pt = MC + np.array([0, .55 * FW])
bones = {
    "root": {"o": [0, 0], "p": {}},
    "body": {"parent": "root", "o": r([MC[0], H]), "p": {"sway": [0, 0, 1.2, 0, 0], "breath": [0, -3, 0, 0, .006], "lean": [6, 0, 0, 0, 0]}},
    "neck": {"parent": "body", "o": r(neck_pt + [0, .3 * FW]), "p": {"roll": [0, 0, 1.5, 0, 0]}},
    "head": {"parent": "neck", "o": r(neck_pt), "p": {"roll": [0, 0, 3.5, 0, 0], "yawRes": r([*(yaw_px * .25), 0, 0, 0]), "pitchRes": r([*(pitch_px * .25), 0, 0, 0])}},
    "face": {"parent": "head", "o": r(hc), "p": {"yawRes": r([*(yaw_px * .85), 0, 0, 0]), "pitchRes": r([*(pitch_px * .85), 0, 0, 0])}},
    "back": {"parent": "head", "o": r(hc), "p": {"yawRes": r([*(-yaw_px * .5), 0, 0, 0]), "pitchRes": r([*(-pitch_px * .4), 0, 0, 0])}},
}
rig = {"version": 2, "size": [W, H], "bones": bones, "boneOrder": BONES, "features": {}, "featureOrder": [], "parts": parts,
       "angles": ANG, "slots": {"eyes": "base", "brows": "base", "mouth": "base"},
       "dust": {"box": r([LAMP[0] - 120, LAMP[1] - 520, 900, 900]), "n": 46, "size": [2.5, 7], "color": [255, 196, 140]},
       "view": {"focus": r([hc[0] / W, (hc[1] + .25 * FW) / H]), "zoom": 1.12}}
json.dump(rig, open(os.path.join(OUT, "rig.json"), "w"), separators=(",", ":"))
json.dump({"kind": "rig", "files": ["rig.json"] + sorted({p["tex"] for p in parts})}, open(os.path.join(OUT, "persona.json"), "w"))
print("parts", len(parts), "angles", angles, "yaw px/deg", r(yaw_px), "pitch px/deg", r(pitch_px))
