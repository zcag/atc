"""The picker: a small local model (llama.cpp serving Gemma 4 E4B, delta-picker.service) that chooses delta's
fillers and greetings from the pack's bank (PICK_*) and writes its tool lines. It only advises: every answer has a
deadline, and a miss, an error or an answer that fails its check returns FALLBACK, which leaves that moment to the
rules talk.py had before. Two misses in a row turn it off for the rest of the call.

Fillers say nothing: the model only picks the kind of sound (looking, thinking, waiting, listening) or none, and
the wording among that kind's variants is chosen here, by habit (the weight next to a line) and by what was said
lately (Wording), so delta neither repeats itself nor sounds new every time."""
import asyncio, json, math, os, random, re, time

import aiohttp

FALLBACK = object()


def safe(f):
    """A bug in here must never reach the call: anything unexpected is logged and leaves the moment to the old rules."""
    async def wrapped(self, *a, **kw):
        try:
            return await f(self, *a, **kw)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.miss(f.__name__, f"bug: {e!r}")
            return FALLBACK
    return wrapped
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
CODE_LIKE = re.compile(r"[/\\`{}<>|$=_]|https?:|\b[0-9a-f]{6,}\b|\.(py|sh|json|md|go|js)\b", re.I)
QUIET_TOOLS = re.compile(r"^(ToolSearch|TodoWrite|mcp__atc__report)$")

FILLER = ("You pick a filler sound for {assistant}, a voice assistant on a phone call with {user}, to fill the silence while "
          "another model writes the real answer. The filler carries no content: it never agrees, answers, judges or "
          "promises anything, it only sounds like someone looking, thinking or listening. Pick the kind of sound that fits "
          "what he just said, or NONE only when his whole turn is a bare yes, okay or no. A filler only plays if the real "
          "answer is slow, so a request or question always gets one. The transcript is live phone speech recognition and "
          "can be garbled.\n\nKinds:\n{kinds}\n\nExamples of his turns: {examples}\n\nAnswer with one letter.")
GREETING = ("You pick how {assistant}, a voice assistant, answers the phone when {user} calls. Pick the greeting that fits the "
            "time and how recently he last called.\n\nKinds:\n{kinds}\n\nAnswer with one letter.")
TOOL = ("{assistant} is a voice assistant on a phone call with {user}. It just started a tool call (below). Write what it says "
        "out loud while the tool runs, like a person on the phone saying what they are doing.\n\nRules:\n"
        "- One short spoken sentence, 2 to 5 words, in natural casual {language} with correct grammar, first person, present tense.\n"
        "- Say only what the tool call shows it is doing. Never a result, never a promise, never how long it takes.\n"
        "- No ids, file paths, commands, code or URLs. Name a session by its readable name in plain {language} words "
        "(car-parked-location is the car's location), else just as a session. An id like 86f96cd1 is not a name.\n"
        "- For Bash, go by its \"description\": say in {language} what it says, in plain words he would understand.\n"
        "- Do not repeat or closely echo a line from \"already said\".\n"
        "- Answer NONE for housekeeping he does not need to hear: tool lookups, sleeping, help texts.\n\nExamples:\n{examples}")


class Wording:
    """Which variant of a kind to say: weight = habit x recency. A line never comes twice running and has half its
    weight the pick after; a longer block turns a kind into a strict rotation where the habits don't show. A weight
    of 2 comes up about 1.4 times as often as a 1 among four, 3 about twice. Kept across calls in one small file, so
    calls don't all start the same way."""

    def __init__(self, path, rng=None):
        self.path, self.rng = path, rng or random.Random()
        try:
            with open(path, encoding="utf-8") as f:
                self.said = json.load(f)[-60:]
        except (OSError, ValueError):
            self.said = []

    def recency(self, text):
        if text not in self.said:
            return 1.0
        age = self.said[::-1].index(text) + 1
        return 0.0 if age == 1 else 0.5 if age == 2 else 1.0

    def pick(self, variants, ready=lambda t: True):
        options = [(t, h) for t, h in variants if ready(t)]
        if not options:
            return None
        weights = [h * self.recency(t) for t, h in options]
        if not any(weights):
            weights = [h for _, h in options]
        text = self.rng.choices([t for t, _ in options], weights)[0]
        self.said = (self.said + [text])[-60:]
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(self.said, f, ensure_ascii=False)
        except OSError:
            pass
        return text


