"""drawings.py <out.json>: the drawing library rendered by LivePortrait (render_lp.py) from the one portrait, so
every drawing keeps the same painting: for each head angle its neutral drawing plus eyes (gaze grid, half shut,
shut, reading: hard down at a page held low), brows (up, knit) and mouth shapes (open a/o/e at three sizes, a small u, two smiles, a neutral one for thinking).
The bowed y0p12 angle is for reading and writing. Names are <angle>.<drawing>."""
import json, sys

ANGLES = {f"y{y}p{p}": dict(yaw=y, pitch=p) for p in (-6, 0, 6) for y in (-8, 0, 8)}
FEATURES = {"base": {}}
for gx in (-12, 0, 12):
    for gy in (-10, 0, 10):
        if gx or gy:
            FEATURES[f"eyes.g{gx}_{gy}"] = dict(gx=gx, gy=gy)
FEATURES |= {"eyes.half": dict(eye=.12), "eyes.shut": dict(eye=0.)}
FEATURES |= {"brows.up": dict(brow=10), "brows.knit": dict(brow=-10)}
FEATURES |= {
    "mouth.a1": dict(aaa=18), "mouth.a2": dict(aaa=36), "mouth.a3": dict(aaa=58),
    "mouth.o1": dict(aaa=20, woo=10), "mouth.o2": dict(aaa=42, woo=10),
    "mouth.e1": dict(aaa=16, eee=8), "mouth.e2": dict(aaa=34, eee=8),
    "mouth.u": dict(aaa=4, woo=14, pout=.04),
    "mouth.s1": dict(smile=.55), "mouth.s2": dict(smile=1.0, aaa=4), "mouth.n": dict(smile=-.35),
}
ANGLES["y0p12"] = dict(yaw=0, pitch=12)
READ = {f"eyes.r{gx}": dict(gx=gx, gy=-16) for gx in (-12, 0)}
P = [{"name": f"{a}.{f}", **pa, **pf} for a, pa in ANGLES.items() for f, pf in FEATURES.items()]
P += [{"name": f"{a}.{f}", **ANGLES[a], **pf} for a in ("y-8p6", "y0p6", "y8p6", "y0p12") for f, pf in READ.items()]
json.dump(P, open(sys.argv[1], "w"))
print(len(P), "drawings")
