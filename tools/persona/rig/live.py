"""Plays a simulated call through the app's own path (persona.js -> rig.js, requestAnimationFrame) in real time,
records it with the browser's video recorder, prints the frame pacing, and muxes the call audio.
Usage: live.py <character dir> <out.mp4>"""
import os, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

here = Path(__file__).resolve().parent
web = here.parents[2] / "web"
work = Path(os.environ.get("PERSONA_WORK", Path.home() / ".local/share/persona2d"))
C = work / "rig/live"
src, out = Path(sys.argv[1]), sys.argv[2]
shutil.rmtree(C, ignore_errors=True)
C.mkdir(parents=True)
for f in ("persona.js", "rig.js", "motion.js", "minimal.js"):
    shutil.copy(web / f, C)
shutil.copy(here / "live.html", C)
shutil.copy(work / "clip/timeline.json", C)
shutil.copytree(src, C / "p")
srv = subprocess.Popen(["python3", str(here.parent / "serve.py"), str(C), str(C / "frames")])
time.sleep(1)
vids = C / "vid"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist"])
        ctx = b.new_context(viewport={"width": 432, "height": 936}, device_scale_factor=2.5, record_video_dir=str(vids), record_video_size={"width": 432, "height": 936})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: print("pageerror", e))
        pg.on("console", lambda m: print("console", m.text))
        t = time.time()
        pg.goto("http://127.0.0.1:8932/live.html")
        pg.wait_for_function("document.title == 'go'", timeout=60000)
        lead = time.time() - t
        pg.wait_for_function("document.title == 'done'", timeout=120000)
        ctx.close()
        b.close()
finally:
    srv.kill()
raw = next(vids.glob("*.webm"))
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{lead:.2f}", "-i", str(raw), "-i", str(work / "clip/mix.wav"), "-c:v", "libx264", "-crf", "18",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", out], check=True)
print(out, "lead", round(lead, 2))
