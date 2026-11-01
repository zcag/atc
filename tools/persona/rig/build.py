"""Builds a rigged character from one painted portrait (2x base), its landmarks, face parse, glasses split and eyes.

Output folder: rig.json (bones, deformers, parts with meshes and weights) and the part textures. Coordinates are
image pixels of the base. Every part's vertices are skinned to parallax bones (body, neck, head, face, back) and
moved by additive deformers (jaw, lips, corners, lids, brows, irises), which act in the rest pose before skinning.
"""
import sys, os, json, numpy as np, cv2, triangle
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.linalg import spsolve
from scipy.interpolate import griddata
from PIL import Image
from common import *

W_DIR, OUT = sys.argv[1:3]
os.makedirs(OUT, exist_ok=True)
w = lambda f: os.path.join(W_DIR, f)
base = load(w("base2.png"))
H, W = base.shape[:2]
P = landmarks(w("lm.json"))
P2 = P[:, :2]
lab = np.array(Image.open(w("parse.png")))
eyes = json.load(open(w("eyes.json")))
face_ng = load(w("face_ng.png"))

# ---- face frame ---------------------------------------------------------------------------------------------
ER, EL = P2[468], P2[473]
ex = (EL - ER) / np.linalg.norm(EL - ER)
ey = np.array([-ex[1], ex[0]])
FW = np.linalg.norm(P2[454] - P2[234])
uv = lambda p, o: np.stack([(p - o) @ ex, (p - o) @ ey], -1)

