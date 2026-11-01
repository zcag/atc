import json, numpy as np, cv2
from PIL import Image

EYE = {
    "R": [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
    "L": [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
}
IRIS = {"R": 468, "L": 473}
LIP_UP_IN = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
LIP_LO_IN = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
LIP_OUT = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
BROW = {"R": [70, 63, 105, 66, 107, 55, 65, 52, 53, 46], "L": [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]}


def landmarks(path, k=2):
    return np.array(json.load(open(path))["pts"]) * k


def load(path, mode="RGB"):
    return np.array(Image.open(path).convert(mode)).astype(np.float32)


def save(path, a, mode=None):
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), mode).save(path)


def poly_mask(shape, pts, val=1):
    m = np.zeros(shape[:2], np.uint8)
    cv2.fillPoly(m, [np.round(pts).astype(np.int32)], val)
    return m


def iris_radius(P, side):
    c = IRIS[side]
    return (np.linalg.norm(P[c + 1] - P[c + 3]) + np.linalg.norm(P[c + 2] - P[c + 4])) / 4
