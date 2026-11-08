#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp", "numpy", "onnxruntime", "sherpa-onnx", "huggingface_hub", "soxr"]
# ///
"""The call's conversation: answers the line (call.py) and talks, with atc's hub as the brain.

  talk.py                      wait for a call, answer, converse
  talk.py --dial +90541...     call that number (must be in DELTA_CALL_DIAL_ALLOW)
  talk.py --sim caller.wav     no phone: play a WAV as the caller, to test the pipeline offline

Pipeline: Silero VAD on the downlink, streaming speech to text, the hub's reply cut into sentences, each
sentence to TTS (ttsd.py) and paced into the uplink. The caller can cut in: speech while the voice talks
stops the uplink and keeps only what was actually said in the history.
Every word in a language is in lang/<code>.json; --lang picks the first language, --also the others a call can switch to.
Every call leaves <out>/talk-<time>/: call.wav (left caller, right voice), turns.jsonl with timings.
"""
import argparse, asyncio, concurrent.futures, difflib, hashlib, io, json, os, random, re, time, wave
import aiohttp
import soxr, numpy as np, onnxruntime
from langpack import Pack, agreement, fill, first_language, hangup_tags, like, saved_names
from picker import FALLBACK, Picker, Wording, bank_lines

RATE, FRAME = 16000, 640
APP_RATE = 24000
STT_URL = os.environ.get("TALK_STT", "")
STT_MODEL = os.environ.get("TALK_STT_MODEL", "whisper-large-v3-turbo")
STT_WORDS = os.environ.get("TALK_STT_WORDS", "")
SECOND_DELAY, SECOND_WAIT = 0.15, 0.8
TTS_URL = os.environ.get("TALK_TTS", "http://127.0.0.1:8812/v1/audio/speech")
MODELS = os.path.expanduser(os.environ.get("TALK_MODELS") or "~/.cache/atc/voice")
STATE = os.path.expanduser(os.environ.get("TALK_STATE") or "~/.local/state/atc/voice")
VAD_MODEL = f"{MODELS}/silero_vad.onnx"
VOICES = f"{STATE}/voice.json"
PERSONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "persons.json")
PHRASES = f"{MODELS}/phrases"
CONFIG = os.environ.get("ATC_CONFIG_DIR") or (os.environ["XDG_CONFIG_HOME"] + "/atc" if os.environ.get("XDG_CONFIG_HOME") else "~/.config/atc")
GUESTS = os.path.expanduser(f"{CONFIG}/guests")
SETTINGS = os.path.expanduser(f"{CONFIG}/settings.json")
HIGGS_VOICES = os.path.expanduser(os.environ.get("HIGGS_VOICES") or "~/.local/share/atc/voice/audiocpp/voices")
CPU = concurrent.futures.ThreadPoolExecutor(1)
LANG_TAG = re.compile(r"\[LANG:([a-z]{2,3})\]\s*")
LINE_TAG = re.compile(r"\[LINE:@?([\w.-]+)\]\s*")
ASSISTANT = "assistant"
BACK_WORDS = 6
SAME_SPEECH = .5


def setting(name, lang, primary):
    """TALK_TTS_VOICE_EN for that language, TALK_TTS_VOICE for the first one; none = what ttsd picks."""
    return os.environ.get(f"{name}_{lang.upper()}") or (os.environ.get(name) if lang == primary else None) or None


LOADED = {}


def session(path, threads):
    """onnxruntime's default gives every core a thread, pins each to its core (past taskset) and spins them between runs:
    Silero's two states every 32 ms held 3.00 cores busy that way and 0.03 on one thread (a 6-core desktop CPU, measured)."""
    o = onnxruntime.SessionOptions()
    o.intra_op_num_threads, o.inter_op_num_threads = threads, 1
    o.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return onnxruntime.InferenceSession(path, sess_options=o, providers=["CPUExecutionProvider"])


def once(key, make):
    """A model loaded once per process: a Talk lives for one call, and loading them all again made every call's
    talker take 8-21 s to be ready, so a call back right after hanging up rang that long first."""
    if key not in LOADED:
        LOADED[key] = make()
    return LOADED[key]


class Vad:
    """Silero v5 on 512-sample windows with its 64-sample context, as the model expects at 16 kHz.

    Silero's state, carried over a whole call, learns the line's background (traffic) and then also scores a short
    loud word low: a clear 0.3 s «Evet» peaked at 0.38 an hour into a call and never started a turn, while the same
    audio through a fresh state scores 0.9+. A fresh state alone fires on that background instead. So a second copy
    runs with its state reset every few seconds of silence (reset_fresh), and its score counts only for a window loud
    enough to be them (fresh_peak): it can add a turn the long one missed, never drop one."""
    def __init__(self, fresh_peak=0.0):
        self.s = once("vad", lambda: session(VAD_MODEL, 1))
        self.fresh_peak, self.buf = fresh_peak, np.zeros(0, np.float32)
        self.long, self.fresh = self.blank(), self.blank()

    @staticmethod
    def blank():
        return [np.zeros((2, 1, 128), np.float32), np.zeros(64, np.float32)]

    def reset_fresh(self):
        self.fresh = self.blank()

    def score(self, mem, win):
        p, mem[0] = self.s.run(None, {"input": np.concatenate([mem[1], win])[None], "state": mem[0], "sr": np.array(RATE, np.int64)})
        mem[1] = win[-64:]
        return float(p[0][0])

    def feed(self, pcm):
        self.buf = np.concatenate([self.buf, np.frombuffer(pcm, np.int16).astype(np.float32) / 32768])
        out = []
        while len(self.buf) >= 512:
            win, self.buf = self.buf[:512], self.buf[512:]
            p = self.score(self.long, win)
            if self.fresh_peak:
                fresh = self.score(self.fresh, win)
                if np.abs(win).max() >= self.fresh_peak:
                    p = max(p, fresh)
            out.append(p)
        return out


class StreamSTT:
    """Streaming transcription on CPU, fed every frame of the caller's turn, so the text is ready the moment the
    turn ends: one model per language of the call, each pack's STT (the call's language, which Claude switches with
    [LANG:xx], picks which one Claude gets)."""
    def __init__(self, gain_db, packs):
        self.recs = {code: self.recognizer(p.STT) for code, p in packs.items()}
        self.flush = {code: p.STT.get("flush", 0.4) for code, p in packs.items()}
        self.first = next(iter(packs))
        self.gain, self.s, self.heard = 10 ** (gain_db / 20), {}, {}

    @staticmethod
    def recognizer(stt):
        import sherpa_onnx
        if "hf" in stt:
            from huggingface_hub import hf_hub_download
            get = lambda f: hf_hub_download(stt["hf"], f)
        else:
            get = lambda f: f"{MODELS}/{stt['dir']}/{f}"
        return sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=get(stt["tokens"]), encoder=get(stt["encoder"]), decoder=get(stt["decoder"]),
            joiner=get(stt["joiner"]), num_threads=2, sample_rate=RATE, feature_dim=80,
            decoding_method="modified_beam_search")

    def start(self, pcm=b""):
        self.s, self.heard = {lang: rec.create_stream() for lang, rec in self.recs.items()}, {}
        self.feed(pcm)

    def feed(self, pcm):
        if self.s and pcm:
            a = np.clip(np.frombuffer(pcm, np.int16) / 32768 * self.gain, -1, 1).astype(np.float32)
            for lang in self.s:
                self.push(lang, a)

    def push(self, lang, a):
        s, rec = self.s[lang], self.recs[lang]
        s.accept_waveform(RATE, a)
        while rec.is_ready(s):
            rec.decode_stream(s)
        self.heard[lang] = rec.get_result(s).strip()

    def partial(self, lang):
        """What the last feed heard: feed runs on Talk's worker thread, and reading a stream while it decodes is not safe."""
        return self.heard.get(lang, self.heard.get(self.first, ""))

    def text(self):
        """Text so far in every language. The decoders run behind the audio (a pack's STT says how far when it is
        not ~0.3 s), so flush them with silence first; if the caller goes on, that silence just sits inside the turn."""
        for lang in self.s:
            self.push(lang, np.zeros(int(self.flush[lang] * RATE), np.float32))
        return dict(self.heard)


def wav_bytes(pcm):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(RATE), w.writeframes(pcm)
    return b.getvalue()


def normalize(pcm):
    a = np.frombuffer(pcm, np.int16).astype(np.float32)
    peak = np.abs(a).max() or 1
    return (a * min(30, 0.7 * 32767 / peak)).clip(-32768, 32767).astype(np.int16).tobytes()


