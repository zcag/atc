"""Gives one session a tab in the demo's own Chromium: opens the shop and records the session as its owner in browser.json."""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

cdp, url = sys.argv[1:3]
atc = Path(os.environ["HOME"]) / ".config/atc"
for _ in range(50):
    try:
        req = urllib.request.Request(f"{cdp}/json/new?{url}", method="PUT")
        tab = json.load(urllib.request.urlopen(req, timeout=2))
        break
    except OSError:
        time.sleep(.2)
else:
    sys.exit("demo browser did not start")
at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
(atc / "browser.json").write_text(json.dumps({tab["id"]: {"session": (atc / "demo-browser-session").read_text().strip(), "at": at}}))
