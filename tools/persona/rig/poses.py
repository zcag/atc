"""poses.py <work dir> <poses dir> <out dir> name=file=x0,y0,x1,y1;... ...: cuts the arm, hand and prop out of image edits of
the portrait (hand to the chin, a notebook, a pen) as layers for the rig: SAM masks from boxes around each piece (1x
coordinates) where the edit changed the picture, never above the lower lip inside the face (the edit repaints the face slightly)
and, with --grey-beard, never the grey of the beard (without a grey beard that rule only bites holes in fingernails),
upscaled to the rig's 2x with Real-ESRGAN. Writes
<out>/pose_<name>.png (full 2x frame, RGBA) for build.py."""
import sys, os, subprocess, tempfile, numpy as np, cv2
from PIL import Image
from common import *

grey_beard = "--grey-beard" in sys.argv
args = [v for v in sys.argv[1:] if v != "--grey-beard"]
W_DIR, P_DIR, OUT = args[:3]
base1 = load(os.path.join(W_DIR, "base.png"))
H1, W1 = base1.shape[:2]
P = landmarks(base1, MODEL)
face = cv2.dilate(poly_mask(base1.shape, P[OVAL, :2]), np.ones((9, 9), np.uint8)) > 0
below_lip = P[17, 1] + 30
beard = cv2.dilate(face.astype(np.uint8), np.ones((51, 51), np.uint8)) > 0
import torch
from transformers import SamModel, SamProcessor
sam, samp = SamModel.from_pretrained("facebook/sam-vit-base"), SamProcessor.from_pretrained("facebook/sam-vit-base")


def segment(img, boxes):
    """For each box (x0, y0, x1, y1) at 1x, the SAM mask that fills most of it and spills least, united."""
    out = np.zeros(img.shape[:2], bool)
    for b in boxes:
        inp = samp(Image.fromarray(img.astype(np.uint8)), input_boxes=[[b]], return_tensors="pt")
        with torch.no_grad():
            o = sam(**inp)
        masks = samp.image_processor.post_process_masks(o.pred_masks, inp["original_sizes"], inp["reshaped_input_sizes"])[0][0]
        inbox = np.zeros(img.shape[:2], bool)
        inbox[b[1]:b[3], b[0]:b[2]] = True
        out |= max((m.numpy() for m in masks), key=lambda m: (m & inbox).sum() - 2 * (m & ~inbox).sum())
    return out


for spec in args[3:]:
    name, f, boxes = spec.split("=")
    edit = load(os.path.join(P_DIR, f))
    changed = cv2.dilate((cv2.GaussianBlur(np.abs(edit - base1).max(2), (0, 0), 2) > 20).astype(np.uint8), np.ones((25, 25), np.uint8))
    keep = (segment(edit, [[int(v) for v in q.split(",")] for q in boxes.split(";")]) & (changed > 0)).astype(np.uint8)
    keep[face & (np.mgrid[0:H1, 0:W1][0] < below_lip)] = 0
    if grey_beard:
        hsv = cv2.cvtColor(edit.astype(np.uint8), cv2.COLOR_RGB2HSV)
        keep[beard & (hsv[..., 1] < 75)] = 0
    keep = cv2.morphologyEx(keep, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, cc, st, _ = cv2.connectedComponentsWithStats(keep)
    keep = np.isin(cc, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] > 800]).astype(np.uint8)
    filled = np.zeros_like(keep)
    cv2.drawContours(filled, cv2.findContours(keep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], -1, 1, -1)
    keep = filled
    a = cv2.GaussianBlur(cv2.dilate(keep, np.ones((3, 3), np.uint8)).astype(np.float32), (0, 0), 1.2)
    with tempfile.TemporaryDirectory() as t:
        Image.fromarray(edit.astype(np.uint8)).save(f"{t}/in.png")
        subprocess.run([f"{ESR}/realesrgan-ncnn-vulkan", "-i", f"{t}/in.png", "-o", f"{t}/out.png", "-n", "realesrgan-x4plus", "-m", f"{ESR}/models"], check=True, capture_output=True)
        up = np.array(Image.open(f"{t}/out.png").convert("RGB").resize((W1 * 2, H1 * 2), Image.LANCZOS)).astype(np.float32)
    a2 = cv2.resize(a, (W1 * 2, H1 * 2), interpolation=cv2.INTER_LINEAR)
    save(os.path.join(OUT, f"pose_{name}.png"), np.dstack([up, a2 * 255]), "RGBA")
    ys, xs = np.nonzero(a2 > .1)
    print(name, "box", xs.min(), ys.min(), xs.max(), ys.max())
