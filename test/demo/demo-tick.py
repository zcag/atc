"""Keeps the demo's working sessions alive: a fresh line in each transcript every few seconds, so "updated" moves as it does for a session that is really working."""
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

home = Path(os.environ["HOME"])
while True:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for p in json.loads((home / ".claude/demo-tick.json").read_text()):
        with open(p, "a") as f:
            f.write(json.dumps({"type": "permission-mode", "permissionMode": "default", "timestamp": now, "uuid": str(uuid.uuid4())}) + "\n")
    time.sleep(4)