class HubBrain:
    """atc's hub (`atc hub`, :8820): this call is the "phone" channel of the assistant's one conversation,
    or "guest-call" when one of their guests is on the line."""
    def __init__(self, args, http, line=None, on_knock=None):
        self.a, self.http, self.ws, self.busy, self.events = args, http, None, False, asyncio.Queue()
        self.channel, self.guest = "phone", None
        self.base, self.on_knock = args.hub + (f"/lines/{line}" if line else ""), on_knock

    async def as_guest(self, name):
        self.channel, self.guest = "guest-call", name
        if self.ws and not self.ws.closed:
            await self.ws.close()

    async def start(self):
        """Connects once per call (when it is answered, or for the opening of a call out), as the channel it is on by then."""
        if self.ws and not self.ws.closed:
            return
        if not getattr(self, "connecting", None) or self.connecting.done():
            self.connecting = asyncio.ensure_future(self.http.ws_connect(f"{self.base}/ws?channel={self.channel}", heartbeat=15))
        ws = await self.connecting
        if ws is not self.ws:
            self.ws = ws
            asyncio.create_task(self.read(ws))

    async def read(self, ws):
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                e = json.loads(msg.data)
                if e["type"] == "knock":
                    self.on_knock and self.on_knock(e.get("text", ""))
                else:
                    self.events.put_nowait(e)
        self.events.put_nowait({"type": "done", "lost": True})

    async def quiet(self):
        """Until the hub has no turn of this channel running or queued (`owners`/`pending` in its status), up to 10 s.
        Another connection's turn on the same channel streams its reply here too: on one call the assistant's
        English answer to the last call's end note was still streaming when an app call's opening was sent, and the
        opening took that text, and its done, for its own, so they heard it first."""
        for _ in range(100):
            try:
                async with self.http.get(f"{self.base}/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
                    st = await r.json()
            except Exception:
                return
            if self.channel not in (st.get("owners") or []) + (st.get("pending") or []):
                return
            await asyncio.sleep(0.1)

    async def turn(self, text):
        await self.start()
        while self.busy:
            if (await self.events.get())["type"] == "done":
                self.busy = False
        await self.quiet()
        while not self.events.empty():
            self.events.get_nowait()
        self.busy = True
        if self.guest:
            text = f"[guest {self.guest} on the phone] {text}"
        await self.ws.send_str(json.dumps({"type": "message", "text": text}))
        while True:
            e = await self.events.get()
            if e["type"] == "done":
                self.busy = False
                return
            if e["type"] in ("text", "tool", "tool_done"):
                yield e["type"], e.get("delta", e.get("name", ""))
            elif e["type"] == "tool_input":
                yield "tool_input", e.get("text", "")

    def interrupt(self):
        if self.busy and self.ws and not self.ws.closed:
            asyncio.ensure_future(self.ws.send_str(json.dumps({"type": "interrupt"})))

    async def send(self, kind, text):
        await self.start()
        await self.ws.send_str(json.dumps({"type": kind, "text": text}))

    async def finish(self, note):
        if self.ws and not self.ws.closed:
            if note:
                await self.ws.send_str(json.dumps({"type": "note", "text": note}))
            await self.ws.close()


class Talk:
    def __init__(self, args, http, send_audio, send_cmd):
        self.a, self.http, self.send_audio, self.send_cmd = args, http, send_audio, send_cmd
        self.brain = HubBrain(args, http, on_knock=self.knocked)
        self.brains = {None: self.brain}
        self.who, self.title, self.line_voices, self.line_since = None, ASSISTANT, {}, 0.0
        self.first_line, self.moving, self.leaving, self.knock = None, False, False, ""
        self.packs, self.names, self.lang = args.packs, saved_names(SETTINGS), first_language(SETTINGS, args.packs, args.lang)
        self.picker = Picker(args.picker, http, self.log, Wording(os.path.join(args.out, "picker-said.json")),
                             (self.names[0] or "delta", self.names[1] or "the caller"), args.picker_ms, args.picker_greet_ms,
                             args.picker_tool_ms) if args.picker else None
        self.tool_said, self.tool_name = [], ""
        self.first = self.packs[self.lang]
        self.hangup = hangup_tags(self.packs)
        self.heard, self.unfinished = None, None
        self.vad, self.cache = Vad(args.vad_fresh_peak), {}
        self.stt = once(("stt", args.gain_db), lambda: StreamSTT(args.gain_db, args.packs)) if args.stt == "stream" else None
        if self.stt:
            self.stt.s, self.stt.heard = {}, {}
        self.voices = voices(args)
        self.history = []
        self.outbox: asyncio.Queue = asyncio.Queue()
        self.speaking, self.spoken = [], []   # [text, frames left, made, leftover(, "canned")] queued for the uplink / texts fully sent this reply
        self.reply: asyncio.Task | None = None
        self.utt, self.preroll, self.voiced_ms = bytearray(), b"", 0
        self.in_speech, self.speech_ms, self.silence_ms, self.barge_ms = False, 0, 0, 0
        self.commit, self.pending, self.cut, self.live = asyncio.Event(), False, False, False
        self.paused, self.paused_at, self.reopening, self.reopened = False, 0.0, False, False
        self.may_speak = asyncio.Event()
        self.may_speak.set()
        self.line_up, self.line_checks, self.checked = False, 0, []
        self.opening = self.discard = self.holding = False
        self.dry_ms, self.slowest = 0.0, 0.0
        self.tools_open, self.last_voice = 0, time.monotonic()
        self.last_heard, self.last_ack, self.canned_at = 0.0, None, 0.0
        self.t0 = self.speaking_task = None
        self.track = {"in": bytearray(), "out": bytearray()}
        self.rate, self.down, self.converting = RATE, None, {}
        self.guest = None
        self.app, self.shown, self.next_shown, self.steady, self.heard_shown = False, None, None, 0, ""
        self.said_recently, self.echoing = [], False
        self.bye_waiting, self.answered_at, self.hello = False, None, None
        self.on_hold = False
        self.first_audio = {}
        self.pressed = self.released = False

    async def off(self, fn, *args):
        """Run the transcribers on one worker thread (they release the GIL), so the event loop keeps
        pacing delta's voice: inline, a decode under load held the loop past the uplink's 120 ms lead and the phone
        ran dry mid-sentence (dry_ms 371 ms/s while speaking on one loaded call)."""
        return await asyncio.get_running_loop().run_in_executor(CPU, fn, *args)

    @property
    def pack(self):
        """The language the call is in now, for what they say and what delta says; self.first is the one it started in."""
        return self.packs[self.lang]

    def echoed(self, word, prefix=False):
        """A word delta itself said in the last few seconds of an app call (fuzzy, as the transcriber spells it):
        a phone on speaker or in a car plays delta's voice back into its own microphone, and the transcriber
        hears it as them ("Şey, bakiyim" right after delta said "Şey, bakayım"). The phone line has no such echo."""
        if not self.app:
            return False
        now = time.monotonic()
        self.said_recently = [(t, w) for t, w in self.said_recently if now - t < 6 or now - self.last_voice < 3]
        words = [w for _, w in self.said_recently] + [w for it in self.speaking if it[0] for w in re.findall(r"\w+", it[0].lower())]
        return any(w == word or prefix and w.startswith(word) or difflib.SequenceMatcher(None, w, word).ratio() >= .75 for w in words)

    def own_voice(self):
        """On an app call, speech heard while delta talks is only taken for them once a word of it isn't delta's own:
        on speaker, delta's voice reaches the mic and the VAD alone paused delta for it every second (20 pauses on its own sentences in one call). The phone line has no echo and keeps pausing on the VAD.
        On a line that echoes (check_echo), it takes two such words or a stop word: a loud echo comes out of the
        transcriber misspelled («Bostan» for «Boston») or cut mid-word («me»), one word each time."""
        if not self.app or not self.stt:
            return False
        heard = self.stt.partial(self.lang)
        if self.stop_heard(heard):
            return False
        words = [w for w in re.findall(r"\w+", heard.lower()) if w not in self.pack.BACKCHANNEL and not self.echoed(w, self.echoing)]
        return not self.pack.STOP.search(heard) and len(words) < 2 if self.echoing else not words

    def stop_heard(self, heard):
        """--stop-words: a stop word of theirs (STOP_WORDS: «durdur», «bir saniye», «kapat», «tamam tamam»...) counts
        even when delta has just said a word like it: its own lines are «Dur bakayım.» and «Bir saniye, bakayım.», and
        so the echo filter threw out a real «bir saniye dur» or «dur». Only a run of delta's own
        words in its order is echo («dur bakayım»). A line marked echoing keeps the stricter rule."""
        if not self.a.stop_words or self.echoing or not self.pack.STOP_WORDS.search(heard):
            return False
        return not self.own_phrase(re.findall(r"\w+", heard.lower()))

    def own_phrase(self, words):
        """Echo comes back as delta's words in delta's order; a lone word only from the sentence playing now."""
        if not words or not self.app:
            return False
        same = lambda a, b: a == b or abs(len(a) - len(b)) <= 1 and difflib.SequenceMatcher(None, a, b).ratio() >= .75
        if len(words) == 1:
            now = getattr(self, "said_item", None)
            return bool(now and now[0] and any(same(w, words[0]) for w in re.findall(r"\w+", now[0].lower())))
        said = [w for _, w in self.said_recently] + [w for it in self.speaking if it[0] for w in re.findall(r"\w+", it[0].lower())]
        return any(all(same(said[i + j], w) for j, w in enumerate(words)) for i in range(len(said) - len(words) + 1))

    def check_echo(self):
        """Whether their mic plays delta back: its loudness following delta's over the last 10 s at some delay up to
        1.5 s. On speaker their phone usually zeroes the mic while delta talks; on some calls it did
        not, the two calls scoring 0.92 and 0.95 against at most 0.82 on 60 others, and delta paused for its own
        voice every 1.5 s (27 times in a 2-minute call). Once set it holds for the call."""
        n, lags, step = 500, 75, 640
        size = min(len(self.track["in"]), len(self.track["out"])) // step * step
        if size < (n + lags) * step:
            return
        db = {s: 20 * np.log10(np.sqrt((np.frombuffer(bytes(self.track[s][size - (n + lags) * step:size]), np.int16)
                                        .astype(np.float32).reshape(-1, 320) ** 2).mean(1)) + 1) for s in ("in", "out")}
        out = db["out"][:n]
        if (out > 60).sum() < 200:
            return
        mic = db["in"]
        corr = max(np.corrcoef(out, mic[lag:lag + n])[0, 1] if mic[lag:lag + n].std() >= 1 else 0 for lag in range(lags))
        if corr > 0.85:
            self.echoing = True
            self.log(event="echo", corr=round(float(corr), 2))

    def added(self, heard):
        """Words of the reopened turn that its sent text did not have, as the transcriber spells them (it re-spells
        earlier words as the turn grows: «gelmiyor mu» became «geliyorum»), leaving out «alo», «ses geliyor mu» and
        backchannels."""
        sent = re.findall(r"\w+", re.sub(r"\(.*?\)", "", self.unfinished or "").lower())
        return [w for w in re.findall(r"\w+", heard.lower()) if w not in self.pack.LINE_CHECK and w not in self.pack.BACKCHANNEL and not like(w, sent)]

    def line_check(self, text):
        """A turn that only tests the line («Alo?», «Ses geliyor mu?», «Duyuyor musun?») is answered at once with
        LINE_OK instead of 2-4 s of Claude, which a caller who hears nothing fills with more of the same; Claude is
        told with their next turn. Twice a call at most: past that the line itself is the trouble, and Claude may say so."""
        words = set(re.findall(r"\w+", re.sub(r"\(.*?\)", "", text).lower()))
        p = self.pack
        return (p.LINE_OK in self.cache and self.line_checks < 2 and not self.unfinished
                and not self.cut and not self.opening and bool(words & p.LINE_CORE) and words <= p.LINE_CHECK)

    def echo(self, text):
        """A turn that is delta's own voice coming back. --echo-order: only one that began while delta was audible and
        repeats its words in its order; a Turkish answer repeats the question's verb («Kalsınlar mı?» «Kalsınlar.»),
        and the any-order rule took most such answers for echo."""
        words = re.findall(r"\w+", text.lower())
        if not self.a.echo_order:
            return bool(words) and sum(map(self.echoed, words)) / len(words) >= .7
        return bool(words) and self.app and getattr(self, "began_after", 9) < .5 and self.in_order(words) >= .7

    def in_order(self, words):
        """Share of words found among delta's last few seconds of words in the same order, as the transcriber spells them."""
        now = time.monotonic()
        said = [w for t, w in self.said_recently if now - t < 6 or now - self.last_voice < 3]
        said += [w for it in self.speaking if it[0] for w in re.findall(r"\w+", it[0].lower())]
        same = lambda a, b: a == b or abs(len(a) - len(b)) <= 2 and difflib.SequenceMatcher(None, a, b).ratio() >= .75
        run = [0] * (len(said) + 1)
        for w in words:
            prev = run[:]
            for j, s in enumerate(said, 1):
                run[j] = max(run[j - 1], prev[j], prev[j - 1] + 1 if same(w, s) else 0)
        return run[-1] / len(words)

    def show(self, **kw):
        """What the app's call screen shows: the state, what they are saying, what delta says, the tool it uses, and always
        the language, so a screen opened mid-call or back from a dropped line draws the right person."""
        if self.app:
            asyncio.ensure_future(self.send_cmd({"cmd": "persona", "lang": self.lang, **kw}))

    def follow(self, item):
        """Once per uplink frame: the state the call screen shows, sent once it has held for 100 ms (speech between
        sentences would flicker otherwise), the sentence when its first frame goes out, and what they are saying."""
        state = ("speaking" if self.speaking and not self.paused else "tool" if self.tools_open
                 else "thinking" if self.pending or (self.reply and not self.reply.done()) else "hearing" if self.in_speech else "listening")
        self.steady = self.steady + 1 if state == self.next_shown else 0
        self.next_shown = state
        if state != self.shown and self.steady >= 5:
            self.shown = state
            self.show(state=state)
        if item and item[0] and item is not getattr(self, "said_item", None):
            self.said_item = item
            self.show(said=item[0])
            now = time.monotonic()
            self.said_recently += [(now, w) for w in re.findall(r"\w+", item[0].lower())]
        if self.in_speech and self.stt and self.frames % 15 == 0:
            heard = self.stt.partial(self.lang)
            if heard and heard != self.heard_shown:
                self.heard_shown = heard
                self.show(hearing=heard)

    @property
    def frame(self):
        """20 ms of delta's voice at the line's rate: 16 kHz on the phone line, 24 kHz (Higgs' own) to atc's app."""
        return self.rate // 50 * 2

    def set_rate(self, rate):
        """The line said what rate it takes delta's voice at, before the call starts: phrases are rendered again at
        that rate (from their disk copies once they exist), and the greeting is made fresh if they are not there yet."""
        if rate == self.rate:
            return
        old, self.rate, self.down, self.cache, self.greeting = self.rate, rate, None, {}, b""
        self.requeue(old)
        self.log(event="rate", rate=rate)
        asyncio.create_task(self.prerender())

    def requeue(self, old):
        """Voice already queued when the rate changes (an opening made while it rang, then answered on a device that
        takes another rate), resampled so it doesn't play fast and high or slow and low."""
        queued = []
        while not self.outbox.empty():
            item, frame = self.outbox.get_nowait()
            if queued and queued[-1][0] is item:
                queued[-1][1].append(frame)
            else:
                queued.append((item, [frame]))
        for item in self.speaking:
            if item[3]:
                item[3] = soxr.resample(np.frombuffer(item[3][:len(item[3]) // 2 * 2], np.int16), old, self.rate).tobytes()
        frame = self.frame
        for item, _ in queued:
            item[1] = 0
        for item, frames in queued:
            pcm = soxr.resample(np.frombuffer(b"".join(frames), np.int16), old, self.rate).tobytes()
            for i in range(0, len(pcm), frame):
                item[1] += 1
                self.outbox.put_nowait((item, pcm[i:i + frame].ljust(frame, b"\0")))

    def convert(self, item, pcm, rate, last):
        """A voice still streaming at the rate it started at, brought to the line's rate."""
        stream, odd, to = self.converting.get(id(item)) or (None, b"", None)
        if to != self.rate:
            stream = soxr.ResampleStream(rate, self.rate, 1, dtype="int16")
        pcm = odd + pcm
        n = len(pcm) // 2 * 2
        out = stream.resample_chunk(np.frombuffer(pcm[:n], np.int16), last=last).tobytes()
        if last:
            self.converting.pop(id(item), None)
        else:
            self.converting[id(item)] = (stream, pcm[n:], self.rate)
        return out

    def recorded(self, frame):
        """delta's voice for call.wav, which keeps one 16 kHz clock for both sides."""
        if self.rate == RATE:
            return frame
        self.down = self.down or soxr.ResampleStream(self.rate, RATE, 1, dtype="int16")
        return self.down.resample_chunk(np.frombuffer(frame, np.int16)).tobytes()

    def log(self, **kw):
        kw["t"] = round(time.time() - (self.t0 or time.time()), 3)
        line = json.dumps(kw, ensure_ascii=False)
        print(line, flush=True)
        if self.t0:
            self.turns.write(line + "\n")
            self.turns.flush()

    def place(self, side, pcm):
        """Write audio into its track at the wall-clock position, so call.wav shows real gaps and overlaps."""
        at, t = int((time.time() - self.t0) * RATE) * 2, self.track[side]
        if len(t) < at:
            t.extend(bytes(at - len(t)))
        t.extend(pcm)

    def piece_end(self, buf, first):
        """Where the next piece for the voice ends, if the text has one yet: the first full sentence alone, so audio
        starts soon, then chunk_sentences sentences per piece. The voice shapes intonation over the piece it gets,
        so cutting at every sentence (or comma) restarts the melody each time, which is what sounded robotic."""
        ends = [m.end() for m in re.finditer(r"[.!?…]\s|\n\n", buf)]
        if first:
            return next((e for e in ends if e >= 12), None)
        cut = ends[self.a.chunk_sentences - 1] if len(ends) >= self.a.chunk_sentences else None
        if cut and self.a.topic_pause_ms:
            cut = next((e for e in ends if e < cut and self.topic_starts(buf[max(0, e - 2):e], buf[e:])), cut)
        return cut

    def topic_starts(self, before, text):
        """--topic-pause-ms: a new topic begins here, after a paragraph break or at «Bi de», «İkincisi», «Sıradaki»...
        (TOPIC): 95% of delta's pauses were 0.6 s or less, so a new topic sounded like the next clause."""
        return bool(self.a.topic_pause_ms) and ("\n\n" in before + text[:2] or bool(self.pack.TOPIC.match(text.lstrip())))

    async def tts(self, text, lang=None, voice=None, rate=None):
        """Speech for text, as PCM chunks the moment the TTS server sends them. A request that fails before any audio
        (a reused keep-alive connection the server had already closed) is tried once more."""
        rate = rate or self.rate
        if rate == self.rate and text in self.cache:
            yield self.cache[text]
            return
        lang, got = lang or self.lang, False
        body = {"voice": voice or self.voices[lang], "input": text, "engine": self.engine(lang), "response_format": "pcm", "sample_rate": rate}
        for attempt in range(2):
            try:
                async with self.http.post(TTS_URL, json=body) as r:
                    async for chunk in r.content.iter_any():
                        got = True
                        yield chunk
                return
            except (aiohttp.ServerDisconnectedError, aiohttp.ClientOSError) as e:
                if got or attempt:
                    raise
                self.log(event="tts-retry", error=repr(e))

    def engine(self, lang):
        return setting("TALK_TTS_ENGINE", lang, self.a.lang)

    def queue(self, item, pcm=b"", last=False, rate=None):
        """Frames for the uplink. item = [text, frames queued and not yet sent, synthesis finished, leftover bytes].
        rate: what pcm is at, when it may no longer be the line's."""
        if rate and (rate != self.rate or id(item) in self.converting):
            pcm = self.convert(item, pcm, rate, last)
        pcm, frame = item[3] + pcm, self.frame
        self.first_audio.setdefault(id(item), time.monotonic())
        cut = len(pcm) if last else len(pcm) // frame * frame
        item[3] = pcm[cut:]
        for i in range(0, cut, frame):
            item[1] += 1
            self.outbox.put_nowait((item, self.louder(pcm[i:i + frame].ljust(frame, b"\0"))))
        if last:
            item[2] = True
            self.finished(item)

    def louder(self, frame):
        """Out gain with a soft limiter (tanh), so a hot TTS peak rounds off instead of clipping."""
        if not self.a.out_gain_db:
            return frame
        a = np.frombuffer(frame, np.int16) / 32768 * 10 ** (self.a.out_gain_db / 20)
        return (np.tanh(a) * 32767).astype(np.int16).tobytes()

    def ready(self, item):
        """Enough of this piece is queued that its stream will not run dry right after it starts (see speaker)."""
        return (item[2] or item[1] * 20 >= self.a.prebuffer_ms
                or time.monotonic() - self.first_audio.get(id(item), 0) >= self.a.prebuffer_max_ms / 1000)

    def finished(self, item):
        if item[2] and item[1] == 0:
            self.first_audio.pop(id(item), None)
        if item[2] and item[1] == 0 and item in self.speaking:
            self.speaking.remove(item)
            if item[0] and len(item) == 4:
                self.spoken.append(item[0])

    def say(self, text, pcm):
        item = [text, 0, False, b"", "canned"]
        self.speaking.append(item)
        self.queue(item, pcm, last=True)

    async def speaker(self):
        """Uplink kept lead_ms ahead of what the phone has played: enough to ride out a stall of this event loop
        (VAD, two transcribers) or of adb without the phone running dry, which is heard as a crackle or a cut,
        and short enough that stopping still sounds immediate. Between replies it sends silence the same way:
        a phone track left to run dry clipped the first syllable of the next reply ("Ada" heard as "mu").
        dry_ms counts the time the phone ran dry anyway.
        From silence, a piece starts only once prebuffer_ms of it is queued, its voice is complete, or prebuffer_max_ms
        has passed since its first audio: Higgs streams a piece's start in doubling chunks (40, 80, 160 ms...) slower
        than real time, and sending each at once put silence between them at 69 of 115 reply starts."""
        played_until = time.monotonic()
        idle = True
        while True:
            now = time.monotonic()
            if now > played_until:
                self.dry_ms += (now - played_until) * 1000
                played_until = now
            if played_until - now > self.a.lead_ms / 1000:
                await asyncio.sleep(0.01)
                continue
            quiet = self.paused or self.holding or self.on_hold or self.outbox.empty() or idle and not self.ready(self.outbox._queue[0][0])
            item, frame = (None, bytes(self.frame)) if quiet else self.outbox.get_nowait()
            idle = item is None
            await self.send_audio(frame)
            self.place("out", self.recorded(frame))
            self.follow(item)
            played_until += 0.02
            if item:
                self.last_voice = time.monotonic()
                item[1] -= 1
                self.finished(item)

    def interrupt(self):
        """Caller cut in while delta was audible: drop queued audio, keep only what was said in the history."""
        cut = next((it[0] for it in self.speaking if len(it) == 4), None)
        while not self.outbox.empty():
            self.outbox.get_nowait()
        self.speaking.clear()
        self.first_audio.clear()
        self.converting.clear()
        if self.reply and not self.reply.done():
            self.reply.cancel()
        said = (" ".join(self.spoken) + (f" {cut}" if cut else "")).strip()
        self.heard = said
        self.history[-1]["content"] = said
        self.live, self.cut = False, True
        if self.app:
            asyncio.ensure_future(self.send_cmd({"cmd": "flush"}))
        self.log(event="barge-in", said=said)

    def talking(self):
        return self.live and (bool(self.speaking) or bool(self.reply and not self.reply.done()))

    def tick(self, probs):
        """Once a second into debug.jsonl: lag = how far the downlink runs behind the wall clock since the call
        started (it should stay flat), and the turn state, so a stuck call can be read back."""
        self.frames += 1
        self.vad_max = max([self.vad_max, *probs])
        if self.app and not self.echoing and self.frames % 100 == 0:
            self.check_echo()
        if self.frames % 50:
            return
        self.debug.write(json.dumps({"t": round(time.time() - self.t0, 2), "lag": round(time.time() - self.t0 - self.frames * 0.02, 3),
                                     "vad": round(self.vad_max, 2), "in_speech": self.in_speech, "pending": self.pending,
                                     "commit": self.commit.is_set(), "live": self.live, "speaking": len(self.speaking),
                                     "outbox": self.outbox.qsize(), "reply": None if not self.reply else "done" if self.reply.done() else "running",
                                     "dry_ms": round(self.dry_ms), "slowest_ms": round(self.slowest * 1000)}) + "\n")
        self.debug.flush()
        self.vad_max, self.dry_ms, self.slowest = 0, 0.0, 0.0

    def silent(self, ms):
        """Whether they have been quiet for ms. While they hold the talk button they never has, and letting go is as good as any silence."""
        return not self.pressed and (self.released or self.silence_ms >= ms)

    async def press(self, down):
        """The app's hold-to-talk button. Pressing stops what delta is saying. While held, a pause does not end the turn and
        the first voiced window starts it; letting go ends it at once. Off the button the mic is silent, so the usual
        silence rules would end a turn anyway if the release were lost."""
        self.pressed = down
        self.log(event="press" if down else "release")
        if down:
            self.silence_ms = 0
            if self.talking():
                self.log(event="interrupted", by="press")
                self.interrupt()
            return
        self.released = True
        await self.settle()
        self.released = False

    async def on_audio(self, pcm):
        """Turn-taking. The caller's turn stays open until delta's answer is audible: at spec_ms of silence a
        reply starts in the background (STT, LLM, TTS), at end_ms it goes to Claude and its audio may play. Speech before that audio starts reopens the turn: once a turn has gone to
        Claude, its answer is held, not cut, while they goe on, and is redone with everything said only if what he
        added is new (not a repeat, «alo» or «ses geliyor mu»): cutting on every reopen left a caller who filled
        the wait with «Alo? Ses geliyor mu?» with no answer at all (a caller testing the line)."""
        self.place("in", pcm)
        self.line_up = self.line_up or any(pcm)
        probs = self.vad.feed(pcm)
        self.tick(probs)
        for p in probs:
            if p > self.a.vad_on:
                self.speech_ms += 32
                self.voiced_ms += 32
                self.silence_ms = 0
                self.last_heard = time.monotonic()
                if not self.in_speech and (self.pressed or self.speech_ms >= self.a.min_speech):
                    self.in_speech, self.pending = True, False
                    if self.opening or self.holding:
                        self.discard = True
                    elif self.reply and not self.reply.done() and not self.live:
                        if self.unfinished:
                            self.reopening = True
                        else:
                            self.reply.cancel()
                            self.log(event="turn-reopened")
                    else:
                        self.utt, self.voiced_ms = bytearray(self.preroll), self.speech_ms
                        self.began_after = time.monotonic() - self.speech_ms / 1000 - self.last_voice
                        if self.stt:
                            await self.off(self.stt.start, self.preroll)
                    if not self.talking():
                        self.live = False
                    self.log(event="user-start")
                if self.reopening and self.live:
                    self.reopening = False
                if self.reopening and self.speech_ms >= self.a.reopen_ms:
                    self.reopening, self.reopened = False, True
                    self.may_speak.clear()
                    self.log(event="turn-reopened", held=True)
                if self.in_speech and self.pending and not self.commit.is_set() and self.speech_ms >= self.a.min_speech:
                    self.reply.cancel()
                    self.pending = False
                    self.log(event="turn-continued")
                if self.in_speech and self.pressed and self.talking():
                    self.log(event="interrupted", by="press")
                    self.interrupt()
                elif self.in_speech and self.talking() and not self.paused:
                    self.barge_ms += 32
                    if self.barge_ms >= self.a.barge and not self.own_voice():
                        self.paused, self.paused_at = True, time.time()
                        self.log(event="paused")
            elif p < self.a.vad_off:
                self.silence_ms += 32
                if self.a.vad_reset_ms and self.silence_ms % self.a.vad_reset_ms < 32:
                    self.vad.reset_fresh()
                self.speech_ms = self.barge_ms = 0
        if self.utt:
            self.utt.extend(pcm)
            if self.stt:
                await self.off(self.stt.feed, pcm)
        await self.settle()
        self.preroll = (self.preroll + pcm)[-int(self.a.preroll * RATE) * 2:]

    async def stops_after_all(self):
        """--stop-words, before delta goes on after they spoke over it: the whole of what they said, not the partial of
        0.25 s after they stopped, which often held only the first word («Tamam, kaptan ödey...» was taken as a
        backchannel). Their stop word stops it; three real words stop it only if it had paused, as before."""
        heard = (await self.off(self.stt.text)).get(self.lang, "")
        words = [w for w in re.findall(r"\w+", heard.lower()) if w not in self.pack.BACKCHANNEL and not self.echoed(w)]
        if self.more_than_bye(heard) if self.bye_waiting else self.stop_heard(heard) or self.paused and len(words) >= self.a.barge_words:
            self.log(event="interrupted", heard=heard, by="stop-words")
            return True
        return False

    async def settle(self):
        """What the silence so far decides about the turn."""
        if self.paused and self.in_speech:
            heard = self.stt.partial(self.lang) if self.stt else ""
            words = [w for w in re.findall(r"\w+", heard.lower()) if w not in self.pack.BACKCHANNEL and not self.echoed(w)]
            if self.more_than_bye(heard) if self.bye_waiting else self.pack.STOP.search(heard) or self.stop_heard(heard) or len(words) >= self.a.barge_words or time.time() - self.paused_at > self.a.barge_max:
                self.paused = False
                self.log(event="interrupted", heard=heard)
                self.interrupt()
        if self.discard and self.silent(self.a.spec_ms):
            self.discard, self.in_speech, self.utt = False, False, bytearray()
            self.log(event="ignored", heard=self.stt.partial(self.lang) if self.stt else "", why="our opening line is on its way")
        if self.reopening and self.silent(self.a.spec_ms):
            self.reopening, self.in_speech = False, False
            self.log(event="ignored", heard=self.stt.partial(self.lang) if self.stt else "")
        if self.reopened and self.silent(self.a.spec_ms):
            self.reopened = False
            heard = (await self.off(self.stt.text)).get(self.lang, "") if self.stt else ""
            new = self.added(heard)
            if new or not self.reply or self.reply.done():
                self.reply and self.reply.cancel()
                self.log(event="turn-redone", heard=heard, new=new)
            else:
                self.in_speech = False
                self.log(event="kept", heard=heard)
            self.may_speak.set()
        if self.in_speech and self.silent(self.a.spec_ms) and self.talking() and self.a.stop_words and self.stt and await self.stops_after_all():
            self.paused = False
            self.interrupt()
        if self.in_speech and self.silent(self.a.spec_ms) and self.talking():
            self.in_speech, self.utt = False, bytearray()
            self.log(event="resumed" if self.paused else "backchannel", heard=self.stt.partial(self.lang) if self.stt else "")
            self.paused = False
        if self.in_speech and self.silent(self.a.spec_ms) and not self.pending:
            self.pending = True
            text = await self.off(self.stt.text) if self.stt else None
            self.commit.clear()
            self.reply = asyncio.create_task(self.respond(bytes(self.utt), time.time() - self.silence_ms / 1000, text, self.voiced_ms))
            self.reply.add_done_callback(lambda t: t.cancelled() or not t.exception() or self.log(event="error", error=repr(t.exception())))
        if self.in_speech and self.silent(self.a.end_ms):
            self.commit.set()
        if self.commit.is_set() and self.pending:
            self.in_speech = False

    async def whisper(self, utt, lang, prompt="", timeout=None):
        form = aiohttp.FormData()
        form.add_field("file", wav_bytes(normalize(utt)), filename="u.wav", content_type="audio/wav")
        form.add_field("model", STT_MODEL), form.add_field("language", lang)
        if prompt:
            form.add_field("prompt", prompt)
        async with self.http.post(STT_URL, data=form, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
            return (await r.json()).get("text", "").strip()

    async def second_reading(self, utt, text, voiced_ms):
        """The streaming transcriber has no context for a lone word: an isolated «evet» came out empty, «Ö» or «O this»
        about half the time on real calls, while Whisper turbo heard «Evet». So a short turn is read again by Whisper
        with delta's last sentence as its prompt, and Claude gets both readings. Whisper can copy its prompt into a short
        sound ("Evet, bugün salı..." for 0.35 s), so a reading with more words than the speech could hold is thrown
        away. Speech that neither could read still reaches Claude as UNCLEAR instead of being dropped, so it asks again
        instead of waiting."""
        if voiced_ms > self.a.second_ms and len(re.findall(r"\w+", text)) > 1 or not text and voiced_ms < self.a.unclear_ms:
            return text
        last = next((m["content"] for m in reversed(self.history) if m["role"] == "assistant" and m["content"]), "")
        question = re.split(r"(?<=[.!?…])\s+", last.strip())[-1][-200:]
        second = ""
        if STT_URL:
            try:
                second = await self.whisper(utt, self.lang, question, timeout=2.5)
            except Exception as e:
                self.log(event="second", error=repr(e))
        heard, p = second, self.pack
        if p.WHISPER_JUNK.search(second) or len(re.findall(r"\w+", second)) > max(2, voiced_ms // 150):
            second = ""
        self.log(event="second", stream=text, whisper=heard, used=bool(second), voiced_ms=voiced_ms)
        norm = lambda t: re.sub(r"\W+", " ", t.lower()).strip()
        if not second or norm(second) == norm(text):
            return text or (p.UNCLEAR if voiced_ms >= self.a.unclear_ms else "")
        return fill(p.SECOND_TOO if text else p.SECOND_ONLY, text=text, second=second)

    async def long_reading(self, utt, text, voiced_ms):
        """A longer turn read by Whisper too (--second-all), prompted with the words the speaker's transcriber gets wrong.
        Neither transcriber is safe alone, each wins some turns, so Claude gets this as a note beside their words, as with
        a language's other transcriber: the words on screen and the turn checks stay the streaming ones. It holds the commit
        only if Whisper is slower than the commit wait, and a late one is dropped. It starts a moment into the pause: most
        pauses end by then, and an abandoned request still queues the ones behind it on the server."""
        await asyncio.sleep(SECOND_DELAY)
        start = time.monotonic()
        try:
            heard = await self.whisper(utt, self.lang, STT_WORDS, timeout=SECOND_WAIT)
        except Exception as e:
            self.log(event="second", error=repr(e), long=True, ms=round((time.monotonic() - start) * 1000))
            return ""
        squash = lambda t: re.sub(r"\W+", "", t.lower())
        junk = self.pack.WHISPER_JUNK.search(heard) or len(re.findall(r"\w+", heard)) > max(2, voiced_ms // 150)
        used = not junk and squash(heard) != squash(text)
        self.log(event="second", stream=text, whisper=heard, used=used, junk=bool(junk), long=True, voiced_ms=voiced_ms, ms=round((time.monotonic() - start) * 1000))
        return fill(self.pack.SECOND_TOO, text="", second=heard) if used else ""

    async def respond(self, utt, ended, text=None, voiced_ms=0):
        self.moving = False
        if (picked := self.picked()) != self.voices:
            self.voices, self.cache = picked, {}
            self.log(event="voice", voices=picked)
            asyncio.create_task(self.render(self.phrases()))
        timing = {"speech_end": round(ended - self.t0, 3), "utt_s": round(len(utt) / 2 / RATE, 2)}
        mark = lambda k: timing.__setitem__(k, round(time.time() - ended, 3))
        if text is None:
            text = await self.whisper(utt, self.lang)
        p, others, also = self.pack, {}, ""
        if isinstance(text, dict):
            others = {code: heard for code, heard in text.items() if code != self.lang and heard}
            text = text.get(self.lang, "")
            if p.GARBLES_OTHERS:
                also = "".join(fill(self.packs[code].ALSO_HEARD, heard=heard) for code, heard in others.items() if agreement(heard, text) < SAME_SPEECH)
            if self.a.second_ms and utt:
                text = await self.second_reading(utt, "" if p.HALLUCINATIONS.search(text) else text, voiced_ms)
            if STT_URL and self.lang in self.a.second_all and utt and voiced_ms > self.a.second_ms and len(re.findall(r"\w+", text)) > 1:
                also += await self.long_reading(utt, text, voiced_ms)
        mark("stt")
        if p.HALLUCINATIONS.search(text + also):
            self.log(event="dropped", text=text, **timing)
            return
        if self.echo(text):
            self.log(event="dropped", text=text, why="delta's own voice coming back", **timing)
            return
        if self.who and (self.wants_back(text, p) or any(self.wants_back(heard, self.packs[code]) for code, heard in others.items())):
            await self.commit.wait()
            self.log(event="line-back", text=text, **timing)
            self.ask_line(ASSISTANT)
            return
        return await self.respond_claude(text, timing, mark, also)

    async def respond_claude(self, text, timing, mark, also=""):
        """Claude talks: its text streams into TTS sentence by sentence. Nothing is sent before the turn is
        committed (a message to Claude can't be taken back); a tool call gets a spoken progress line."""
        await self.commit.wait()
        mark("committed")
        p = self.pack
        if self.line_check(text):
            self.line_checks += 1
            self.checked.append(text)
            self.canned_at = time.monotonic()
            self.say(p.LINE_OK, self.cache[p.LINE_OK])
            self.log(event="line-check", text=text, **timing)
            self.history += [{"role": "user", "content": text}, {"role": "assistant", "content": p.LINE_OK}]
            return
        sent = (text + also).strip()
        if self.unfinished:
            sent = fill(p.HALF_SENT, text=sent)
        elif self.cut and self.heard is not None:
            sent = fill(p.CUT_OFF, heard=self.heard, text=sent)
        if self.checked:
            sent = fill(p.LINE_TESTED, tried=" / ".join(self.checked), line_ok=p.LINE_OK, text=sent)
            self.checked = []
        self.cut, self.heard, self.unfinished = False, None, text
        self.log(event="user", text=sent, **timing)
        if not self.moving:
            self.show(you=text)
        self.history += [{"role": "user", "content": sent}, {"role": "assistant", "content": ""}]
        self.spoken = []
        reply, buf, first, after = "", "", True, ""
        spoken = lambda t: LINE_TAG.sub("", self.hangup.sub("", t)).strip()
        self.tools_open = 0
        wants_ack = self.a.ack_ms and not self.opening and not self.holding and not self.moving \
            and len(re.findall(r"\w+", re.sub(r"\s*\(.*", "", text))) > 2
        before = next((h["content"] for h in reversed(self.history[:-2]) if h["role"] == "assistant" and h["content"]), "")
        chosen = asyncio.create_task(self.picker.filler(p, before[-200:], text, lambda t: t in self.cache)) \
            if wants_ack and self.picker and not self.picker.off else None
        ack = asyncio.create_task(self.ack_later(lambda: first and not reply, chosen) if wants_ack else asyncio.sleep(0))
        hold = asyncio.create_task(self.hold_on())
        progress, given, order = None, None, asyncio.Lock()

        async def speak(sentence, gap=False):
            nonlocal first
            if not sentence:
                return
            ack.cancel()
            async with order:
                if first:
                    mark("first_audio")
                    await self.may_speak.wait()
                    self.live, self.utt, self.opening, self.unfinished, first = True, bytearray(), False, None, False
                item, head, rate = [sentence, 0, False, b""], b"", self.rate
                self.speaking.append(item)
                if gap:
                    self.queue(item, bytes(int(rate * self.a.topic_pause_ms / 1000) * 2), rate=rate)
                async for chunk in self.tts(sentence, rate=rate):
                    if head is not None:
                        head += chunk
                        if len(head) < self.a.prebuffer * rate * 2 / 1000:
                            continue
                        chunk, head = head, None
                    self.queue(item, chunk, rate=rate)
                self.queue(item, head or b"", last=True, rate=rate)

        async def tool_progress(name, banked):
            """The picker writes what the tool is doing once its input is in (or after picker_input_ms from its name
            alone); a miss or a rejected line plays the pack's line instead. Said only while nothing of the reply
            has been, and the tool is still open."""
            try:
                got = await asyncio.wait_for(asyncio.shield(given), self.a.picker_input_ms / 1000)
            except TimeoutError:
                got = ""
            line = await self.picker.tool_line(p, name, got[:400], text, self.tool_said)
            if line is FALLBACK:
                line = banked
            if line and first and not reply and self.tools_open and not self.canned_lately():
                self.canned_at = time.monotonic()
                self.tool_said.append(line)
                self.log(event="progress", text=line, by="picker" if line != banked else "pack")
                await asyncio.shield(speak(line))

        try:
            async for kind, value in self.brain.turn(sent):
                if "llm_first" not in timing and value.strip():
                    mark("llm_first")
                if kind == "tool":
                    self.log(event="tool", name=value)
                    self.show(tool=value)
                    self.tools_open += 1
                    self.tool_name = value
                    after = ""
                    banked = next(t for r, t in self.pack.PROGRESS if re.search(r, value, re.I))
                    if buf.strip():
                        await speak(spoken(buf))
                        buf = ""
                    elif first and (not progress or progress.done()) and self.picker and not self.picker.off and not self.canned_lately():
                        given = asyncio.get_running_loop().create_future()
                        progress = asyncio.create_task(tool_progress(value, banked))
                    elif first and banked and not self.canned_lately():
                        self.canned_at = time.monotonic()
                        await speak(banked)
                    continue
                if kind == "tool_input":
                    if given and not given.done():
                        given.set_result(value)
                    continue
                if kind == "tool_done":
                    self.tools_open = max(0, self.tools_open - 1)
                    continue
                self.tools_open = 0
                buf += value
                reply += value
                self.history[-1]["content"] = reply
                if tag := LANG_TAG.search(buf):
                    buf = buf.replace(tag.group(), "")
                    if tag.group(1) != self.lang and tag.group(1) in self.packs:
                        self.lang = tag.group(1)
                        self.log(event="language", lang=self.lang)
                        self.show()
                while cut := self.piece_end(buf, first):
                    gap = not first and self.topic_starts(after, buf)
                    sentence, after, buf = buf[:cut].strip(), buf[max(0, cut - 2):cut], buf[cut:]
                    await speak(spoken(sentence), gap)
            if spoken(buf):
                await speak(spoken(buf), not first and self.topic_starts(after, buf))
        except asyncio.CancelledError:
            [t.cancel() for t in (ack, hold, progress, chosen) if t]
            if not self.leaving:
                self.brain.interrupt()
            raise
        [t.cancel() for t in (ack, hold, progress, chosen) if t]
        self.unfinished, self.moving = None, False
        self.log(event="delta", text=reply, **timing)
        if tag := LINE_TAG.search(reply):
            self.history[-1]["content"] = LINE_TAG.sub("", reply).strip()
            while self.speaking:
                await asyncio.sleep(0.1)
            self.ask_line(tag.group(1))
        if self.hangup.search(reply):
            while self.speaking:
                await asyncio.sleep(0.1)
            await self.bye_wait()
            self.log(event="hangup")
            await self.send_cmd({"cmd": "hangup"})

    async def bye_wait(self):
        """--bye-wait-ms: after delta's goodbye, room for theirs: hang up once they have said it (0.5 s after they stop),
        or after bye_wait_ms if they say nothing, 5 s at most. Hanging up 0.5 s after its own last word left their
        goodbye unsaid on most calls. Words that are more than a goodbye («Bi de şunu...») keep the call (more_than_bye)."""
        if not self.a.bye_wait_ms:
            await asyncio.sleep(0.5)
            return
        self.bye_waiting, start = True, time.monotonic()
        try:
            while (now := time.monotonic()) - start < 5:
                spoke = self.last_heard > start
                if not self.in_speech and (now - self.last_heard >= .5 if spoke else now - start >= self.a.bye_wait_ms / 1000):
                    return
                await asyncio.sleep(0.05)
        finally:
            self.bye_waiting = False

    def more_than_bye(self, heard):
        words = [w for w in re.findall(r"\w+", heard.lower()) if w not in self.pack.BACKCHANNEL and not self.pack.BYE.fullmatch(w)]
        return len(words) >= self.a.barge_words

    def picked(self):
        return {**voices(self.a), **self.line_voices}

    def wants_back(self, text, pack):
        return len(re.findall(r"\w+", text)) <= BACK_WORDS and bool(pack.LINE_BACK.search(text))

    def ask_line(self, to):
        """Who they talk to, from a tag in a reply, their words, or a tap on the app; before the call is up, for its start."""
        if not self.speaking_task:
            self.first_line = to
        else:
            asyncio.create_task(self.move_line(to))

    def beep(self, up):
        """Two short notes on every move: they hear the line change before anyone speaks."""
        notes = (660, 880) if up else (880, 660)
        t = np.arange(int(self.rate * .09)) / self.rate
        fade = np.minimum(1, np.minimum(t, t[::-1]) / .01)
        pcm = np.concatenate([np.sin(2 * np.pi * f * t) * fade for f in notes])
        return (pcm * 5000).astype(np.int16).tobytes()

    async def open_line(self, name):
        """The hub puts the agent's conversation on the line. None and why, for one that can't take it now."""
        try:
            async with self.http.post(f"{self.a.hub}/lines/{name}", timeout=aiohttp.ClientTimeout(total=30)) as r:
                body = await r.json(content_type=None)
                return (body, None) if r.status == 200 else (None, body)
        except Exception as e:
            self.log(event="error", error=repr(e))
            return None, {"why": "off", "title": name}

    def recent(self, turns=4):
        """The last turns as plain lines, so whoever takes the line knows what was just said."""
        out = []
        for h in self.history[-turns:]:
            text = LINE_TAG.sub("", h["content"]).strip()
            if text and not text.startswith("["):
                out.append(f"{'them' if h['role'] == 'user' else 'answer'}: {text[:240]}")
        return " / ".join(out) or "-"

    async def move_line(self, to):
        """Moves the call to an agent's conversation, or back to the assistant: the same talker, ears and turn-taking,
        another brain and voice. A brain moved away from keeps its turn running, its work isn't cut, and stays open
        until the call ends, so coming back is instant."""
        to = None if to in ("", ASSISTANT) else to
        p = self.pack
        if self.guest or to == self.who:
            return
        self.show(line=to or ASSISTANT, moving=True)
        info = {}
        if to:
            info, why = await self.open_line(to)
            if not info:
                self.show(line=self.who or ASSISTANT, moving=False)
                self.log(event="line-refused", to=to, why=why)
                key = p.LINE_BUSY if why.get("why") == "busy" else p.LINE_OFF
                await self.turn_about(fill(key, name=why.get("title") or to, doing=why.get("activity") or why.get("state") or ""))
                return
        was, title, since, said = self.brain, self.title, self.line_since, self.recent()
        running = self.reply and not self.reply.done()
        self.leaving = True
        if running:
            self.reply.cancel()
            await asyncio.wait([self.reply])
        self.leaving = False
        if self.talking():
            self.interrupt_quietly()
        if was.busy:
            await was.send("note", p.LINE_LEFT)
        if to and to not in self.brains:
            self.brains[to] = HubBrain(self.a, self.http, to)
        self.brain, self.who = self.brains[to], to
        self.title, self.line_voices = (info.get("title") or to) if to else ASSISTANT, (info.get("voices") or {}) if to else {}
        self.line_since = time.monotonic() if to else 0.0
        self.voices, self.cache = self.picked(), {}
        await self.brains[None].send("line", to or "")
        self.log(event="line", to=to or ASSISTANT, voices=self.voices)
        self.show(line=to or ASSISTANT, title=self.title, person=info.get("person") or "", background=info.get("background") or "", color=info.get("color") or "", moving=False, said="", you="", **({"knock": ""} if not to else {}))
        if not to:
            self.knock = ""
        self.say("", self.beep(bool(to)))
        asyncio.create_task(self.render(self.phrases(), idle=True))
        minutes = max(1, round((time.monotonic() - since) / 60)) if since else 0
        await self.turn_about((fill(p.LINE_TO, was=title, said=said) if to else fill(p.LINE_BACK_TO, was=title, minutes=minutes, said=said)) + p.LINE_LANG)

    def interrupt_quietly(self):
        while not self.outbox.empty():
            self.outbox.get_nowait()
        self.speaking.clear()
        self.first_audio.clear()
        self.converting.clear()
        self.live = False
        if self.app:
            asyncio.ensure_future(self.send_cmd({"cmd": "flush"}))

    async def turn_about(self, text):
        """A turn nobody on the line said, for whoever has it now to speak to."""
        running = self.reply and not self.reply.done()
        if running:
            self.leaving = True
            self.reply.cancel()
            await asyncio.wait([self.reply])
            self.leaving = False
            self.interrupt_quietly()
        self.moving, self.cut, self.heard, self.unfinished = True, False, None, None
        self.commit.set()
        ended = time.time()
        timing = {"speech_end": round(ended - self.t0, 3), "utt_s": 0}
        self.reply = asyncio.create_task(self.respond_claude(text, timing, lambda k: timing.__setitem__(k, round(time.time() - ended, 3))))
        self.reply.add_done_callback(lambda t: t.cancelled() or not t.exception() or self.log(event="error", error=repr(t.exception())))

    def knocked(self, reason):
        """The assistant wants them while they are on the line with an agent: the note, in its voice, at the next pause."""
        self.knock = reason
        self.show(knock=reason or self.pack.LINE_KNOCK_ANY)
        self.log(event="knock", reason=reason)
        asyncio.create_task(self.say_knock(reason))

    async def say_knock(self, reason):
        while self.who and (self.speaking or self.in_speech or self.reply and not self.reply.done()):
            await asyncio.sleep(0.2)
        if not self.who:
            return
        line = fill(self.pack.LINE_KNOCK, reason=reason or self.pack.LINE_KNOCK_ANY)
        voice = voices(self.a)[self.lang]
        pcm = b"".join([c async for c in self.tts(line, voice=voice)])
        self.canned_at = time.monotonic()
        self.say("", self.beep(True) + pcm)

    async def hold_on(self):
        """While a tool runs and the line has been quiet for progress_ms, a short "still on it" line, at most
        progress_max a turn and progress_every apart. Tied to the tool being open, not to when the next tool
        starts: that fired just before the answer, which by then was Claude writing, not the tool working."""
        said, last = 0, 0.0
        while said < self.a.progress_max:
            await asyncio.sleep(0.1)
            now = time.monotonic()
            if self.tools_open and not self.speaking and not self.in_speech and now - max(self.last_voice, self.last_heard) >= self.a.progress_ms / 1000 \
                    and now - last >= self.a.progress_every_ms / 1000:
                line = self.picker.hold(self.pack, self.tool_name, said, lambda t: t in self.cache) if self.picker else FALLBACK
                if line is FALLBACK:
                    line = random.choice([h for h in self.pack.HOLD if h != getattr(self, "last_hold", None)])
                self.last_hold, said, last, self.canned_at = line, said + 1, now, now
                self.say(line, self.cache.get(line) or b"".join([c async for c in self.tts(line)]))
                self.log(event="hold", text=line)

    def canned_lately(self):
        return time.monotonic() - self.canned_at < self.a.canned_gap_ms / 1000

    async def ack_later(self, silent, chosen=None):
        """Claude is slower than a person: if nothing at all has come from it after ack_ms (silent()), a short thinking
        phrase ("Dur bakayım."), never the same one twice running and never within canned_gap_ms of another canned line
        (respond_claude decides when to try at all). They picked these over silence and a bare "Hmm" on real turns.
        With the picker, its choice (chosen, asked when the turn was sent) when it is in by then: a line, or silence
        for a bare yes; when it isn't, or it failed, one of the ACKS as before."""
        await asyncio.sleep(self.a.ack_ms / 1000)
        pick = FALLBACK
        if chosen:
            if chosen.done() and not chosen.cancelled() and not chosen.exception():
                pick = chosen.result()
            else:
                chosen.cancel()
                self.picker.miss("filler", "not in by ack time")
        if pick and pick is not FALLBACK and pick not in self.cache:
            pick = FALLBACK
        if pick is not FALLBACK:
            if pick and not self.speaking and not self.in_speech and silent() and not self.canned_lately():
                self.last_ack, self.canned_at = pick, time.monotonic()
                self.say("", self.cache[pick])
                self.log(event="ack", text=pick, by="picker")
            return
        ready = [a for a in self.pack.ACKS if a in self.cache and a != self.last_ack]
        if not self.speaking and not self.in_speech and ready and silent() and not self.canned_lately():
            self.last_ack, self.canned_at = random.choice(ready), time.monotonic()
            self.say("", self.cache[self.last_ack])
            self.log(event="ack", text=self.last_ack)

    def call_situation(self):
        """What the picker chooses a greeting by: the clock, and how long ago their last call ended."""
        now, ago = time.localtime(), None
        try:
            with open(os.path.join(self.a.out, "last-call.json")) as f:
                ago = time.time() - json.load(f)["end"]
        except (OSError, ValueError, KeyError):
            pass
        days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        last = "unknown" if ago is None else f"{round(ago / 60)} minutes ago" if ago < 3600 else \
            f"{round(ago / 3600)} hours ago" if ago < 86400 else f"{round(ago / 86400)} days ago"
        return f"Time: {time.strftime('%H:%M', now)}, {days[now.tm_wday]}. His last call ended {last}."

    def back_greeting(self):
        """--back-min: the user is greeted like someone delta talks to all day, not introduced to: within that many
        minutes of their last call a short line (GREETING_BACK), otherwise a casual one (GREETING_HIM), each list in turn,
        none again until all have played. A guest is greeted by what the guest list says they are called
        (GREETING_GUEST, which still says who is answering), or with GREETING."""
        if self.guest:
            called = guest_called(self.guest)
            return fill(self.first.GREETING_GUEST, guest=called) if called else None
        if not self.a.back_min:
            return None
        try:
            with open(os.path.join(self.a.out, "last-call.json")) as f:
                soon = time.time() - json.load(f)["end"] <= self.a.back_min * 60
        except (OSError, ValueError, KeyError):
            soon = False
        kind, lines = ("back", self.first.GREETING_BACK) if soon else ("him", self.first.GREETING_HIM)
        if not lines:
            return None
        path = os.path.join(self.a.out, f"greeting-{kind}.json")
        try:
            with open(path) as f:
                n = int(json.load(f)["next"])
        except (OSError, ValueError, KeyError):
            n = 0
        with open(path, "w") as f:
            json.dump({"next": (n + 1) % len(lines)}, f)
        return lines[n % len(lines)]

    def save(self):
        if not self.t0:
            return
        if self.answered_at and not self.guest:
            with open(os.path.join(self.a.out, "last-call.json"), "w") as f:
                json.dump({"end": time.time()}, f)
        if self.speaking_task:
            self.speaking_task.cancel()
        n = max(len(self.track["in"]), len(self.track["out"]))
        l, r = (np.frombuffer(bytes(self.track[s]).ljust(n, b"\0"), np.int16) for s in ("in", "out"))
        with wave.open(os.path.join(self.dir, "call.wav"), "wb") as w:
            w.setnchannels(2), w.setsampwidth(2), w.setframerate(RATE), w.writeframes(np.stack([l, r], 1).tobytes())
        json.dump(self.history, open(os.path.join(self.dir, "history.json"), "w"), ensure_ascii=False, indent=1)
        print(f"saved {self.dir}/", flush=True)

    async def warm(self):
        await self.prerender()
        asyncio.create_task(self.render(self.phrases(), rate=APP_RATE))

    def phrases(self, first=True, rest=True):
        said = lambda p: [(t, p.code) for t in [p.GREETING, *p.GREETING_BACK, *p.GREETING_HIM, p.LINE_OK, *p.FILLERS, *p.HOLD, *[t for _, t in p.PROGRESS if t]]]
        lines = said(self.first) if first else []
        picks = [(t, p.code) for p in self.packs.values() for t in bank_lines(p)] if self.picker else []
        return lines + ([(t, p.code) for p in self.packs.values() for t in p.ACKS] + [l for p in self.packs.values() if p is not self.first for l in said(p)] + picks if rest else [])

    async def prerender(self):
        await self.render(self.phrases(rest=False))
        self.greeting = self.cache.get(self.first.GREETING, b"")
        asyncio.create_task(self.render(self.phrases(first=False)))

    async def render(self, lines, rate=None, idle=False):
        """Into the cache, through a disk copy per voice, engine and text (Higgs renders the same text identically,
        and a Talk lives for one call, so without it every call re-rendered every phrase). The thinking phrases
        render in the background: warm() blocks the bridge's socket, and once it took ~37 s the bridge dropped it
        every time, so no call was answered. With another rate than the call's it only fills the disk copies (the app
        line's 24 kHz ahead of an app call), and stops once a call is on, so it never holds up the call's own voice."""
        os.makedirs(PHRASES, exist_ok=True)
        voices, rate = self.voices, rate or self.rate
        for t, lang in lines:
            ahead = rate != self.rate
            if ahead and self.t0:
                return
            if not ahead and t in self.cache:
                continue
            voice, engine = voices[lang], self.engine(lang)
            if engine == "remote":
                engine += os.environ.get("TTS_REMOTE_URL", "")
            made = [os.stat(f).st_mtime_ns for f in (f"{HIGGS_VOICES}/{voice}.wav", f"{HIGGS_VOICES}/prompt_text") if os.path.exists(f)]
            if voice in shipped_voices():
                made.append(os.stat(PERSONS).st_mtime_ns)
            key = hashlib.sha1(f"{voice}|{made}|{engine}|{t}{'' if rate == RATE else f'|{rate}'}".encode()).hexdigest()[:20]
            path = os.path.join(PHRASES, key + ".pcm")
            if os.path.exists(path):
                pcm = open(path, "rb").read()
            elif idle and await self.until_idle(voices) is False:
                return
            elif pcm := b"".join([c async for c in self.tts(t, lang, voice, rate)]):
                open(path + ".tmp", "wb").write(pcm)
                os.replace(path + ".tmp", path)
            if self.voices is not voices or rate != self.rate:
                if ahead:
                    continue
                return
            if pcm:
                self.cache[t] = pcm

    async def until_idle(self, voices):
        """Rendering a new voice's phrases must not hold up the words of the call: one request is voiced at a time."""
        while self.speaking or self.in_speech or (self.reply and not self.reply.done()):
            await asyncio.sleep(0.3)
            if self.voices is not voices:
                return False

    def open(self):
        if (names := saved_names(SETTINGS)) != self.names:
            self.names, self.greeting = names, b""
            self.packs.update(language_packs(self.a))
            self.first = self.packs[self.first.code]
        if (lang := first_language(SETTINGS, self.packs, self.a.lang)) != self.first.code:
            self.lang, self.first, self.greeting = lang, self.packs[lang], b""
        if (picked := self.picked()) != self.voices:
            self.voices, self.cache, self.greeting = picked, {}, b""
        self.t0 = t = time.time()
        name = lambda t: os.path.join(self.a.out, f"talk-{time.strftime('%Y%m%d-%H%M%S', time.localtime(t))}")
        while os.path.exists(name(t)):
            t += 1
        self.dir = name(t)
        os.makedirs(self.dir)
        asyncio.ensure_future(self.send_cmd({"cmd": "folder", "id": os.path.basename(self.dir)}))
        self.turns = open(os.path.join(self.dir, "turns.jsonl"), "a")
        self.debug, self.frames, self.vad_max = open(os.path.join(self.dir, "debug.jsonl"), "a"), 0, 0.0
        self.commit.set()

    def dialing(self, reason=""):
        """A call delta makes: the opening is written and voiced while it rings, so it plays as soon as they have
        said their «Alo» instead of three or more seconds of Claude after they picked up. Its audio waits in the
        outbox until then (the speaker isn't running yet, and holds it after that)."""
        self.open()
        self.log(event="outbound", **({"guest": self.guest} if self.guest else {}))
        self.opening = self.holding = True
        p = self.pack
        opening = fill(p.OUTBOUND_GUEST, guest=self.guest, reason=reason or p.NO_REASON) if self.guest else p.OUTBOUND
        self.reply = asyncio.create_task(self.respond(b"", time.time(), opening))
        self.reply.add_done_callback(lambda _: setattr(self, "opening", False))

    async def start(self):
        if not self.t0:
            self.open()
        self.answered_at = time.time()
        self.log(event="answered", **({"guest": self.guest} if self.guest else {}))
        asyncio.create_task(self.brain.start())
        self.speaking_task = asyncio.create_task(self.speaker())
        if self.holding:
            asyncio.create_task(self.release())
            return
        if self.first_line:
            asyncio.create_task(self.move_line(self.first_line))
            return
        hello = self.back_greeting() or self.first.GREETING
        if self.picker and await self.picker.check(self.first) and not self.guest:
            picked = await self.picker.greeting(self.first, self.call_situation(), lambda t: t in self.cache)
            if picked is not FALLBACK:
                hello = picked
        if hello == self.first.GREETING:
            if not self.greeting:
                self.greeting = self.cache[hello] = b"".join([c async for c in self.tts(hello)])
            audio = self.greeting
        else:
            audio = self.cache.get(hello) or b"".join([c async for c in self.tts(hello)])
            self.cache[hello] = audio
        self.hello = hello, audio
        self.history.append({"role": "assistant", "content": hello})
        asyncio.create_task(self.greet())

    async def greet(self):
        """The greeting waits for the far end's audio to start (the first frame that is not digital zero), up to
        greet_wait_ms: a WhatsApp call goes active before its audio flows, and on one call the greeting
        played into the 4.4 s before it did, so their first words were «Alo? Ses geliyor mu?». The app line has its own
        hold and is not waited for; a phone or WhatsApp line is normally up within 0.2 s."""
        start = time.monotonic()
        while not self.app and not self.line_up and time.monotonic() - start < self.a.greet_wait_ms / 1000:
            await asyncio.sleep(0.02)
        if self.who:
            return
        self.log(event="greeting", waited_ms=round((time.monotonic() - start) * 1000), line_up=self.line_up)
        self.say(*self.hello)

    async def release(self):
        """Let the prepared opening play once they have had their «Alo»: when they stop talking, or after
        hold_ms if they say nothing, and never later than hold_max_ms."""
        start, heard = time.monotonic(), False
        while self.holding:
            waited = (time.monotonic() - start) * 1000
            talking = self.in_speech or self.discard
            heard = heard or talking
            if waited >= self.a.hold_max_ms or (not heard and waited >= self.a.hold_ms) or (heard and not talking):
                self.holding = False
                self.log(event="released", waited_ms=round(waited))
            await asyncio.sleep(0.02)


ANSWER = [re.sub(r"\D", "", n)[-10:] for n in os.environ.get("TALK_ANSWER", "").split(",") if n.strip()]


def language_packs(args):
    """Each language's pack, named by the service's environment or else by atc's Settings."""
    assistant, user = saved_names(SETTINGS)
    return {code: Pack(code, args.assistant or assistant, args.user or user) for code in dict.fromkeys([args.lang, *args.also])}


def shipped_voices():
    """The voices persons.json defines: when one is re-recorded there, its phrases are rendered again."""
    with open(PERSONS, encoding="utf-8") as f:
        return json.load(f)["voices"]


def voices(args):
    """The voice per language: the last pick (voice.json), else the service's environment."""
    try:
        picked = json.load(open(VOICES))
    except (OSError, ValueError):
        picked = {}
    return {code: picked.get(code) or setting("TALK_TTS_VOICE", code, args.lang) for code in args.packs}


def allowed(number):
    """The user's own number (TALK_ANSWER; empty: only the app line is their)."""
    return bool(number) and re.sub(r"\D", "", number)[-10:] in ANSWER


def guests():
    """atc's guest list, read fresh so `atc guest add` applies at once: (name, number, what they are called) per guest,
    from `name number [called]` lines."""
    try:
        lines = open(GUESTS).read().splitlines()
    except OSError:
        return []
    return [(p[0], p[1], " ".join(p[2:])) for p in (line.split("#")[0].split() for line in lines) if len(p) >= 2]


def guest_of(number):
    """The guest's name if this number is in atc's guest list."""
    tail = re.sub(r"\D", "", number or "")[-10:]
    return next((name for name, num, _ in guests() if tail and re.sub(r"\D", "", num)[-10:] == tail), None)


def guest_called(name):
    return next((called for n, _, called in guests() if n == name and called), None)


async def be_guest(talk, name):
    talk.guest = name
    await talk.brain.as_guest(name)


def call_over(talk):
    p = talk.pack
    return fill(p.CALL_OVER_GUEST, guest=talk.guest) if talk.guest else p.CALL_OVER


async def tell_brain_over(talk, note):
    for name, brain in talk.brains.items():
        if name:
            await brain.finish(talk.pack.CALL_ENDED + talk.pack.LINE_OVER if note else None)
    await talk.brains[None].finish(talk.pack.CALL_ENDED + note if note else None)


def line_of(event):
    """Which line an event is from: atc's app, WhatsApp, or the phone line (the bridge's own events carry no via)."""
    return event.get("via") or "phone"


async def his_other_call(http, args):
    """With a talker per line, whether the other line has them on a call already: the hub's phone channel (their assistant)
    holds one call at a time, so a second call of their rings out (the SIM, WhatsApp) or is ended as busy (the app)."""
    other = "device" if args.line == "app" else "app"
    try:
        async with http.get(re.sub(r"^ws", "http", args.url.rsplit("/", 1)[0]) + "/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
            line = (await r.json())["lines"][other]
    except Exception:
        return False
    return line["call"] != "idle" and (other == "app" or allowed(line.get("number")))


async def phone(args):
    """One call per run. Once the talker has taken or placed a call, events from another line are not its own: a
    guest's ring during their app call used to switch their call to guest-call and end it on the guest's idle. With --line
    it hears only that line, and another talker holds the other one."""
    url = args.url + (f"?line={args.line}" if args.line else "")
    async with aiohttp.ClientSession() as http, http.ws_connect(url, max_msg_size=0) as ws:
        talk = Talk(args, http, ws.send_bytes, lambda c: ws.send_str(json.dumps(c)))
        await talk.warm()
        if args.dial:
            await ws.send_str(json.dumps({"cmd": "dial", "number": args.dial}))
        active = ringing = False
        caller, reason, own = None, "", None
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                if active:
                    try:
                        started = time.perf_counter()
                        await talk.on_audio(msg.data)
                        talk.slowest = max(talk.slowest, time.perf_counter() - started)
                        await asyncio.sleep(0)  # with frames backed up, the loop never yields and delta's voice stops
                    except Exception as e:
                        talk.log(event="error", error=repr(e))
                continue
            event = json.loads(msg.data)
            if own and line_of(event) != own:
                print(json.dumps({"event": "another-line", "line": line_of(event), "own": own, "was": event}, ensure_ascii=False), flush=True)
                continue
            caller = event.get("number") or caller
            if event.get("out_rate") and event.get("call") != "idle":
                talk.set_rate(int(event["out_rate"]))
            talk.app = talk.app or event.get("via") == "app"
            if event.get("event") == "hold":
                talk.on_hold = bool(event.get("on"))
                talk.log(event="hold", on=talk.on_hold)
                continue
            if event.get("event") == "press":
                if active:
                    await talk.press(bool(event.get("down")))
                continue
            if event.get("event") == "line":
                talk.ask_line(event.get("to") or ASSISTANT)
                continue
            if event.get("event") == "interrupt":
                if talk.talking():
                    talk.log(event="interrupted", by="tap")
                    talk.interrupt()
                elif talk.reply and not talk.reply.done():
                    talk.log(event="cancelled", by="tap")
                    talk.reply.cancel()
                continue
            print(json.dumps(event, ensure_ascii=False), flush=True)
            if event.get("event") == "dialing" and not own and not talk.t0:
                own = line_of(event)
                if event.get("guest"):
                    reason = event.get("reason", "")
                    await be_guest(talk, event["guest"])
            if event.get("event") in ("state", "hello") and event.get("call") == "ringing" and not args.dial and not own:
                number = event.get("number") or caller
                if args.line and (event.get("via") == "app" or allowed(number)) and await his_other_call(http, args):
                    print(json.dumps({"event": "not-answered", "number": number, "why": "they are on a call on the other line"}), flush=True)
                    if event.get("via") == "app":
                        await ws.send_str(json.dumps({"cmd": "hangup"}))
                    continue
                guest = None if event.get("via") == "app" or allowed(number) else guest_of(number)
                if guest:
                    await be_guest(talk, guest)
                if event.get("via") == "app" or allowed(number) or guest:
                    own = line_of(event)
                    await ws.send_str(json.dumps({"cmd": "answer"}))
                else:
                    print(json.dumps({"event": "not-answered", "number": event.get("number") or caller}), flush=True)
            if event.get("call") == "ringing":
                ringing = True
            if event.get("call") == "offhook" and not ringing and not active and not talk.t0:
                own = own or line_of(event)
                talk.dialing(reason)
            if event.get("precise") == "active" and event.get("audio") and not active:
                active = True
                await talk.start()
            if (active or talk.t0) and event.get("call") == "idle":
                break
            if event.get("call") == "idle":
                own = None
        if not active and talk.reply and not talk.reply.done():
            talk.reply.cancel()
        talk.save()
        await tell_brain_over(talk, call_over(talk) if active else talk.pack.NOT_PICKED_UP if talk.t0 else None)


async def sim(args):
    """Feed a WAV as the caller in real time; delta's audio is only recorded."""
    with wave.open(args.sim) as w:
        pcm = w.readframes(w.getnframes())
    async with aiohttp.ClientSession() as http:
        async def drop(_): pass
        talk = Talk(args, http, drop, drop)
        await talk.warm()
        if args.sim_guest:
            await be_guest(talk, args.sim_guest)
        await talk.start()
        if args.sim_line:
            for at, to in (x.split("=") for x in args.sim_line):
                asyncio.get_running_loop().call_later(float(at), talk.ask_line, to)
        start = time.monotonic()
        presses = sorted((float(at), down) for hold in args.sim_press for at, down in zip(hold.split("-"), (True, False)))
        for n, i in enumerate(range(0, len(pcm) + RATE * 2 * args.tail, FRAME)):
            while presses and presses[0][0] <= n * 0.02:
                await talk.press(presses.pop(0)[1])
            await talk.on_audio(pcm[i:i + FRAME].ljust(FRAME, b"\0") if talk.pressed or not args.sim_press else bytes(FRAME))
            await asyncio.sleep(max(0, start + (n + 1) * 0.02 - time.monotonic()))
        talk.save()
        talk.brain.interrupt()
        await tell_brain_over(talk, talk.pack.SIM_OVER)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://127.0.0.1:8807/call")
    p.add_argument("--line", choices=["app", "device"], help="take calls on this line only (atc's app, or delta's SIM and WhatsApp), so a talker per line can each hold a call; none = both")
    p.add_argument("--dial")
    p.add_argument("--sim")
    p.add_argument("--sim-line", action="append", help="sim: SECONDS=NAME moves the line there at that time; repeatable")
    p.add_argument("--sim-press", action="append", default=[], help="sim: START-END seconds the talk button is held, the mic silent otherwise; repeatable")
    p.add_argument("--sim-guest", help="sim: play the caller as this guest (needs --brain hub)")
    p.add_argument("--out", default=".", help="where each call's folder goes")
    p.add_argument("--loop", action="store_true", help="phone: keep answering calls")
    p.add_argument("--tail", type=int, default=6, help="sim: seconds of silence after the WAV")
    p.add_argument("--vad-on", type=float, default=0.5)
    p.add_argument("--vad-off", type=float, default=0.35)
    p.add_argument("--min-speech", type=int, default=96, help="ms of speech before it counts")
    p.add_argument("--vad-fresh-peak", type=float, default=0.4, help="a window this loud (0-1) may also start speech on the fresh VAD state (0 = off)")
    p.add_argument("--vad-reset-ms", type=int, default=3000, help="ms of silence after which the fresh VAD state is reset")
    p.add_argument("--spec-ms", type=int, default=250, help="ms of silence that starts a speculative reply")
    p.add_argument("--end-ms", type=int, default=600, help="ms of silence that ends the caller's turn")
    p.add_argument("--brain", choices=["hub"], default="hub")
    p.add_argument("--hub", default="http://127.0.0.1:8820", help="atc's hub, the assistant's conversation")
    p.add_argument("--lang", default=os.environ.get("TALK_LANG") or "en", help="the call's first language: its pack in lang/, its transcriber, what it says first")
    p.add_argument("--also", action="append", default=(os.environ.get("TALK_ALSO") or "").split(), help="another language the call can switch to with [LANG:xx] (needs --stt stream); repeatable")
    p.add_argument("--assistant", default=os.environ.get("TALK_ASSISTANT"), help="what the assistant calls itself (default: Settings, then the pack's neutral name)")
    p.add_argument("--user", default=os.environ.get("TALK_USER"), help="what the assistant calls the user (default: Settings, then the pack's neutral name)")
    p.add_argument("--ack-ms", type=int, default=2500, help="ms after their turn with nothing from Claude before a thinking phrase (0 = never)")
    p.add_argument("--reopen-ms", type=int, default=700, help="ms of speech that take back a turn already sent to Claude")
    p.add_argument("--barge-words", type=int, default=3, help="words (not hı hı, evet...) that make an overlap a real interruption")
    p.add_argument("--picker", default=os.environ.get("TALK_PICKER", ""), help="the picker's llama.cpp server (picker.py): fillers, greetings, tool and hold lines; empty = today's rules")
    p.add_argument("--picker-ms", type=int, default=2000, help="ms the picker gets to choose a filler, from when the turn is sent")
    p.add_argument("--picker-greet-ms", type=int, default=400, help="ms the picker gets to choose the greeting")
    p.add_argument("--picker-tool-ms", type=int, default=1200, help="ms the picker gets to write a tool line")
    p.add_argument("--picker-input-ms", type=int, default=1000, help="ms to wait for a tool's input before the picker writes from its name alone")
    p.add_argument("--back-min", type=float, default=0,help="the user gets casual greetings (GREETING_HIM), short ones (GREETING_BACK) within this many minutes of their last call; 0 = GREETING for everyone")
    p.add_argument("--topic-pause-ms", type=int, default=0, help="extra silence before a piece that starts a new topic (paragraph break or TOPIC); 0 = off")
    p.add_argument("--bye-wait-ms", type=int, default=0, help="after a goodbye, wait this long for theirs before hanging up (0 = 0.5 s, the old way)")
    p.add_argument("--echo-order", action="store_true", help="drop a turn as delta's own echo only if it began while delta was audible and repeats its words in order")
    p.add_argument("--stop-words", action="store_true", help="their stop words (STOP_WORDS) count even when delta said one like it, and the whole of what they said is read before delta goes on")
    p.add_argument("--barge-max", type=float, default=2.0, help="s of paused overlap after which it counts as an interruption anyway")
    p.add_argument("--stt", choices=["whisper", "stream"], default="stream", help="whisper needs TALK_STT")
    p.add_argument("--second-ms", type=int, default=600, help="stream STT: a turn with at most this much speech, or one word, is read again by Whisper at TALK_STT, when it is set (0 = never)")
    p.add_argument("--second-all", action="append", default=[], metavar="LANG", help="stream STT: in this language read every longer turn with Whisper too, at TALK_STT with TALK_STT_WORDS as its prompt, and give Claude both when they differ; repeatable")
    p.add_argument("--unclear-ms", type=int, default=200, help="speech no transcriber could read still reaches Claude as unclear from this much on")
    p.add_argument("--preroll", type=float, default=0.8, help="s of audio before speech onset that goes into the turn")
    p.add_argument("--gain-db", type=float, default=6, help="stream STT: 0-8 dB read a real call best, 18+ distorts")
    p.add_argument("--prebuffer", type=int, default=0, help="ms of TTS audio to collect before playing a sentence (for TTS that only just keeps up)")
    p.add_argument("--chunk-sentences", type=int, default=2, help="sentences per piece sent to the voice after the first")
    p.add_argument("--lead-ms", type=int, default=120, help="audio kept queued on the phone ahead of playback")
    p.add_argument("--prebuffer-ms", type=int, default=400, help="a piece starts from silence once this much of it is queued")
    p.add_argument("--prebuffer-max-ms", type=int, default=700, help="... or this long after its first audio, whichever comes first")
    p.add_argument("--out-gain-db", type=float, default=6, help="delta's voice into the call")
    p.add_argument("--barge", type=int, default=300, help="ms of caller speech that pauses delta while it decides")
    p.add_argument("--canned-gap-ms", type=int, default=10000, help="ms after a thinking, progress or 'still on it' line before another thinking or progress line")
    p.add_argument("--progress-ms", type=int, default=8000, help="ms of quiet while a tool runs before a 'still on it' line")
    p.add_argument("--progress-every-ms", type=int, default=15000)
    p.add_argument("--progress-max", type=int, default=2, help="'still on it' lines per turn at most")
    p.add_argument("--greet-wait-ms", type=int, default=6000, help="call in: ms the greeting waits at most for the far end's audio to start")
    p.add_argument("--hold-ms", type=int, default=1500, help="call out: ms after they pick up before the opening plays if they say nothing")
    p.add_argument("--hold-max-ms", type=int, default=3000, help="call out: the opening plays by then even if they keep talking")
    a = p.parse_args()
    if a.stt == "whisper" and not STT_URL:
        p.error("--stt whisper needs TALK_STT")
    a.packs = language_packs(a)
    while True:
        try:
            asyncio.run(sim(a) if a.sim else phone(a))
        except (aiohttp.ClientError, ConnectionError) as e:
            if not a.loop:
                raise
            print(f"delta-call unreachable ({e!r}), retrying", flush=True)
            time.sleep(3)
        if not a.loop or a.sim or a.dial:
            break