# ---- masks --------------------------------------------------------------------------------------------------
matte = cv2.resize(np.array(Image.open(os.path.join(os.path.dirname(W_DIR.rstrip("/")), "..", "matte.png")).convert("RGBA"))[..., 3], (W, H), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
head_cls = np.isin(lab, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15])
hm = head_cls.astype(np.uint8)
hm = cv2.morphologyEx(hm, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
n, cc, st, _ = cv2.connectedComponentsWithStats(hm)
hm = (cc == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
cnts = cv2.findContours(hm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]
hm = np.zeros_like(hm)
cv2.drawContours(hm, cnts, -1, 1, -1)
gl_img = load(w("glasses.png"), "RGBA")
hm |= (cv2.dilate((gl_img[..., 3] > 40).astype(np.uint8), np.ones((5, 5), np.uint8)) & (matte > .5)).astype(np.uint8)
head_a = np.minimum(cv2.GaussianBlur(hm.astype(np.float32), (0, 0), 1.2), matte)

# ---- eye holes and mouth slit -------------------------------------------------------------------------------
holes = {s: np.array(eyes[s]["hole"]) for s in "RL"}
hole_a = np.zeros((H, W), np.float32)
for s in "RL":
    big = np.zeros((H * 4 // 4, W), np.uint8)
    hole_a = np.maximum(hole_a, cv2.GaussianBlur(poly_mask((H, W), holes[s]).astype(np.float32), (0, 0), .7))


def slit_line():
    """The painted line between the lips: per column, the darkest pixel near the landmarks' inner lip line."""
    up, lo = P2[LIP_UP_IN], P2[LIP_LO_IN]
    mid = (up + lo) / 2
    c0, c1 = mid[0], mid[-1]
    lum = cv2.GaussianBlur(base.mean(2), (0, 0), 1)
    pts = []
    n = int(np.linalg.norm(c1 - c0) / 6)
    for t in np.linspace(0, 1, n + 1):
        u = c0 + (c1 - c0) * t
        k = np.argmin(np.abs((mid - c0) @ ex - (u - c0) @ ex))
        guess = mid[k] if 0 < t < 1 else u
        best = min(range(-6, 7), key=lambda d: lum[int(round(guess[1] + d * ey[1])), int(round(guess[0] + d * ey[0]))])
        pts.append(guess + ey * best if 0 < t < 1 else guess)
    pts = np.array(pts)
    pts[1:-1] = cv2.GaussianBlur(pts.reshape(-1, 1, 2), (1, 5), 0).reshape(-1, 2)[1:-1]
    return pts


slit = slit_line()
corners = slit[[0, -1]]
MC = slit[len(slit) // 2]

# ---- textures -----------------------------------------------------------------------------------------------
from simple_lama_inpainting import SimpleLama


def inpaint(img, mask, scale=.5):
    """LaMa at reduced size (the filled area is mostly hidden), pasted back only inside the mask."""
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA).astype(np.uint8)
    sm = cv2.resize(mask.astype(np.uint8) * 255, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    out = np.array(SimpleLama()(Image.fromarray(small), Image.fromarray(sm)))[: small.shape[0], : small.shape[1]].astype(np.float32)
    out = cv2.resize(out, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_CUBIC)
    m = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 2)[..., None]
    return out * m + img * (1 - m)


char = matte > .5
cached = lambda f, make: load(w(f)) if os.path.exists(w(f)) else (lambda a: (save(w(f), a), a)[1])(make())
plate = cached("fill_plate.png", lambda: inpaint(base, cv2.dilate(char.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0, .5))
# the body under the head: fill the head with what would be behind it (neck, collar, room)
headbig = cv2.dilate(hm, np.ones((9, 9), np.uint8)) > 0
body_rgb = cached("fill_body.png", lambda: inpaint(base, headbig, .5))
cut = MC[1] - .1 * FW  # below this line the filled head area belongs to the body (neck under the beard)
yy = np.mgrid[0:H, 0:W][0]
body_a = np.where(headbig, np.where(yy > cut, np.maximum(matte, (yy > cut).astype(np.float32) * cv2.GaussianBlur(cv2.dilate(hm, np.ones((41, 41), np.uint8)).astype(np.float32), (0, 0), 6)), 0), matte)
body_a = np.minimum(body_a, cv2.GaussianBlur(np.maximum(matte, headbig.astype(np.float32) * (yy > cut)), (0, 0), 1))
body_a *= 1 - cv2.GaussianBlur(((yy <= cut) & headbig).astype(np.float32), (0, 0), 2)

head_rgba = np.dstack([face_ng, head_a * 255])


def mouth_inside():
    """The inside of the mouth seen through the opened lips: a dark warm cavity, a hint of upper teeth in shadow,
    the tongue low. Painted in the face's frame, larger than the widest opening."""
    L = np.linalg.norm(corners[1] - corners[0])
    o = MC
    x0, y0 = (np.minimum(corners.min(0), o - ey * 10) - [14, 14]).astype(int)
    x1, y1 = (np.maximum(corners.max(0), o + ey * .16 * FW) + [14, 14]).astype(int)
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    q = uv(np.stack([xx, yy], -1), o)
    u, v = q[..., 0] / (L / 2), q[..., 1]
    lip = np.median(np.array([base[int(round(p[1] + 10 * ey[1])), int(round(p[0] + 10 * ey[0]))] for p in slit[len(slit) // 4: -len(slit) // 4]]), axis=0)
    deep = lip * .2 + np.array([10, 2, 2])
    cav = deep * (1 - .25 * np.clip(np.abs(u), 0, 1) ** 2)[..., None]
    cav = cav * np.clip(.8 + .25 * np.clip(v / 30, 0, 1), 0, 1.1)[..., None]
    tongue = np.clip(1 - np.hypot(u / .75, (v - .13 * FW) / (.07 * FW)), 0, 1) ** .6
    cav = cav * (1 - tongue[..., None] * .8) + (lip * .62) * tongue[..., None] * .8
    teeth_c = np.array([205, 192, 175], np.float32) * .85
    edge = 1 / (1 + np.exp(-(v - (12 - 6 * u ** 2)) / 1.6))
    teeth = .85 * np.clip(1 - np.abs(u) / .55, 0, 1) ** .7 * (1 - edge) * (v > -14)
    shade = (1 - .3 * np.clip(v / 12, 0, 1)) * (1 - .5 * np.abs(u) ** 1.5) * (.75 + .25 * np.clip(v / 4, 0, 1))
    cav = cav * (1 - teeth[..., None]) + teeth_c * shade[..., None] * teeth[..., None]
    return np.dstack([cav, np.full(cav.shape[:2], 255)]), [x0, y0, x1 - x0, y1 - y0]


mouth_rgba, mouth_box = mouth_inside()

# ---- meshes -------------------------------------------------------------------------------------------------
def resample(poly, step, closed=True):
    pts = np.r_[poly, poly[:1]] if closed else poly
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    n = max(3, int(d[-1] / step))
    t = np.linspace(0, d[-1], n + (0 if closed else 1), endpoint=not closed)
    return np.stack([np.interp(t, d, pts[:, 0]), np.interp(t, d, pts[:, 1])], 1)


def outline(alpha, step, eps=2):
    m = (alpha > .5).astype(np.uint8)
    c = max(cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], key=cv2.contourArea)
    c = cv2.approxPolyDP(c, eps, True)[:, 0].astype(np.float64)
    return resample(c, step)


def offsets(poly, ds, closed=True):
    """Points around a polygon at the given distances (outside positive), for density near features."""
    out = []
    c = poly.mean(0)
    for d in ds:
        for p in poly:
            v = p - c
            out.append(p + v / (np.linalg.norm(v) + 1e-6) * d)
    return np.array(out)


def tri(boundary, holes_=(), lines=(), extra=None, opts="pq30a300"):
    verts, segs = [], []
    def add_loop(pts, closed=True):
        i0 = len(verts)
        verts.extend(pts.tolist())
        n = len(pts)
        segs.extend([[i0 + i, i0 + (i + 1) % n] for i in range(n if closed else n - 1)])
    add_loop(boundary)
    hole_pts = []
    for h in holes_:
        add_loop(h)
        hole_pts.append(h.mean(0).tolist())
    for l in lines:
        add_loop(l, closed=False)
    if extra is not None and len(extra):
        verts.extend(extra.tolist())
    d = {"vertices": np.array(verts), "segments": np.array(segs)}
    if hole_pts:
        d["holes"] = np.array(hole_pts)
    t = triangle.triangulate(d, opts)
    return t["vertices"], t["triangles"]


def inside(alpha, pts, thr=.3):
    return np.array([alpha[int(min(H - 1, max(0, p[1]))), int(min(W - 1, max(0, p[0])))] > thr for p in pts])


# head: outline, two eye holes, the mouth slit as a constrained line, denser rings around eyes and mouth
hb = outline(head_a, 16)
extra = [offsets(holes[s], [4, 10, 18, 30]) for s in "RL"]
for d in (-16, -8, 8, 16, 28):
    extra.append(resample(slit, 7, closed=False)[1:-1] + ey * d)
extra = np.concatenate(extra)
extra = extra[inside(head_a, extra, .6)]
for s in "RL":
    extra = extra[[cv2.pointPolygonTest(holes[s].astype(np.float32), tuple(map(float, p)), True) < -2 for p in extra]]
hv, ht = tri(hb, [holes[s] for s in "RL"], [resample(slit, 6, closed=False)], extra, "pq28a260")

# cut the mouth: every slit vertex except the two corners gets a twin used by the triangles below the line
sl = resample(slit, 6, closed=False)
on = [int(np.argmin(np.linalg.norm(hv - p, axis=1))) for p in sl]
assert all(np.linalg.norm(hv[i] - p) < .5 for i, p in zip(on, sl)), "slit vertices missing from the mesh"
twin = {}
for i in on[1:-1]:
    twin[i] = len(hv)
    hv = np.vstack([hv, hv[i]])
def below_slit(c):
    q = uv(sl, MC)
    qc = uv(c[None], MC)[0]
    return qc[1] > np.interp(qc[0], q[:, 0], q[:, 1])
for t in ht:
    if any(i in twin for i in t) and below_slit(hv[t].mean(0)):
        for k in range(3):
            if t[k] in twin:
                t[k] = twin[t[k]]
upper_slit, lower_slit = on[1:-1], [twin[i] for i in on[1:-1]]
slit_t = np.linspace(0, 1, len(on))[1:-1]


def graph(v, t):
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    e = np.unique(np.sort(e, 1), axis=0)
    l = np.linalg.norm(v[e[:, 0]] - v[e[:, 1]], axis=1)
    wgt = 1 / np.maximum(l, 1)
    n = len(v)
    A = coo_matrix((np.r_[wgt, wgt], (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    return A


def harmonic(A, fixed):
    """Smooth weights over the mesh graph: fixed vertices keep their values, the rest is the harmonic fill."""
    n = A.shape[0]
    idx = np.array(list(fixed.keys()))
    val = np.array([fixed[i] for i in idx], float)
    free = np.setdiff1d(np.arange(n), idx)
    L = csr_matrix(np.diag(np.asarray(A.sum(1)).ravel())) - A
    x = np.zeros(n)
    x[idx] = val
    rhs = -L[free][:, idx] @ val
    x[free] = spsolve(L[free][:, free].tocsc(), rhs)
    return np.clip(x, 0, 1)


A = graph(hv, ht)
Q = uv(hv, MC)
nose_v = uv(P2[2][None], MC)[0, 1]
chin_v = uv(P2[152][None], MC)[0, 1]
oval = P2[OVAL]

# parallax depth: landmark z (negative = toward the camera), 1 at the nose tip, 0 at the face's rim
z = -P[:, 2]
zn = (z - z[OVAL].mean()) / (z[1] - z[OVAL].mean())
depth = griddata(P2, np.clip(zn, 0, 1), hv, method="linear")
dist_oval = np.array([cv2.pointPolygonTest(oval.astype(np.float32), tuple(map(float, p)), True) for p in hv])
depth = np.where(np.isnan(depth), 0, depth) * np.clip(dist_oval / 40 + .5, 0, 1)
depth = np.clip(depth, 0, 1)
ears = np.isin(lab, [8, 9, 15])
earv = inside(cv2.dilate(ears.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(np.float32), hv, .5).astype(float)
earv = harmonic(A, {**{i: 1. for i in np.nonzero(earv > 0)[0]}, **{i: 0. for i in np.nonzero(dist_oval > 10)[0]}})

# jaw: 1 on the lower lip and chin, 0 above the nose and on the upper lip, harmonic between
jaw_fix = {i: 0. for i in upper_slit}
jaw_fix.update({i: float(.15 + .85 * np.sin(np.pi * t) ** .45) for i, t in zip(lower_slit, slit_t)})
jaw_fix.update({on[0]: .12, on[-1]: .12})
for i, (u, v) in enumerate(Q):
    if v < nose_v * .7:
        jaw_fix[i] = 0.
    elif v > .35 * (chin_v) and abs(u) < .22 * FW and i not in jaw_fix:
        jaw_fix[i] = 1.
    elif abs(u) > .5 * FW and v < .55 * chin_v:
        jaw_fix[i] = 0.
jaw_w = harmonic(A, jaw_fix)

ramp = np.sin(np.pi * slit_t) ** .6
uplip_w = harmonic(A, {**dict(zip(upper_slit, ramp)), **{i: 0. for i in lower_slit}, **{i: 0. for i, (u, v) in enumerate(Q) if v < nose_v * .55 or v > 25 or abs(u) > .4 * FW}})
lolip_w = harmonic(A, {**dict(zip(lower_slit, ramp)), **{i: 0. for i in upper_slit}, **{i: 0. for i, (u, v) in enumerate(Q) if v > .45 * chin_v or v < nose_v * .5 or abs(u) > .4 * FW}})
corner_w = {}
for k, s in ((0, "R"), (1, "L")):
    d = np.linalg.norm(hv - corners[k], axis=1)
    corner_w[s] = np.exp(-(d / (.07 * FW)) ** 2)

lid_w, lidlo_w, brow_w, cheek_w, lidgap = {}, {}, {}, {}, {}
for s in "RL":
    h = holes[s]
    hq = uv(h, h.mean(0))
    i0, i1 = np.argmin(hq[:, 0]), np.argmax(hq[:, 0])
    chord = lambda q: np.interp(q[0], [hq[i0, 0], hq[i1, 0]], [hq[i0, 1], hq[i1, 1]])
    ids = [int(np.argmin(np.linalg.norm(hv - p, axis=1))) for p in h]
    up = [i for i, q in zip(ids, hq) if q[1] < chord(q) - .5]
    lo = [i for i, q in zip(ids, hq) if q[1] > chord(q) + .5]
    lq = uv(hv[lo], h.mean(0))
    order = np.argsort(lq[:, 0])
    gaps = {}
    for i in up:
        q = uv(hv[i][None], h.mean(0))[0]
        gaps[i] = max(0., np.interp(q[0], lq[order, 0], lq[order, 1]) - q[1])
    G = max(gaps.values())
    lidgap[s] = G
    c = h.mean(0)
    far = {i: 0. for i in np.nonzero(np.linalg.norm(hv - c, axis=1) > 2.6 * G + 40)[0]}
    lid_w[s] = harmonic(A, {**far, **{i: g / G for i, g in gaps.items()}, **{i: 0. for i in lo}})
    lidlo_w[s] = harmonic(A, {**far, **{i: 0. for i in up}, **{i: float(np.sin(np.pi * np.clip((uv(hv[i][None], c)[0, 0] - hq[i0, 0]) / (hq[i1, 0] - hq[i0, 0]), 0, 1))) for i in lo}})
    bp = P2[BROW[s]]
    d = np.min(np.linalg.norm(hv[:, None] - bp[None], axis=2), 1)
    brow_w[s] = np.exp(-(d / (.09 * FW)) ** 2) * (1 - .8 * lid_w[s])
    ch = c + ey * .28 * FW
    cheek_w[s] = np.exp(-(np.linalg.norm(hv - ch, axis=1) / (.13 * FW)) ** 2) * (1 - jaw_w)


def skin(n, **ws):
    """Up to four (index, weight) pairs per vertex from named weight arrays, in the given order of priority."""
    names = list(ws)
    W_ = np.stack([np.broadcast_to(np.asarray(ws[k], float), (n,)) for k in names], 1)
    out_i = np.zeros((n, 4), int)
    out_w = np.zeros((n, 4))
    for v in range(n):
        o = np.argsort(-W_[v])[:4]
        out_i[v, :len(o)], out_w[v, :len(o)] = o, W_[v, o]
    return names, out_i, out_w


def pack(names_all, names, idx, wt):
    m = np.array([names_all.index(k) for k in names])
    i = m[idx]
    s = wt.sum(1, keepdims=True)
    return i.astype(int).tolist(), np.round(wt, 4).tolist()


BONES = ["root", "body", "neck", "head", "face", "back"]
FEATS = ["jaw", "uplip", "lolip", "cornerR", "cornerL", "lidR", "lidL", "lidloR", "lidloL", "browR", "browL", "cheekR", "cheekL", "irisR", "irisL"]


def bone_weights(v, dep, ear=0):
    """Parallax split: face (forward), back (ears) and head, normalised to one."""
    f = .9 * dep
    b = .9 * ear
    return dict(head=np.clip(1 - f - b, 0, 1), face=f, back=b)


def part(name, verts, tris, tex, box, bw, fw=None):
    bn, bi, bwt = skin(len(verts), **bw)
    i, wt = pack(BONES, bn, bi, bwt)
    p = {"name": name, "tex": tex, "box": [round(float(x), 2) for x in box], "v": np.round(verts, 2).ravel().tolist(), "t": np.asarray(tris).ravel().tolist(), "bi": i, "bw": wt}
    if fw:
        fn, fi, fwt = skin(len(verts), **fw)
        fi2, fwt2 = pack(FEATS, fn, fi, fwt)
        p["fi"], p["fw"] = fi2, fwt2
    return p


def crop_rgba(rgba, pad=2):
    a = rgba[..., 3] > 1
    ys, xs = np.nonzero(a)
    x0, y0, x1, y1 = max(0, xs.min() - pad), max(0, ys.min() - pad), min(rgba.shape[1], xs.max() + pad + 1), min(rgba.shape[0], ys.max() + pad + 1)
    return rgba[y0:y1, x0:x1], [x0, y0, x1 - x0, y1 - y0]


def write(name, rgba, q=92):
    Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8), "RGBA" if rgba.shape[2] == 4 else "RGB").save(os.path.join(OUT, name), quality=q, method=6)


parts = []
# plate: the room, a static quad
write("plate.webp", plate, 88)
parts.append(part("plate", np.array([[0, 0], [W, 0], [0, H], [W, H]], float), [[0, 1, 2], [1, 3, 2]], "plate.webp", [0, 0, W, H], dict(root=1.)))

# body: a grid over the torso, bending a little at the neck
bt, bbox = crop_rgba(np.dstack([body_rgb, body_a * 255]))
write("body.webp", bt)
bo = outline(body_a, 40, 3)
bv, btri = tri(bo, opts="pq28a2500")
neck_top, neck_bot = cut - .05 * FW, MC[1] + .45 * FW
nw = np.clip((neck_bot - bv[:, 1]) / (neck_bot - neck_top), 0, 1) ** 1.5
nearhead = np.exp(-(np.abs(bv[:, 0] - MC[0]) / (.6 * FW)) ** 4)
parts.append(part("body", bv, btri, "body.webp", bbox, dict(body=1 - nw * nearhead, neck=nw * nearhead)))

# mouth inside, behind the head: top rides with the face, bottom with the jaw
# rows follow the lip line: the upper teeth (down to v = 14) stay with the face, below that it rides the jaw
mx0, my0, mw, mh = mouth_box
slope = ex[1] / ex[0]
rows = [-1e3, -10, 0, 14, 24, 40, 1e3]
mv = np.array([[x, np.clip(MC[1] + r + slope * (x - MC[0]), my0, my0 + mh)] for r in rows for x in np.linspace(mx0, mx0 + mw, 9)])
mt = [[r * 9 + c, r * 9 + c + 1, (r + 1) * 9 + c] for r in range(len(rows) - 1) for c in range(8)] + [[r * 9 + c + 1, (r + 1) * 9 + c + 1, (r + 1) * 9 + c] for r in range(len(rows) - 1) for c in range(8)]
mq = uv(mv, MC)
mj = np.clip((mq[:, 1] - 14) / 10, 0, 1)
mdep = griddata(P2, np.clip(zn, 0, 1), mv, method="linear", fill_value=.5) * .9
write("mouth.webp", mouth_rgba)
parts.append(part("mouth", mv, mt, "mouth.webp", mouth_box, bone_weights(mv, mdep), dict(jaw=mj, cornerR=np.exp(-(np.linalg.norm(mv - corners[0], axis=1) / (.09 * FW)) ** 2), cornerL=np.exp(-(np.linalg.norm(mv - corners[1], axis=1) / (.09 * FW)) ** 2))))

# eyeballs, behind the head: sclera and iris, moved with the depth of the eye
for s in "RL":
    x, y, ww, hh = eyes[s]["sclera"]
    sv = np.array([[x, y], [x + ww, y], [x, y + hh], [x + ww, y + hh]], float)
    dep = griddata(P2, np.clip(zn, 0, 1), sv.mean(0)[None], method="linear")[0]
    sc = load(w(f"sclera{s}.png"), "RGBA")
    write(f"sclera{s}.webp", sc)
    parts.append(part(f"sclera{s}", sv, [[0, 1, 2], [1, 3, 2]], f"sclera{s}.webp", [x, y, ww, hh], bone_weights(sv, np.full(4, dep))))
    x, y, ww, hh = eyes[s]["iris_box"]
    iv = np.array([[x, y], [x + ww, y], [x, y + hh], [x + ww, y + hh]], float)
    write(f"iris{s}.webp", load(w(f"iris{s}.png"), "RGBA"))
    parts.append(part(f"iris{s}", iv, [[0, 1, 2], [1, 3, 2]], f"iris{s}.webp", [x, y, ww, hh], bone_weights(iv, np.full(4, dep)), {f"iris{s}": np.ones(4)}))

# head
ht_rgba, hbox = crop_rgba(head_rgba)
write("head.webp", ht_rgba)
bw = bone_weights(hv, depth, earv)
fw = dict(jaw=jaw_w, uplip=uplip_w, lolip=lolip_w, cornerR=corner_w["R"], cornerL=corner_w["L"], lidR=lid_w["R"], lidL=lid_w["L"],
          lidloR=lidlo_w["R"], lidloL=lidlo_w["L"], browR=brow_w["R"], browL=brow_w["L"], cheekR=cheek_w["R"], cheekL=cheek_w["L"])
parts.append(part("head", hv, ht, "head.webp", hbox, bw, fw))

# glasses: rigid on the nose, arms going back toward the ears
gt, gbox = crop_rgba(gl_img)
write("glasses.webp", gt)
gx, gy, gw, gh = gbox
gvv = np.array([[gx + gw * i / 10, gy + gh * j / 3] for j in range(4) for i in range(11)])
gtri = [[j * 11 + i, j * 11 + i + 1, (j + 1) * 11 + i] for j in range(3) for i in range(10)] + [[j * 11 + i + 1, (j + 1) * 11 + i + 1, (j + 1) * 11 + i] for j in range(3) for i in range(10)]
rims_c = (holes["R"].mean(0) + holes["L"].mean(0)) / 2
gu = np.abs((gvv - rims_c) @ ex) / (.5 * FW)
gdep = .62 * np.clip(1.25 - gu, 0, 1)
gear = np.clip((gu - .95) * 2, 0, 1)
parts.append(part("glasses", gvv, gtri, "glasses.webp", gbox, bone_weights(gvv, gdep, gear), dict(browR=np.full(len(gvv), 0.), browL=np.full(len(gvv), 0.))))

# ---- bones and deformers: o = origin, p = per-parameter [dx, dy, rotation (deg), scale x - 1, scale y - 1] ----
hc = P2[OVAL].mean(0)
neck_pt = MC + ey * .55 * FW
r1 = lambda v: [round(float(a), 3) for a in v]
bones = {
    "root": {"o": [0, 0], "p": {}},
    "body": {"parent": "root", "o": r1([MC[0], H]), "p": {"sway": [0, 0, 1.2, 0, 0], "breath": [0, -3, 0, 0, .006], "lean": [6, 0, 0, 0, 0]}},
    "neck": {"parent": "body", "o": r1(neck_pt + ey * .3 * FW), "p": {"nod": [0, 0, 0, 0, 0], "roll": [0, 0, 1.5, 0, 0]}},
    "head": {"parent": "neck", "o": r1(neck_pt), "p": {"roll": [0, 0, 3.5, 0, 0], "yaw": r1([*(ex * .012 * FW), 0, 0, 0]), "pitch": r1([*(ey * .015 * FW), 0, 0, 0])}},
    "face": {"parent": "head", "o": r1(hc), "p": {"yaw": r1([*(ex * .07 * FW), 0, -.02, 0]), "pitch": r1([*(ey * .055 * FW), 0, 0, -.015])}},
    "back": {"parent": "head", "o": r1(hc), "p": {"yaw": r1([*(-ex * .04 * FW), 0, 0, 0]), "pitch": r1([*(-ey * .03 * FW), 0, 0, 0])}},
}
gR, gL = lidgap["R"], lidgap["L"]
feats = {
    "jaw": {"o": r1(MC), "p": {"jaw": r1([*(ey * .085 * FW), 0, 0, 0]), "round": r1([*(ey * .01 * FW), 0, 0, 0])}},
    "uplip": {"o": r1(MC), "p": {"lipup": r1([*(-ey * .012 * FW), 0, 0, 0]), "round": r1([*(ey * .004 * FW), 0, 0, 0])}},
    "lolip": {"o": r1(MC), "p": {"lipdown": r1([*(ey * .012 * FW), 0, 0, 0]), "round": r1([*(-ey * .006 * FW), 0, 0, 0])}},
    "cornerR": {"o": r1(corners[0]), "p": {"smile": r1([*(-ex * .02 * FW - ey * .02 * FW), 0, 0, 0]), "wide": r1([*(-ex * .03 * FW), 0, 0, 0]), "round": r1([*(ex * .02 * FW + ey * .004 * FW), 0, 0, 0])}},
    "cornerL": {"o": r1(corners[1]), "p": {"smile": r1([*(ex * .02 * FW - ey * .02 * FW), 0, 0, 0]), "wide": r1([*(ex * .03 * FW), 0, 0, 0]), "round": r1([*(-ex * .02 * FW + ey * .004 * FW), 0, 0, 0])}},
    "lidR": {"o": r1(holes["R"].mean(0)), "p": {"blinkR": r1([*(ey * gR), 0, 0, 0])}},
    "lidL": {"o": r1(holes["L"].mean(0)), "p": {"blinkL": r1([*(ey * gL), 0, 0, 0])}},
    "lidloR": {"o": r1(holes["R"].mean(0)), "p": {"blinkR": r1([*(-ey * .12 * gR), 0, 0, 0]), "smile": r1([*(-ey * .1 * gR), 0, 0, 0])}},
    "lidloL": {"o": r1(holes["L"].mean(0)), "p": {"blinkL": r1([*(-ey * .12 * gL), 0, 0, 0]), "smile": r1([*(-ey * .1 * gL), 0, 0, 0])}},
    "browR": {"o": r1(P2[BROW["R"]].mean(0)), "p": {"browR": r1([*(-ey * .03 * FW), 0, 0, 0]), "knit": r1([*(ex * .012 * FW + ey * .008 * FW), 0, 0, 0])}},
    "browL": {"o": r1(P2[BROW["L"]].mean(0)), "p": {"browL": r1([*(-ey * .03 * FW), 0, 0, 0]), "knit": r1([*(-ex * .012 * FW + ey * .008 * FW), 0, 0, 0])}},
    "cheekR": {"o": r1(holes["R"].mean(0)), "p": {"smile": r1([*(-ey * .012 * FW), 0, 0, 0])}},
    "cheekL": {"o": r1(holes["L"].mean(0)), "p": {"smile": r1([*(-ey * .012 * FW), 0, 0, 0])}},
    "irisR": {"o": [0, 0], "p": {"gazeX": r1([*(ex * .32 * eyes["R"]["iris"][2]), 0, 0, 0]), "gazeY": r1([*(ey * .22 * eyes["R"]["iris"][2]), 0, 0, 0])}},
    "irisL": {"o": [0, 0], "p": {"gazeX": r1([*(ex * .32 * eyes["L"]["iris"][2]), 0, 0, 0]), "gazeY": r1([*(ey * .22 * eyes["L"]["iris"][2]), 0, 0, 0])}},
}
rig = {"version": 1, "size": [W, H], "bones": bones, "boneOrder": BONES, "features": feats, "featureOrder": FEATS, "parts": parts,
       "view": {"focus": r1([hc[0] / W, (hc[1] + .25 * FW) / H]), "zoom": 1.12}, "face": {"center": r1(hc), "width": round(float(FW), 1)}}
json.dump(rig, open(os.path.join(OUT, "rig.json"), "w"), separators=(",", ":"))
json.dump({"kind": "rig", "files": ["rig.json"] + sorted({p["tex"] for p in parts})}, open(os.path.join(OUT, "persona.json"), "w"))
print("parts", [(p["name"], len(p["v"]) // 2) for p in parts], "lid gaps", round(gR, 1), round(gL, 1), "FW", round(FW, 1))

# a wireframe over the head for checking the mesh
vis = base.copy()
for t in ht:
    cv2.polylines(vis, [hv[t].round().astype(np.int32)], True, (0, 255, 0), 1)
for i in lower_slit:
    cv2.circle(vis, tuple(hv[i].round().astype(int)), 2, (255, 0, 0), -1)
save(os.path.join(W_DIR, "mesh.jpg"), vis[int(hc[1] - .9 * FW):int(hc[1] + .9 * FW), int(hc[0] - .8 * FW):int(hc[0] + .8 * FW)])
panels = []
for arr in (jaw_w, lid_w["R"] + lid_w["L"] + lidlo_w["R"] + lidlo_w["L"], brow_w["R"] + brow_w["L"] + cheek_w["R"] + cheek_w["L"], uplip_w + lolip_w + corner_w["R"] + corner_w["L"], depth, earv):
    wv = base * .35
    for v, a in zip(hv, arr):
        cv2.circle(wv, tuple(v.round().astype(int)), 4, (255 * float(min(a, 1)), 255 * float(min(a, 1)) * .8, 40), -1)
    panels.append(cv2.resize(wv[int(hc[1] - .9 * FW):int(hc[1] + .9 * FW), int(hc[0] - .8 * FW):int(hc[0] + .8 * FW)], (400, 450)))
save(os.path.join(W_DIR, "weights.jpg"), np.vstack([np.hstack(panels[:3]), np.hstack(panels[3:])]))
