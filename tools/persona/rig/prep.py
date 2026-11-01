"""prep.py <character dir>: from its portrait (base.png, 768x1344) everything build.py needs besides the drawings:
base2.png (2x, Real-ESRGAN), matte.png (the figure: a coarse person mask, refined by SAM inside its box),
fill_plate.png (the room without the figure, LaMa), fill_body.png (the figure without the head, LaMa), crop.png and
crop.json (the head and hair with a margin, what LivePortrait renders the drawings from), and
char.json with where the lamp is (the brightest spot of the room). Steps whose file exists are skipped."""
import sys, os, json, subprocess, tempfile, numpy as np, cv2, torch
from PIL import Image
from common import *

C = sys.argv[1]
c = lambda f: os.path.join(C, f)
base1 = load(c("base.png"))
H1, W1 = base1.shape[:2]

if not os.path.exists(c("base2.png")):
    with tempfile.TemporaryDirectory() as t:
        subprocess.run([f"{ESR}/realesrgan-ncnn-vulkan", "-i", c("base.png"), "-o", f"{t}/x4.png", "-n", "realesrgan-x4plus", "-m", f"{ESR}/models"], check=True, capture_output=True)
        Image.open(f"{t}/x4.png").convert("RGB").resize((W1 * 2, H1 * 2), Image.LANCZOS).save(c("base2.png"))
base = load(c("base2.png"))
H, W = base.shape[:2]

if not os.path.exists(c("matte.png")):
    import mediapipe as mp
    from mediapipe.tasks.python import vision, BaseOptions
    path = f"{RIG}/selfie_multiclass.tflite"
    if not os.path.exists(path):
        import urllib.request
        urllib.request.urlretrieve("https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite", path)
    seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(base_options=BaseOptions(model_asset_path=path), output_confidence_masks=True))
    conf = seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(base1.astype(np.uint8)))).confidence_masks[0].numpy_view()
    coarse = (1 - np.squeeze(conf)) > .5
    ys, xs = np.nonzero(coarse)
    box = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    from transformers import SamModel, SamProcessor
    sam, samp = SamModel.from_pretrained("facebook/sam-vit-base"), SamProcessor.from_pretrained("facebook/sam-vit-base")
    inp = samp(Image.fromarray(base1.astype(np.uint8)), input_boxes=[[box]], return_tensors="pt")
    with torch.no_grad():
        o = sam(**inp)
    masks = samp.image_processor.post_process_masks(o.pred_masks, inp["original_sizes"], inp["reshaped_input_sizes"])[0][0].numpy()
    fine = max(masks, key=lambda m: (m & coarse).sum() - 2 * (m & ~coarse).sum())
    m = cv2.morphologyEx((fine | (cv2.erode(coarse.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0)).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.GaussianBlur(cv2.resize(m.astype(np.float32), (W, H), interpolation=cv2.INTER_LINEAR), (0, 0), 1.5)
    save(c("matte.png"), np.dstack([np.zeros((H, W, 3)), m * 255]), "RGBA")
matte = np.array(Image.open(c("matte.png")).convert("RGBA"))[..., 3].astype(np.float32) / 255
matte = cv2.resize(matte, (W, H)) if matte.shape != (H, W) else matte


def inpaint(img, mask, scale=.5):
    from simple_lama_inpainting import SimpleLama
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA).astype(np.uint8)
    sm = cv2.resize(mask.astype(np.uint8) * 255, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    out = np.array(SimpleLama()(Image.fromarray(small), Image.fromarray(sm)))[: small.shape[0], : small.shape[1]].astype(np.float32)
    out = cv2.resize(out, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_CUBIC)
    k = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 2)[..., None]
    return out * k + img * (1 - k)


if not os.path.exists(c("fill_plate.png")):
    save(c("fill_plate.png"), inpaint(base, cv2.dilate((matte > .5).astype(np.uint8), np.ones((31, 31), np.uint8)) > 0))
if not os.path.exists(c("fill_body.png")):
    save(c("fill_body.png"), inpaint(base, cv2.dilate(head_mask(parse(base)), np.ones((9, 9), np.uint8)) > 0))
if not os.path.exists(c("crop.json")):
    ys, xs = np.nonzero(head_mask(parse(base)))
    P = landmarks(base, MODEL)
    pad = int(.3 * np.linalg.norm(P[454, :2] - P[234, :2]))
    x0, y0, x1, y1 = max(0, xs.min() - pad), max(0, ys.min() - pad), min(W, xs.max() + pad), min(H, ys.max() + pad, ys.min() - pad + 2040)
    x0, y0, x1, y1 = (int(v) // 2 * 2 for v in (x0, y0, x1, y1))
    save(c("crop.png"), base[y0:y1, x0:x1])
    json.dump({"box": [x0, y0, x1, y1]}, open(c("crop.json"), "w"))
if not os.path.exists(c("char.json")):
    lum = cv2.GaussianBlur(load(c("fill_plate.png")).mean(2), (0, 0), 25) * (matte < .1)
    y, x = np.unravel_index(np.argmax(lum), lum.shape)
    json.dump({"lamp": [int(x), int(y)]}, open(c("char.json"), "w"))
print(json.load(open(c("char.json"))))
