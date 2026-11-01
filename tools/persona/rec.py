import sys, time
from playwright.sync_api import sync_playwright
url = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                          args=["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 800, "height": 1400})
    pg.on("console", lambda m: print("console", m.type, m.text, flush=True))
    pg.on("pageerror", lambda e: print("pageerror", e, flush=True))
    pg.goto("http://127.0.0.1:8932/gpu.html")
    print(pg.evaluate("() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }"), flush=True)
    pg.goto(url)
    t = time.time()
    while pg.title() != "done" and time.time() - t < float(sys.argv[2]):
        time.sleep(2)
    print("title", pg.title(), round(time.time() - t), flush=True)
    b.close()
