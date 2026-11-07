#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["huggingface_hub"]
# ///
"""Everything a call needs on disk, for the languages and voice engines in the environment (TALK_LANG, TALK_ALSO,
TTS_ENGINES): the VAD model, each language's streaming STT, the TTS venv and its weights.
Safe to run again: what is there stays. A venv with no record of its engines was made by hand and is left alone."""
import os, subprocess, sys, urllib.request
from huggingface_hub import hf_hub_download
from langpack import Pack

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.expanduser(os.environ.get("TALK_MODELS") or "~/.cache/atc/voice")
VENV = os.path.expanduser(os.environ.get("TTS_VENV") or "~/.local/share/atc/voice/tts-venv")
TORCH = (["torch==2.11.0"] if sys.platform == "darwin" else
         ["--extra-index-url", "https://download.pytorch.org/whl/cpu", "--index-strategy", "unsafe-best-match", "torch==2.15.0+cpu"])
ENGINES = {
    "pocket": {"pip": TORCH + ["pocket-tts-turkish==0.1.0"]},
    "pocket-en": {"pip": TORCH + ["pocket-tts>=3.1"]},
    "kokoro": {"pip": ["kokoro-onnx==0.6.1"], "files": {
        "kokoro/kokoro-v1.0.int8.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx",
        "kokoro/voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"}},
    "piper": {"pip": ["piper-tts"], "files": {
        "piper/en_US-amy-medium.onnx": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx",
        "piper/en_US-amy-medium.onnx.json": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json"}},
    "ahenk": {"pip": TORCH + ["ema-lightning==1.1.2", "trnorm @ https://github.com/ozguradmin/ahenk-turkish-tts/archive/8981df9354a6dc95a3a2b4730b7fbff196dda219.tar.gz"]},
    "higgs": {},
    "remote": {},
}
FILES = {"silero_vad.onnx": "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"}


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path):
        return
    print(f"downloading {os.path.basename(path)}", flush=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with urllib.request.urlopen(url) as r, open(path + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(path + ".part", path)


def stt(spec):
    names = [spec[k] for k in ("tokens", "encoder", "decoder", "joiner")]
    if "hf" in spec:
        for name in names:
            try:
                hf_hub_download(spec["hf"], name, local_files_only=True)
            except Exception:
                print(f"downloading {spec['hf']} {name}", flush=True)
                hf_hub_download(spec["hf"], name)
        return
    for name in names:
        download(f"{spec['base']}/{name}", f"{MODELS}/{spec['dir']}/{name}")


def venv(engines):
    python, record = f"{VENV}/bin/python", f"{VENV}/.engines"
    wanted = ",".join(engines)
    if os.path.exists(python) and (not os.path.exists(record) or open(record).read() == wanted):
        return
    if not os.path.exists(python):
        subprocess.run(["uv", "venv", "--python", "3.12", VENV], check=True)
    pip = list(dict.fromkeys(a for e in engines for a in ENGINES[e].get("pip", [])))
    subprocess.run(["uv", "pip", "install", "--python", python, *pip, "soxr", "aiohttp", "numpy"], check=True)
    local = [e for e in engines if e not in ("higgs", "remote")]
    if local:
        print(f"loading {','.join(local)} once, which fetches its weights", flush=True)
        env = {**os.environ, "HF_HOME": os.path.expanduser(os.environ.get("TTS_HF_HOME") or "~/.cache/atc/voice/hf"), "TALK_MODELS": MODELS}
        subprocess.run([python, f"{HERE}/ttsd.py", "--engine", ",".join(local), "--warm-only"], check=True, env=env)
    with open(record, "w") as f:
        f.write(wanted)


if __name__ == "__main__":
    os.makedirs(MODELS, exist_ok=True)
    engines = (os.environ.get("TTS_ENGINES") or "pocket-en").split(",")
    unknown = [e for e in engines if e not in ENGINES]
    if unknown:
        sys.exit(f"unknown voice engine {unknown[0]}: pick from {', '.join(ENGINES)}")
    for name, url in FILES.items():
        download(url, f"{MODELS}/{name}")
    for code in dict.fromkeys([os.environ.get("TALK_LANG") or "en", *(os.environ.get("TALK_ALSO") or "").split()]):
        stt(Pack(code).STT)
    for e in engines:
        for name, url in ENGINES[e].get("files", {}).items():
            download(url, f"{MODELS}/{name}")
    venv(engines)
