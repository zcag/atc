"""publish.py <character dir> <name>: puts a built character where atc serves it (/app/personas/<name>/) and bumps
its rev in index.json, so phones fetch the new files. The default character is left as it is."""
import json, shutil, sys
from pathlib import Path

src, name = Path(sys.argv[1]), sys.argv[2]
root = Path.home() / ".local/share/atc/app/personas"
dst = root / name
shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(src, dst)
index = json.loads((root / "index.json").read_text())
entry = next((p for p in index["personas"] if p["name"] == name), None)
if entry is None:
    entry = {"name": name, "rev": "0"}
    index["personas"].append(entry)
entry["rev"] = str(int(entry["rev"]) + 1)
(root / "index.json").write_text(json.dumps(index))
print(name, "rev", entry["rev"], sorted(p.name for p in dst.iterdir()))
