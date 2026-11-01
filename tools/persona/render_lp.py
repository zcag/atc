"""Renders the portrait through LivePortrait's image retargeting for each parameter set in a JSON list
({"name", ...params}), pasted back into the full portrait. Run from the LivePortrait checkout:
render_lp.py <portrait> <params.json> <out dir>"""
import json, sys, time
from pathlib import Path
import types
import cv2
sys.modules["gradio"] = types.SimpleNamespace(Error=Exception, Info=print, Warning=print)
from src.config.argument_config import ArgumentConfig
from src.config.crop_config import CropConfig
from src.config.inference_config import InferenceConfig
import src.gradio_pipeline as gp

load = gp.load_img_online
gp.load_img_online = lambda img, mode="rgb", **kw: load(img, mode=mode, max_dim=2048, n=2)

DEFAULTS = dict(eye=None, lip=None, pitch=0., yaw=0., roll=0., mov_x=0., mov_y=0., mov_z=1., pout=0., woo=0., eee=0.,
                aaa=0., smile=0., wink=0., brow=0., gx=0., gy=0.)


def fields(cls, d):
    return cls(**{k: v for k, v in d.items() if hasattr(cls, k)})


portrait, params, out = sys.argv[1], json.load(open(sys.argv[2])), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
args = ArgumentConfig()
pipe = gp.GradioPipeline(inference_cfg=fields(InferenceConfig, args.__dict__), crop_cfg=fields(CropConfig, args.__dict__), args=args)
scale = 2.3
eye0, lip0 = pipe.init_retargeting_image(scale, 0, 0, portrait)
print("source eye/lip ratio", eye0, lip0, flush=True)
for p in params:
    q = {**DEFAULTS, **p}
    t = time.time()
    _, full = pipe.execute_image_retargeting(
        q["eye"] if q["eye"] is not None else eye0, q["lip"] if q["lip"] is not None else lip0,
        q["pitch"], q["yaw"], q["roll"], q["mov_x"], q["mov_y"], q["mov_z"], q["pout"], q["woo"], q["eee"], q["aaa"],
        q["smile"], q["wink"], q["brow"], q["gx"], q["gy"], portrait, scale)
    cv2.imwrite(str(out / f"{p['name']}.png"), cv2.cvtColor(full, cv2.COLOR_RGB2BGR))
    print(p["name"], round(time.time() - t, 2), flush=True)
