"""verify.py <character dir> [--measure]: the quality gate a character must pass before publish.py takes it. It measures
each fault found in the first two characters, on the drawings and through web/rig.js, writes verify.json (the result and
a hash of the folder) and verify.jpg (a contact sheet: a person looks at it, since no number judges a face).
--measure only prints, and changes nothing. Run with playwright, opencv, numpy and pillow."""
import hashlib, json, shutil, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw
from rigpage import NEUTRAL, render

char = Path(sys.argv[1])
measure_only = "--measure" in sys.argv
R = json.load(open(char / "rig.json"))
spec = json.load(open(char / "persona.json"))
parts = {p["name"]: p for p in R["parts"]}
angles = R["angles"]
tex = {}
results = []


def check(name, ok, detail):
    results.append({"check": name, "pass": bool(ok), "detail": detail})


def atlas(f):
    if f not in tex:
        tex[f] = np.asarray(Image.open(char / f).convert("RGBA"), np.float32)
    return tex[f]


def get(p):
    A = atlas(p["tex"])
    u0, v0, u1, v1 = p.get("uv", [0, 0, 1, 1])
    H, W = A.shape[:2]
    return A[round(v0 * H):round(v1 * H), round(u0 * W):round(u1 * W)]


def under(p, head):
    h, pc, hb, pb = get(head), get(p), head["box"], p["box"]
    k = pc.shape[1] / pb[2]
    M = np.float32([[1, 0, (hb[0] - pb[0]) * k], [0, 1, (hb[1] - pb[1]) * k]])
    return cv2.warpAffine(h, M, (pc.shape[1], pc.shape[0]), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))


# ---- the record: without the prompt and the sources a character can't be redone
source = json.load(open(char / "source.json")) if (char / "source.json").exists() else {}
check("source recorded", source.get("prompt") or source.get("lost"), "source.json needs \"prompt\", or \"lost\" saying why it can't")

# ---- every drawing the director can ask for
GAZE = [f"g{x}_{y}" for x in (-12, 0, 12) for y in (-10, 0, 10) if x or y]
want = [f"eyes.{n}" for n in GAZE + ["half", "shut"]] + ["brows.up", "brows.knit"] + [f"mouth.{m}" for m in ("a1", "a2", "a3", "e1", "e2", "o2", "u", "s1", "s2")]
gone = [f"{a}.{w}" for a in angles for w in want if f"{a}.{w}" not in parts]
check("drawings complete", not gone and all(f"pose.{p}" in parts for p in ("think", "read", "write", "explain")), f"missing {gone[:6]}")
no_n = [a for a in angles if f"{a}.mouth.n" not in parts]
blend = R.get("serious") or 0
check("serious mouth unpouted", not no_n or blend <= .6, f"{len(no_n)} angles without mouth.n show u at {blend:.2f} while thinking or in a tool: draw n, or keep --serious at .6 or less")
pitched = [a for a, (_, p) in angles.items() if p >= 12]
check("reading eyes", pitched and all(f"{a}.eyes.r0" in parts for a in pitched), f"bowed angles {pitched}")