class Picker:
    def __init__(self, url, http, log, wording, names, deadline_ms=2000, greet_ms=400, tool_ms=1200, misses=2):
        self.url, self.http, self.log, self.wording, self.names = url.rstrip("/"), http, log, wording, names
        self.deadline, self.greet_deadline, self.tool_deadline = deadline_ms / 1000, greet_ms / 1000, tool_ms / 1000
        self.max_misses, self.misses, self.off = misses, 0, False

    async def check(self, pack=None):
        """At the start of a call: off for this call when the server isn't up and loaded. Then the filler and tool
        prompts are read once in the background, so their first real use only reads the turn (each prompt keeps its
        own server slot, -np 3): on the first sim the tool line's first read alone missed its deadline."""
        try:
            async with self.http.get(f"{self.url}/health", timeout=aiohttp.ClientTimeout(total=0.3)) as r:
                self.off = (await r.json()).get("status") != "ok"
        except Exception as e:
            self.off = True
            self.log(event="picker", ok=False, why=f"health: {e!r}")
        self.misses = 0
        if not self.off and pack:
            self.warming = asyncio.create_task(self.warm(pack))
        return not self.off

    async def warm(self, pack):
        for system in (self.filler_prompt(pack), self.tool_prompt(pack)):
            try:
                async with self.http.post(f"{self.url}/v1/chat/completions", timeout=aiohttp.ClientTimeout(total=5), json={
                        "messages": [{"role": "system", "content": system}, {"role": "user", "content": "."}], "max_tokens": 1,
                        "cache_prompt": True, "chat_template_kwargs": {"enable_thinking": False}}) as r:
                    await r.read()
            except Exception:
                return

    def miss(self, kind, why):
        self.misses += 1
        self.log(event="picker", kind=kind, ok=False, why=why)
        if self.misses >= self.max_misses and not self.off:
            self.off = True
            self.log(event="picker", ok=False, why="off for this call")

    async def ask(self, kind, body, deadline):
        if self.off:
            return None
        t0 = time.monotonic()
        try:
            async with asyncio.timeout(deadline):
                async with self.http.post(f"{self.url}/v1/chat/completions", json={
                        "cache_prompt": True, "chat_template_kwargs": {"enable_thinking": False}, **body}) as r:
                    if r.status != 200:
                        raise RuntimeError(f"http {r.status}")
                    out = await r.json()
        except (Exception, asyncio.CancelledError) as e:
            if isinstance(e, asyncio.CancelledError) and asyncio.current_task().cancelling():
                raise
            self.miss(kind, "late" if isinstance(e, TimeoutError) else repr(e))
            return None
        self.misses = 0
        return out, round((time.monotonic() - t0) * 1000)

    async def choose(self, kind, system, user, n, deadline):
        """One letter out of n, by the model's probabilities over the allowed letters; None on any failure."""
        letters = LETTERS[:n]
        got = await self.ask(kind, {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                                    "grammar": "root ::= " + " | ".join(f'"{k}"' for k in letters), "max_tokens": 1,
                                    "temperature": 0, "logprobs": True, "top_logprobs": 20}, deadline)
        if not got:
            return None
        out, ms = got
        try:
            p = {}
            for t in out["choices"][0]["logprobs"]["content"][0]["top_logprobs"]:
                k = t["token"].strip()
                if k in letters:
                    p[k] = p.get(k, 0) + math.exp(t["logprob"])
            k = max(p, key=p.get) if p else out["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError, ValueError) as e:
            self.miss(kind, f"answer: {e!r}")
            return None
        if k not in letters:
            self.miss(kind, f"answer {k!r}")
            return None
        return LETTERS.index(k), round(p.get(k, 1.0), 2), ms

    def prompt(self, template, **slots):
        return template.format(assistant=self.names[0], user=self.names[1], **slots)

    def filler_prompt(self, pack):
        listing = "\n".join(f"{LETTERS[i]}: {why} (like «{v[0][0]}»)" for i, (why, v) in enumerate(pack.PICK_FILLERS))
        listing += f"\n{LETTERS[len(pack.PICK_FILLERS)]}: NONE, say nothing: his whole turn is only a bare yes, okay, no or go-ahead"
        return self.prompt(FILLER, kinds=listing, examples=pack.PICK_FILLER_EXAMPLES)

    def tool_prompt(self, pack):
        return self.prompt(TOOL, language=pack.PICK_LANGUAGE, examples=pack.PICK_TOOL_EXAMPLES)

    @safe
    async def filler(self, pack, delta_last, his, ready):
        """A filler line, None for silence, or FALLBACK."""
        kinds = pack.PICK_FILLERS
        user = (f"{self.names[0]} just said: «{delta_last}»\n" if delta_last else "The call just started.\n") + f"{self.names[1]} said: «{his}»"
        got = await self.choose("filler", self.filler_prompt(pack), user, len(kinds) + 1, self.deadline)
        if not got:
            return FALLBACK
        i, p, ms = got
        line = None if i == len(kinds) else self.wording.pick(kinds[i][1], ready)
        self.log(event="pick", kind="filler", choice=kinds[i][0] if i < len(kinds) else "none", p=p, line=line, ms=ms)
        if i < len(kinds) and line is None:
            return FALLBACK
        return line

    @safe
    async def greeting(self, pack, situation, ready):
        kinds = pack.PICK_GREETINGS
        listing = "\n".join(f"{LETTERS[i]}: {why} (like «{v[0][0]}»)" for i, (why, v) in enumerate(kinds))
        got = await self.choose("greeting", self.prompt(GREETING, kinds=listing), situation, len(kinds), self.greet_deadline)
        if not got:
            return FALLBACK
        i, p, ms = got
        line = self.wording.pick(kinds[i][1], ready)
        self.log(event="pick", kind="greeting", choice=kinds[i][0], p=p, line=line, ms=ms)
        return line or FALLBACK

    @safe
    async def tool_line(self, pack, tool, given, his, said):
        """A line saying what the tool is doing, written by the model, None for a tool not worth a line, or FALLBACK."""
        if QUIET_TOOLS.match(tool):
            return None
        user = f"{tool} {given}\nWhat he said before this: «{his[:200]}»\nAlready said this call: {said[-4:] or 'nothing'}"
        got = await self.ask("tool", {"messages": [{"role": "system", "content": self.tool_prompt(pack)},
                                                   {"role": "user", "content": user}],
                                      "max_tokens": 20, "temperature": 0.7, "stop": ["\n"]}, self.tool_deadline)
        if not got:
            return FALLBACK
        out, ms = got
        try:
            line = out["choices"][0]["message"]["content"].strip().strip("«»\"'")
            line = re.sub(pack.PICK_TOOL_DROP, "", line, flags=re.I).strip()
            line = line[:1].upper() + line[1:]
        except (KeyError, IndexError, TypeError):
            line = ""
        if line.upper().startswith("NONE"):
            self.log(event="pick", kind="tool", tool=tool, line=None, ms=ms)
            return None
        bad = (not line or len(line.split()) > 7 or CODE_LIKE.search(line) or re.search(pack.PICK_TOOL_BANNED, line, re.I)
               or line in said)
        self.log(event="pick", kind="tool", tool=tool, line=line, ms=ms, **({"rejected": True} if bad else {}))
        return FALLBACK if bad else line

    def hold(self, pack, tool, nth, ready):
        """A "still on it" line from the bank, by what the open tool waits on; no model."""
        try:
            return self.held(pack, tool, nth, ready)
        except Exception as e:
            self.miss("hold", f"bug: {e!r}")
            return FALLBACK

    def held(self, pack, tool, nth, ready):
        kind = "again" if nth > 0 else "session" if re.search(r"atc__(send|wait|start|read)|Agent|Task", tool) \
            else "web" if re.search(r"Web|fetch|browser|search", tool, re.I) else "any"
        return self.wording.pick(pack.PICK_HOLDS[kind], ready) or FALLBACK


def bank_lines(pack):
    """Every line the picker can choose for this pack, for the TTS cache."""
    return [t for _, vs in pack.PICK_FILLERS + pack.PICK_GREETINGS for t, _ in vs] + [t for vs in pack.PICK_HOLDS.values() for t, _ in vs]
