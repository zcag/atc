"""A language pack, lang/<code>.json: every word the call stack says, hears for or tells the assistant in that language."""
import difflib, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SLOT = re.compile(r"\{(\w+)\}")
REGEXES = "HALLUCINATIONS", "WHISPER_JUNK", "STOP"
WORDS = "LINE_CHECK", "LINE_CORE", "BACKCHANNEL"


def fill(template, **values):
    """Slots filled in one pass, so a value holding a brace (their words go through here) is left as it is."""
    return SLOT.sub(lambda m: str(values[m[1]]) if m[1] in values else m[0], template)


def like(word, words):
    """A word two transcribers, or two readings of one, spell differently still counts as the same word."""
    return any(word == w or difflib.SequenceMatcher(None, word, w).ratio() >= .75 for w in words)


def agreement(first, second):
    """Share of the words of first that second also has. Two languages' transcribers mostly agree only on speech in a
    language both can spell, so this tells which language they are speaking without a list of either's words."""
    a, b = (re.findall(r"\w+", t.lower()) for t in (first, second))
    return sum(like(w, b) for w in a) / len(a) if a else 0


def hangup_tags(packs):
    return re.compile("|".join(re.escape(t) for p in packs.values() for t in p.HANGUP))


def first_language(settings_path, packs, fallback):
    """The language calls start in: the user's setting, when this talker has that language's pack and transcriber."""
    try:
        with open(settings_path, encoding="utf-8") as f:
            lang = (json.load(f).get("language") or "").strip().lower()
    except (OSError, ValueError):
        lang = ""
    return lang if lang in packs else fallback


def saved_names(settings_path):
    """The (assistant, user) names set in atc's Settings."""
    try:
        with open(settings_path, encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return None, None
    return saved.get("assistant") or None, saved.get("user") or None


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
