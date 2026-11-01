"""masks.py <out dir> <angle> <sheet.jpg>: every feature patch of one head angle composited over its head drawing,
in a grid, plus the patch masks, to check that each swap covers what it changes."""
import sys, json, numpy as np
from PIL import Image

out, angle, dst = sys.argv[1:4]
R = json.load(open(f"{out}/rig.json"))
atlas = Image.open(f"{out}/head_{angle}.webp").convert("RGBA")
A = np.array(atlas).astype(np.float32)
parts = [p for p in R["parts"] if p.get("angle") == angle]


def piece(p):
    u0, v0, u1, v1 = p["uv"]
    H, W = A.shape[:2]
    a = A[round(v0 * H):round(v1 * H), round(u0 * W):round(u1 * W)]
    x, y, w, h = p["box"]
    return Image.fromarray(a.astype(np.uint8)).resize((round(w), round(h))), (round(x), round(y))


head = next(p for p in parts if p["name"].startswith("head."))
img, (hx, hy) = piece(head)
cells = []
for p in [p for p in parts if "slot" in p]:
    c = Image.new("RGBA", img.size, (30, 30, 40, 255))
    c.alpha_composite(img)
    pc, (x, y) = piece(p)
    c.alpha_composite(pc, (x - hx, y - hy))
    m = Image.new("RGBA", pc.size, (255, 0, 0, 0))
    m.putalpha(pc.getchannel("A").point(lambda v: v // 3))
    c.alpha_composite(m, (x - hx, y - hy))
    cells.append((p["name"], c.convert("RGB").resize((img.width // 3, img.height // 3))))
cw, ch = cells[0][1].size
cols = 7
sheet = Image.new("RGB", (cols * cw, ((len(cells) + cols - 1) // cols) * ch))
for i, (n, c) in enumerate(cells):
    sheet.paste(c, ((i % cols) * cw, (i // cols) * ch))
sheet.save(dst)
print([n for n, _ in cells])
