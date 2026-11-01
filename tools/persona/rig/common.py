import os, json, numpy as np, cv2
from PIL import Image

EYE = {
    "R": [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
    "L": [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
}
IRIS = {"R": 468, "L": 473}
LIP_OUT = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
BROW = {"R": [70, 63, 105, 66, 107, 55, 65, 52, 53, 46], "L": [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]}
HEAD_CLASSES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15]
HERE = os.path.dirname(os.path.abspath(__file__))


def load(path, mode="RGB"):
    return np.array(Image.open(path).convert(mode)).astype(np.float32)


def save(path, a, mode=None):
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), mode).save(path)


def poly_mask(shape, pts, val=1):
    m = np.zeros(shape[:2], np.uint8)
    cv2.fillPoly(m, [np.round(pts).astype(np.int32)], val)
    return m


_lm = None


def landmarks(img, model):
    """MediaPipe face landmarks of an RGB float image: (478, 3) pixel coordinates, z toward the camera negative."""
    global _lm
    import mediapipe as mp
    from mediapipe.tasks.python import vision, BaseOptions
    _lm = _lm or vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=model)))
    h, w = img.shape[:2]
    r = _lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(img.astype(np.uint8))))
    return np.array([[p.x * w, p.y * h, p.z * w] for p in r.face_landmarks[0]])


_seg = None


def parse(img):
    """Face parsing labels (CelebAMask-HQ classes) of an RGB float image."""
    global _seg
    import torch
    from transformers import SegformerImageProcessor, SegformerForSemanticSegmentation
    if _seg is None:
        name = "jonathandinu/face-parsing"
        _seg = SegformerImageProcessor.from_pretrained(name), SegformerForSemanticSegmentation.from_pretrained(name)
    proc, model = _seg
    with torch.no_grad():
        logits = model(**proc(images=Image.fromarray(img.astype(np.uint8)), return_tensors="pt")).logits
    up = torch.nn.functional.interpolate(logits, size=img.shape[:2], mode="bilinear")
    return up.argmax(1)[0].numpy().astype(np.uint8)


def head_mask(lab):
    """The head (face, scalp, ears, glasses, beard) as one solid region."""
    m = np.isin(lab, HEAD_CLASSES).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    n, cc, st, _ = cv2.connectedComponentsWithStats(m)
    m = (cc == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    out = np.zeros_like(m)
    cv2.drawContours(out, cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], -1, 1, -1)
    return out
