import json, sys, time
from pathlib import Path
from mflux.models.common.config.model_config import ModelConfig
from mflux.models.flux2.variants import Flux2KleinEdit
import mlx.core as mx

root = Path(sys.argv[1])
jobs = json.load(open(root / sys.argv[2]))
model = Flux2KleinEdit(model_config=ModelConfig.from_name("flux2-klein-4b"), quantize=8)
for name, src, prompt, seed in jobs:
    out = root / "out" / f"{name}.png"
    if out.exists():
        continue
    t = time.time()
    img = model.generate_image(seed=seed, prompt=prompt, width=768, height=1344, guidance=1.0,
                               image_paths=[root / src], num_inference_steps=4)
    out.parent.mkdir(exist_ok=True)
    img.image.save(out)
    mx.clear_cache()
    print(name, round(time.time() - t, 1), flush=True)
