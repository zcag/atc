"""Draws a character through web/rig.js in headless Chromium from a list of frames, each {"p": params, "shot": name} or
{"p": params, "mid": name} (saved once, halfway through a dissolve between two head angles). Shots are PNGs with alpha."""
import json, os, shutil, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

here = Path(__file__).resolve().parent
web = here.parents[2] / "web"
NEUTRAL = dict(yaw=0, pitch=0, roll=0, sway=0, lean=0, breath=.5, gazeX=0, gazeY=0, blinkR=0, blinkL=0, brow=0, knit=0, smile=0, jaw=0, round=0, wide=0, serious=0, pose=None)
PAGE = """<!doctype html><canvas id="c" width="%d" height="%d"></canvas><script type="module">
import { rig } from "./rig.js";
const seq = await (await fetch("seq.json")).json(), c = document.getElementById("c"), seen = {}, done = new Set();
let i = 0, dir = null;
const save = async (name) => { const blob = await new Promise((r) => c.toBlob(r, "image/png")); await fetch("/f/" + name, { method: "POST", body: blob }); };
const frame = await rig(c, "./p/", () => ({ state: "listening" }), { dt: 1 / 60, room: %s, params: () => seq[i].p, tick: (p, d) => { dir = d; } });
for (; i < seq.length; i++) {
  frame(i * 1000 / 60);
  if (seq[i].shot) { seen[seq[i].shot] = dir.angle.cur; await save(seq[i].shot); }
  if (seq[i].mid && !done.has(seq[i].mid) && dir.angle.prev && dir.angle.k >= .45) { done.add(seq[i].mid); seen[seq[i].mid] = dir.angle.cur; await save(seq[i].mid); }
}
await fetch("/f/states", { method: "POST", body: JSON.stringify(seen) });
document.title = "done";
</script>"""


def render(char, seq, size, room=False, rewrite=None, port=8933):
    """Returns (folder of shots, {shot: head angle}). The caller removes the folder's parent, returned as stage."""
    stage = Path(tempfile.mkdtemp(prefix="rigpage"))
    shutil.copy(web / "rig.js", stage)
    shutil.copy(web / "motion.js", stage)
    shutil.copytree(char, stage / "p")
    if rewrite:
        R = json.load(open(stage / "p/rig.json"))
        json.dump(rewrite(R), open(stage / "p/rig.json", "w"))
    json.dump(seq, open(stage / "seq.json", "w"))
    (stage / "index.html").write_text(PAGE % (size[0], size[1], "undefined" if room else "false"))
    srv = subprocess.Popen(["python3", str(here.parent / "serve.py"), str(stage), str(stage / "shots"), str(port)])
    time.sleep(1)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=os.environ.get("CHROME_BIN", "/usr/bin/chromium"), headless=True, args=["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
            pg = b.new_page(viewport={"width": 800, "height": 1600})
            pg.on("pageerror", lambda e: print("pageerror", e, flush=True))
            pg.goto(f"http://127.0.0.1:{port}/index.html")
            t = time.time()
            while pg.title() != "done" and time.time() - t < 900:
                time.sleep(1)
            assert pg.title() == "done", "the page did not finish"
            b.close()
    finally:
        srv.kill()
    return stage, json.load(open(stage / "shots/states"))
