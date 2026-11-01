import sys, json, base64, urllib.request, pathlib
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
subj = ("a warm, kind academic man in his mid fifties, completely bald head, short neat grey beard, round thin gold-rimmed glasses, "
        "wearing a soft brown knit cardigan over a light collared shirt, head and shoulders portrait, facing the viewer directly, "
        "looking straight into the camera, gentle closed-mouth expression, relaxed, centered, head in the upper third, ")
room = "in a cozy study with wooden bookshelves and a warm desk lamp, background softly out of focus, "
styles = {
 "paint": "painterly digital illustration, visible soft brush strokes, warm golden light, rich colors, high quality concept art",
 "gouache": "gouache storybook illustration, soft textured paint, warm muted palette, gentle rim light, beautiful character design",
 "anime": "hand-painted animated film still, soft cel shading, painted background, warm evening light, studio-quality character art",
 "oil": "classical oil painting portrait, loose impressionistic brushwork, warm chiaroscuro, painterly, museum quality",
}
jobs = [(f"{k}-{seed}", subj + room + s + ".", seed) for k, s in styles.items() for seed in (11, 42)]
if len(sys.argv) > 2:
    jobs = json.load(open(sys.argv[2]))
for name, prompt, seed in jobs:
    p = out / f"{name}.png"
    if p.exists(): continue
    body = json.dumps({"model": "flux2-klein-4b", "prompt": prompt + " No text, no letters.", "size": "768x1344", "response_format": "b64_json", "seed": seed}).encode()
    r = urllib.request.urlopen(urllib.request.Request("http://gpu.example:11437/v1/images/generations", body, {"Content-Type": "application/json"}), timeout=600)
    p.write_bytes(base64.b64decode(json.load(r)["data"][0]["b64_json"]))
    print(name, flush=True)
