"""pack.py <personas dir> <dist dir>: the release's personas.tar.gz, which `atc app update` unpacks, and its checksum in
<dist>/version.json. It takes the published characters except those whose source.json marks them private (a real
person's face), and only rooms whose settings record where they came from, so someone's uploads never reach a release."""
import hashlib, io, json, sys, tarfile
from pathlib import Path

src, dist = Path(sys.argv[1]), Path(sys.argv[2])
index = json.loads((src / "index.json").read_text())
private = lambda d: (d / "source.json").exists() and json.loads((d / "source.json").read_text()).get("private")
index["personas"] = [p for p in index["personas"] if not private(src / p["name"])]
names = []
for p in index["personas"]:
    d = src / p["name"]
    spec = json.loads((d / "persona.json").read_text())
    if spec.get("kind") == "rig":
        v = json.loads((d / "verify.json").read_text()) if (d / "verify.json").exists() else {}
        if not v.get("pass"):
            sys.exit(f"{p['name']} has not passed verify.py")
    names += [f"{p['name']}/persona.json", *(f"{p['name']}/{f}" for f in spec.get("files", [])), *([f"{p['name']}/source.json"] if (d / "source.json").exists() else [])]
for f in sorted((src / "_rooms").glob("*.json")):
    if json.loads(f.read_text()).get("source"):
        names += [f"_rooms/{f.name}", *(f"_rooms/{p.name}" for p in f.parent.glob(f.stem + ".*") if p.suffix != ".json")]
out = io.BytesIO()
with tarfile.open(fileobj=out, mode="w:gz") as t:
    listing = json.dumps(index).encode()
    info = tarfile.TarInfo("index.json")
    info.size = len(listing)
    t.addfile(info, io.BytesIO(listing))
    for n in sorted(set(names)):
        t.add(src / n, arcname=n, recursive=False)
dist.mkdir(parents=True, exist_ok=True)
(dist / "personas.tar.gz").write_bytes(out.getvalue())
version = dist / "version.json"
if version.exists():
    v = json.loads(version.read_text())
    v["personasSha256"] = hashlib.sha256(out.getvalue()).hexdigest()
    version.write_text(json.dumps(v))
print(f"{len(set(names)) + 1} files, {len(out.getvalue()) >> 20} MB:", sorted(n for n in set(names) if n.startswith("_rooms/") and not n.endswith(".json")))
