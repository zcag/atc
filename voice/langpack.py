"""A language pack, lang/<code>.json: every word the call stack says, hears for or tells the assistant in that language."""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SLOT = re.compile(r"\{(\w+)\}")
REGEXES = "UNFINISHED", "HALLUCINATIONS", "WHISPER_JUNK", "STOP"
WORDS = "LINE_CHECK", "LINE_CORE", "BACKCHANNEL"


def fill(template, **values):
    """Slots filled in one pass, so a value holding a brace (their words go through here) is left as it is."""
    return SLOT.sub(lambda m: str(values[m[1]]) if m[1] in values else m[0], template)


def named(value, names):
    if isinstance(value, str):
        return fill(value, **names)
    if isinstance(value, list):
        return [named(v, names) for v in value]
    return value


class Pack:
    def __init__(self, code, assistant=None, user=None):
        with open(os.path.join(HERE, "lang", code + ".json"), encoding="utf-8") as f:
            raw = json.load(f)
        names = {**raw["DEFAULTS"], **{k: v for k, v in (("assistant", assistant), ("user", user)) if v}}
        self.code = code
        self.__dict__.update({k: named(v, names) for k, v in raw.items()})
        for k in REGEXES:
            setattr(self, k, re.compile(getattr(self, k), re.I))
        self.LINE_BACK = re.compile(fill(raw["LINE_BACK"], **{k: re.escape(v) for k, v in names.items()}), re.I)
        for k in WORDS:
            setattr(self, k, set(getattr(self, k)))
        self.END = re.compile("|".join(map(re.escape, self.HANGUP)))