# ---- the room is its own layer, the morph is measured, and the app will fetch all of it
room = json.load(open(char / R["room"])) if R.get("room") and (char / R["room"]).exists() else None
check("room separate", room and all(n in {p["name"] for p in room["parts"]} for n in ("plate", "vignette", "glow")) and "plate" not in parts, "plate, vignette and glow in room.json")
files = set(spec.get("files", []))
need = {"rig.json", *(p["tex"] for p in R["parts"])} | ({R["room"], *(p["tex"] for p in room["parts"])} if room else set()) | ({R["flow"]["tex"]} if R.get("flow") else set())
check("files listed", need <= files, f"not in persona.json: {sorted(need - files)[:5]}")
names = list(angles)
neighbours = [(a, b) for i, a in enumerate(names) for b in names[i + 1:] if abs(angles[a][0] - angles[b][0]) <= 8 and abs(angles[a][1] - angles[b][1]) <= 6]
cells = R.get("flow", {}).get("cells", {})
absent = [f"{a}|{b}" for a, b in neighbours if f"{a}|{b}" not in cells and f"{b}|{a}" not in cells]
check("flows measured", cells and len(absent) <= len(neighbours) // 4, f"{len(cells)} pairs, {len(absent)} of {len(neighbours)} neighbours without one")

# ---- the body: no chips of the portrait floating free
b = get(parts["body"])
n, lab, stats, _ = cv2.connectedComponentsWithStats((b[..., 3] > 8).astype(np.uint8), connectivity=8)
check("body in one piece", n == 2, f"{n - 1} pieces")

# ---- the cut edge doesn't carry the portrait's dark room, an outline on any bright background
hd = get(parts["head.y0p0"])
solid = (hd[..., 3] > 128).astype(np.uint8)
ring = lambda r: cv2.erode(solid, np.ones((2 * r + 1, 2 * r + 1), np.uint8))
lum = hd[..., :3].mean(2)
edge_, inside_ = (solid > 0) & (ring(5) == 0), (ring(5) > 0) & (ring(16) == 0)
drop = float(lum[inside_].mean() - lum[edge_].mean())
check("no dark outline", drop < 4, f"the head's outer edge is {drop:.1f} levels darker than just inside it")

# ---- half and shut eyes touch only the lid; knit brows show; mouth drawings reach the jaw line, which they carry
lens, knit, reach_jaw, scraps = [], [], [], []
for a in angles:
    h = parts[f"head.{a}"]
    p = parts.get(f"{a}.mouth.a1")
    if p:
        pc, u = get(p), under(p, h)
        solid = ((u[..., 3] > 128) | (under(p, parts["body"])[..., 3] > 128)).astype(np.uint8)
        scraps.append(float(((pc[..., 3] > 25) & (cv2.dilate(solid, np.ones((23, 23), np.uint8)) == 0)).sum()))
        inside = u[..., 3] > 128
        rim = inside & (cv2.erode(inside.astype(np.uint8), np.ones((15, 15), np.uint8)) == 0)
        low = np.zeros(rim.shape, bool)
        low[pc.shape[0] // 2:, pc.shape[1] // 8:-pc.shape[1] // 8] = True
        if (rim & low).any():
            reach_jaw.append(float(pc[..., 3][rim & low].mean()) / 255)
    for name in ("half", "shut"):
        p = parts.get(f"{a}.eyes.{name}")
        if p:
            pc, u = get(p), under(p, h)
            d = cv2.GaussianBlur(np.abs(pc[..., :3] - u[..., :3]).max(2), (0, 0), 3)
            shown = pc[..., 3] > 76
            lens.append(float(((d < 6) & shown).sum()) / max(1, shown.sum()))
    p = parts.get(f"{a}.brows.knit")
    if p:
        pc, u = get(p), under(p, h)
        w = pc[..., 3:] / 255
        knit.append(float((np.abs(pc[..., :3] - u[..., :3]) * w).sum() / (3 * w.sum())))
check("no scraps of the old room", max(scraps) < 40, f"worst {max(scraps):.0f} px of a mouth drawing over the room, which other backgrounds would show")
check("mouth drawings reach the jaw line", min(reach_jaw) > .6, f"weakest opacity at the jaw {min(reach_jaw):.2f}: fading them there detaches the jaw and cheeks")
check("blink touches only the lid", np.median(lens) < .2, f"{np.median(lens) * 100:.0f}% of a blink's painted area is unchanged")
check("knit brows show", 10 < np.median(knit) < 30, f"median change {np.median(knit):.1f} levels: too little doesn't read, too much looks worried")

# ---- the hand reaches the chin
head = parts["head.y0p0"]
mouth = parts["y0p0.mouth.a1"]["box"]
th = parts["pose.think"]
t = get(th)
sc = t.shape[1] / th["box"][2]
mx0, mx1 = round((mouth[0] - th["box"][0]) * sc), round((mouth[0] + mouth[2] - th["box"][0]) * sc)
col = t[:, max(0, mx0):max(1, mx1), 3] > 128
top = th["box"][1] + (np.argmax(col.any(1)) / sc if col.any() else 1e9)
reach = (mouth[1] + mouth[3] - top) / mouth[3]
check("thinking hand reaches the chin", reach > .3, f"overlaps {reach * 100:.0f}% of the mouth patch's height")

# ---- through the renderer, on a phone's frame
SIZE = (720, 1560)
at = lambda Y=0, P=0, **k: {**NEUTRAL, "yaw": -Y / 12, "pitch": P / 12, **k}
seq = [{"p": at()}] * 20 + [{"p": at(), "shot": "rest"}]
for pose in ("think", "read", "write", "explain"):
    seq += [{"p": at()}] * 10 + [{"p": at(pose=pose), "shot": f"{pose}_in"}] * 3 + [{"p": at(pose=pose)}] * 40 + [{"p": at(pose=pose), "shot": f"{pose}_full"}]
    seq += [{"p": at()}] * 22 + [{"p": at(), "shot": f"{pose}_out"}] + [{"p": at()}] * 15
seq[:] = [dict(s) for s in seq]
SWAPS = {"yaw": ((0, 0), (8, 0)), "pitch": ((0, 0), (0, 6)), "bow": ((0, 6), (0, 12))}
for name, (s, e) in SWAPS.items():
    seq += [{"p": at(*s)}] * 30 + [{"p": at(*s), "shot": f"{name}_before"}]
    seq += [{"p": at(s[0] + (e[0] - s[0]) * i / 89, s[1] + (e[1] - s[1]) * i / 89), "mid": f"{name}_mid"} for i in range(90)]
    seq += [{"p": at(*e)}] * 30 + [{"p": at(*e), "shot": f"{name}_after"}] + [{"p": at(*s)}] * 30
seq += [{"p": at(blinkR=1, blinkL=1)}] * 30 + [{"p": at(blinkR=1, blinkL=1), "shot": "blink"}]
seq += [{"p": at(knit=.8, serious=1)}] * 30 + [{"p": at(knit=.8, serious=1), "shot": "serious"}]
seq += [{"p": at(jaw=.648)}] * 30 + [{"p": at(jaw=.648), "shot": "open"}]
seq += [{"p": at(jaw=.216)}] * 30 + [{"p": at(jaw=.216), "shot": "talk"}]
stage, seen = render(char, seq, SIZE, room=False)
shot = lambda n: cv2.imread(str(stage / f"shots/{n}.jpg"), cv2.IMREAD_UNCHANGED).astype(np.float32)
rest = shot("rest")
popped = {}
for pose in ("think", "read", "write", "explain"):
    popped[pose] = max(float(np.abs(shot(f"{pose}_{w}") - rest)[int(SIZE[1] * .45):].mean()) for w in ("in", "out"))
check("poses don't pop or leave a ghost", max(popped.values()) < .6, f"worst change on their first and last frames {max(popped.values()):.2f} levels")
# the jaw line doesn't jump between rest and talking. A jaw does move: on the professor's rim-lit beard that measures about
# 11, and about 28 when the drawing under the head is missing and the outline changes with every mouth.
hb, vw = head["box"], R["view"]
Wa, Ha = R["size"]
sy_ = SIZE[1] * Wa / (SIZE[0] * Ha)
sx_, sy_ = (1 / sy_, 1) if sy_ > 1 else (1, sy_)
sx_, sy_ = sx_ / vw["zoom"], sy_ / vw["zoom"]
cx_, cy_ = min(max(vw["focus"][0], sx_ / 2), 1 - sx_ / 2), min(max(vw["focus"][1], sy_ / 2), 1 - sy_ / 2)
scale = SIZE[0] / (sx_ * Wa)
ha = cv2.resize(get(head)[..., 3], (round(hb[2] * scale), round(hb[3] * scale)))
hx, hy = round((hb[0] / Wa - cx_) / sx_ * SIZE[0] + SIZE[0] / 2), round((hb[1] / Ha - cy_) / sy_ * SIZE[1] + SIZE[1] / 2)
mask = np.zeros(SIZE[::-1], np.uint8)
y0, y1, x0, x1 = max(0, hy), min(SIZE[1], hy + ha.shape[0]), max(0, hx), min(SIZE[0], hx + ha.shape[1])
mask[y0:y1, x0:x1] = ha[y0 - hy:y1 - hy, x0 - hx:x1 - hx] > 128
band = (cv2.dilate(mask, np.ones((31, 31), np.uint8)) > 0) & (cv2.erode(mask, np.ones((3, 3), np.uint8)) == 0)
band[:round((mouth[1] / Ha - cy_) / sy_ * SIZE[1] + SIZE[1] / 2)] = False
seen_ = lambda i: i[..., :3] * i[..., 3:] / 255
jump = float(np.abs(seen_(shot("talk")) - seen_(rest)).mean(2)[band].mean())
check("jaw line doesn't jump while talking", jump < 18, f"{jump:.1f} levels just outside the lower outline")
al = rest[..., 3:] / 255
from common import MODEL, landmarks
lm = landmarks((rest[..., :3] * al + 120 * (1 - al))[..., ::-1], MODEL)
face = float(np.linalg.norm(lm[454, :2] - lm[234, :2])) / SIZE[0]
check("face the same size as the others'", .42 < face < .54, f"{face:.2f} of a phone's width; the first two are .48 and .49")
check("character alone is transparent", rest[0, 0, 3] == 0 and rest[5, SIZE[0] - 5, 3] == 0, "corners of a room-less frame")
lap = lambda i: cv2.Laplacian(cv2.cvtColor(i[..., :3].astype(np.uint8), cv2.COLOR_BGR2GRAY), cv2.CV_32F)
ratios = {}
for name in SWAPS:
    mid = stage / f"shots/{name}_mid.jpg"
    if mid.exists():
        ends = [shot(f"{name}_{e}") for e in ("before", "after")]
        ys, xs = np.nonzero(rest[..., 3] > 128)
        region = (ys.min(), ys.min() + (ys.max() - ys.min()) // 2)
        en = lambda i: float(lap(i)[region[0]:region[1]].var())
        ratios[name] = en(shot(f"{name}_mid")) / (sum(en(e) for e in ends) / 2)
check("head swaps stay sharp", ratios and min(ratios.values()) > .75, "sharpness mid-swap against the ends: " + ", ".join(f"{k} {v:.2f}" for k, v in ratios.items()))

# ---- the contact sheet
cells_ = ["rest", "serious", "talk", "open", "blink", "think_full", "read_full", "write_full", "explain_full", "yaw_mid", "pitch_mid", "bow_mid"]
W_, H_ = SIZE[0] // 3, SIZE[1] // 3
sheet = Image.new("RGB", (6 * W_, 2 * (H_ + 18)), (40, 40, 44))
pen = ImageDraw.Draw(sheet)
for i, n in enumerate(cells_):
    f = stage / f"shots/{n}.jpg"
    if f.exists():
        im = Image.open(f).convert("RGBA").resize((W_, H_))
        bg = Image.new("RGBA", im.size, (70, 70, 76, 255))
        bg.alpha_composite(im)
        sheet.paste(bg.convert("RGB"), ((i % 6) * W_, (i // 6) * (H_ + 18) + 18))
    pen.text(((i % 6) * W_ + 3, (i // 6) * (H_ + 18) + 3), n, fill=(240, 220, 120))
shutil.rmtree(stage)

passed = all(r["pass"] for r in results)
for r in results:
    print("ok  " if r["pass"] else "FAIL", r["check"], "-", r["detail"])
print("PASS" if passed else "FAIL", char)
if not measure_only:
    sheet.save(char / "verify.jpg", quality=85)


def folder_hash(d):
    h = hashlib.sha256()
    for f in sorted(p for p in Path(d).rglob("*") if p.is_file() and p.name not in ("verify.json", "verify.jpg")):
        h.update(f.relative_to(d).as_posix().encode())
        h.update(f.read_bytes())
    return h.hexdigest()


if not measure_only:
    json.dump({"pass": passed, "hash": folder_hash(char), "results": results}, open(char / "verify.json", "w"), indent=1)
sys.exit(0 if passed else 1)
