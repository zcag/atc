"""publish.py <character dir> <name> [--sources <work dir>]: puts a built character where atc serves it (/app/personas/<name>/)
and bumps its rev in index.json, so phones fetch the new files. The default character is left as it is.

It takes only a character that passed verify.py as it is now. A new one also needs --sources: its portrait, matte, fills
and pose layers are copied to $PERSONA_SOURCES/<name> (default $PERSONA_WORK/sources), since without them it can never be
redrawn. Point that somewhere backed up."""
import hashlib, json, os, shutil, sys
from pathlib import Path

args = sys.argv[1:]
work = None
if "--sources" in args:
    i = args.index("--sources")
    work = Path(args[i + 1])
    del args[i:i + 2]
src, name = Path(args[0]), args[1]


def folder_hash(d):
    h = hashlib.sha256()
    for f in sorted(p for p in Path(d).rglob("*") if p.is_file() and p.name not in ("verify.json", "verify.jpg")):
        h.update(f.relative_to(d).as_posix().encode())
        h.update(f.read_bytes())
    return h.hexdigest()


report = src / "verify.json"
sys.exit(f"{src} has no verify.json: run verify.py first") if not report.exists() else None
v = json.load(open(report))
if not v["pass"]:
    sys.exit("verify.py failed: " + ", ".join(r["check"] for r in v["results"] if not r["pass"]))
if v["hash"] != folder_hash(src):
    sys.exit(f"{src} changed since verify.py passed: run it again")
source = json.load(open(src / "source.json"))
store = Path(os.environ.get("PERSONA_SOURCES") or Path(os.environ.get("PERSONA_WORK", Path.home() / ".local/share/persona2d")) / "sources") / name
if work:
    store.mkdir(parents=True, exist_ok=True)
    for pattern in ("base*.png", "matte.png", "fill_*.png", "crop.*", "char.json", "pose_*.png", "*.json"):
        for f in work.glob(pattern):
            shutil.copy(f, store)
    shutil.copy(src / "source.json", store)
elif not source.get("lost") and not store.exists():
    sys.exit(f"nothing archived in {store}: pass --sources <work dir>")
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
