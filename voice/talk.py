#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["aiohttp", "numpy", "onnxruntime", "transformers", "sherpa-onnx", "huggingface_hub", "soxr"]
# ///
"""Conversation client for delta-call: answers the phone and talks, as a test bench for how human it feels.

  talk.py                      wait for a call, answer, converse
  talk.py --dial +90541...     call that number (must be in DELTA_CALL_DIAL_ALLOW)
  talk.py --sim caller.wav     no phone: play a WAV as the caller, to test the pipeline offline

Pipeline: Silero VAD on the downlink, utterance to Whisper (gpu), streamed LLM reply cut into
sentences, each sentence to TTS and paced into the uplink. The caller can cut in: speech while
delta talks stops the uplink and keeps only what was actually said in the history.
Every call leaves <out>/talk-<time>/: call.wav (left caller, right delta), turns.jsonl with timings.
"""
import argparse, asyncio, concurrent.futures, difflib, hashlib, io, json, os, random, re, time, wave
import aiohttp
import soxr, numpy as np, onnxruntime

RATE, FRAME = 16000, 640
APP_RATE = 24000
STT_URL = os.environ.get("TALK_STT", "http://gpu.example:11440/v1/audio/transcriptions")
STT_MODEL = os.environ.get("TALK_STT_MODEL", "whisper-large-v3-turbo")
LLM_URL = os.environ.get("TALK_LLM", "http://gpu.example:11434/v1/chat/completions")
LLM_MODEL = os.environ.get("TALK_LLM_MODEL", "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ")
TTS_URL = os.environ.get("TALK_TTS", "http://127.0.0.1:11450/v1/audio/speech")
TTS_MODEL = os.environ.get("TALK_TTS_MODEL", "speaches-ai/piper-tr_TR-fahrettin-medium")
TTS_VOICE = os.environ.get("TALK_TTS_VOICE", "fahrettin")
VAD_MODEL = os.path.expanduser("~/.cache/delta-talk/silero_vad.onnx")
TURN_MODEL = os.path.expanduser("~/.cache/delta-talk/smart-turn-v3.2-cpu.onnx")
EN_STT = os.path.expanduser("~/.cache/delta-talk/sherpa-onnx-streaming-zipformer-en-2023-06-26")
TTS_VOICE_EN = os.environ.get("TALK_TTS_VOICE_EN", "voice_b")
TTS_ENGINE = os.environ.get("TALK_TTS_ENGINE", "pocket")
TTS_PREFIX = os.environ.get("TALK_TTS_PREFIX", "")
TTS_ENGINE_EN = os.environ.get("TALK_TTS_ENGINE_EN", "higgs")
VOICES = os.path.expanduser("~/.local/state/delta-call/voice.json")
PHRASES = os.path.expanduser("~/.cache/delta-talk/phrases")
GUESTS = os.path.expanduser("~/.config/atc/guests")
HIGGS_VOICES = os.path.expanduser("~/srv/call-data/audiocpp/voices")
CPU = concurrent.futures.ThreadPoolExecutor(1)
LANG_TAG = re.compile(r"\[LANG:(en|tr)\]\s*")
UNFINISHED = re.compile(r"\b(şey|ve|ama|fakat|yani|için|ile|veya|ya da|mesela|hani|ee+|ı+|şöyle|çünkü|ki|da|de|and|but|so|because|um+|uh+|like|the|to|of|with|or)\W*$", re.I)
HALLUCINATIONS = re.compile(r"altyaz|abone ol|izlediğiniz için|^\W*$", re.I)
WHISPER_JUNK = re.compile(r"altyaz|abone ol|izlediğiniz için|teşekkür|thank|gracias|grazie|danke|dank|merci|obrigad|^\W*$", re.I)
UNCLEAR = "(kısa bir şey söyledi ama anlaşılmadı)"

SYSTEM = """Sen delta'sın: kullanıcının kendi bilgisayarlarında çalışan yapay zekâ asistanı. Şu an onunla telefonda konuşuyorsun.
Sesini bir telefon taşıyor; konuşmayı yazıya çevirme ve sesin desktop adlı sunucuda, düşünen model (Qwen) gpu adlı makinede çalışıyor.
Şimdilik yapabildiklerin: hava durumuna bakmak, tarihi ve saati söylemek, istenince telefonu kapatmak. Takvim, mesaj, arama gibi başka işleri henüz yapamıyorsun; sorulursa bunu dürüstçe ve kısaca söyle.

Nasıl konuşursun:
- Bir arkadaşla telefonda konuşur gibi: sen diye hitap et, samimi, sıcak, doğal. "Tamam", "hı hı", "tabii", "aa", "bak şimdi" gibi gündelik sözler kullanabilirsin.
- Kısa: çoğu cevap tek cümle, en fazla iki kısa cümle. Resmî ya da makine gibi kalıplar kullanma ("durumdayım", "bu sorguyu", "yardımcı olabilirim" gibi).
- Yazı dili yok: liste, madde, emoji, parantez, kısaltma, yüzde işareti kullanma. Sayıları yazıyla yaz.
- Araçtan gelen bilgiyi olduğu gibi okuma, sadece sorulanı söyle. Araç adlarını sesli söyleme.

Dikkat:
- Karşındakinin sözleri otomatik yazıya çevriliyor ve bazen yanlış çıkıyor ("sanık" aslında "sağanak", "Ankarada" aslında "Ankara'da" olabilir). Anlamı tahmin et; gerçekten anlamadıysan kısaca tekrar iste.
- "(sözünü keserek)" ile başlayan mesaj, seni o anda böldüğünü söyler: önceki cevabının sadece söylenen kısmını duydu. Yarım kalanı tekrarlama, yeni söylenene cevap ver.
- Mesajların başındaki köşeli parantez içindeki tarih ve saat gerçektir, sorulursa onu söyle.
- Asla bilgi uydurma. Hava sorulduğunda, daha önce baktıysan bile, her seferinde aracı çağır.
- Telefonu kapatman istenirse kısaca vedalaş ve kapatma aracını çağır."""
GREETING = "Alo, merhaba, ben delta."
LINE_OK = "Buradayım, sesin geliyor."
LINE_CHECK = set("alo allo aloo ses sesim sesimi geliyor gelmiyor mu mı musun musunuz misin mısın duyuyor duyuyormusun duymuyor "
                 "duyabiliyor beni orada orda burada hey hello".split())
LINE_CORE = set("alo allo aloo ses sesim sesimi duyuyor duyuyormusun duymuyor duyabiliyor orada orda hello".split())
OUTBOUND = "[kullanıcıyı arıyorsun, telefon çalıyor. Açıp «Alo» deyince ilk bu cevabını duyacak: kısaca selam ver, ben delta de ve neden aradığını söyle.]"
OUTBOUND_GUEST = ("[{guest}'yı kullanıcının isteğiyle sen arıyorsun, telefon çalıyor; sebep: {reason}. Açıp «Alo» deyince ilk bu cevabını "
                  "duyacak: selam ver, delta olduğunu ve neden aradığını kısaca söyle.]")
AYLAR = "Ocak Şubat Mart Nisan Mayıs Haziran Temmuz Ağustos Eylül Ekim Kasım Aralık".split()
GUNLER = "Pazartesi Salı Çarşamba Perşembe Cuma Cumartesi Pazar".split()
ACKS = {"tr": ["Şöyle.", "Dur bakayım.", "Hmm, bakayım.", "Şey, bakayım.", "Bakayım.", "Hmm, şöyle.", "Hmm, şimdi."],
        "en": ["Hmm, let me see.", "Let me see.", "So, let me see.", "Well, let me see.", "Okay, let me check.", "Hmm, so.", "Hmm, okay."]}
BACKCHANNEL = set("hı hıhı hm hmm evet tamam aynen he hee anladım peki ok okey doğru tabii yani şey e ee a aa "
                  "yeah yes yep uh huh mhm mm okay right sure got it i see".split())
STOP = re.compile(r"\b(dur|bekle|hayır|sus|bir dakika|bi dakika|yok|stop|kes|wait|hold on|no|stop it)\b", re.I)
FILLERS = ["Bakıyorum, bir saniye.", "Hemen bakıyorum.", "Bir saniye, bakayım."]
HOLD = ["Bakıyorum hâlâ.", "Biraz sürecek galiba.", "Hmm, biraz sürecek."]
HOME = ("the city", 0.0, 0.0)
TOOLS = [{"type": "function", "function": {
    "name": "hava_durumu", "description": "Bir yerin şu anki havası ve önümüzdeki günlerin tahmini. Yer verilmezse the city.",
    "parameters": {"type": "object", "properties": {"yer": {"type": "string", "description": "şehir ya da ilçe"}}}}},
    {"type": "function", "function": {"name": "telefonu_kapat", "description": "Vedalaştıktan sonra görüşmeyi bitirir.",
                                      "parameters": {"type": "object", "properties": {}}}}]
WMO = {0: "açık", 1: "çoğunlukla açık", 2: "parçalı bulutlu", 3: "kapalı", 45: "sisli", 48: "sisli", 51: "çiseleyen yağmur",
       53: "çiseleyen yağmur", 55: "çiseleyen yağmur", 61: "hafif yağmurlu", 63: "yağmurlu", 65: "kuvvetli yağmurlu",
       71: "hafif karlı", 73: "karlı", 75: "yoğun karlı", 80: "sağanak", 81: "sağanak", 82: "şiddetli sağanak",
       95: "gök gürültülü fırtına", 96: "dolu ile fırtına", 99: "dolu ile fırtına"}


async def run_tool(http, name, arguments):
    try:
        args = json.loads(arguments or "{}")
        if name != "hava_durumu":
            return f"bilinmeyen araç: {name}"
        place, lat, lon = HOME
        if args.get("yer"):
            async with http.get("https://geocoding-api.open-meteo.com/v1/search",
                                params={"name": args["yer"], "count": 1, "language": "tr", "countryCode": "TR"}) as r:
                hit = ((await r.json()).get("results") or [None])[0]
            if hit:
                place, lat, lon = hit["name"], hit["latitude"], hit["longitude"]
        async with http.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 3,
                "current": "temperature_2m,weather_code,wind_speed_10m",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"}) as r:
            w = await r.json()
        c, d = w["current"], w["daily"]
        days = [f"{t}: {WMO.get(code, code)}, en düşük {lo:.0f}, en yüksek {hi:.0f} derece, yağış ihtimali yüzde {p}"
                for t, code, lo, hi, p in zip(["bugün", "yarın", "öbür gün"], d["weather_code"], d["temperature_2m_min"], d["temperature_2m_max"], d["precipitation_probability_max"])]
        return f"{place}, şu an: {WMO.get(c['weather_code'], c['weather_code'])}, {c['temperature_2m']:.0f} derece, rüzgar {c['wind_speed_10m']:.0f} km/s. " + "; ".join(days)
    except Exception as e:
        return f"hata: {e!r}"


LOADED = {}


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
        self.s = once("vad", lambda: onnxruntime.InferenceSession(VAD_MODEL, providers=["CPUExecutionProvider"]))
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


class SmartTurn:
    """pipecat-ai/smart-turn v3: does this audio sound like a finished turn? Looks at the last 8 s, ~12 ms on CPU."""
    def __init__(self):
        from transformers import WhisperFeatureExtractor
        self.fx = WhisperFeatureExtractor(chunk_length=8)
        self.s = onnxruntime.InferenceSession(TURN_MODEL, providers=["CPUExecutionProvider"])

    def __call__(self, pcm):
        a = np.frombuffer(pcm, np.int16).astype(np.float32)[-8 * RATE:] / 32768
        f = self.fx(a, sampling_rate=RATE, return_tensors="np", padding="max_length", max_length=8 * RATE,
                    truncation=True, do_normalize=True).input_features.astype(np.float32)
        return float(self.s.run(None, {"input_features": f})[0].flatten()[0])


class StreamSTT:
    """Streaming transcription on CPU, fed every frame of the caller's turn, so the text is ready the moment the
    turn ends: mihuai/turkish-stt-66m-v2 for Turkish and, with --english, a streaming English Zipformer beside it
    (the call's language, which Claude switches with [LANG:en] / [LANG:tr], picks which one Claude gets)."""
    def __init__(self, gain_db, english):
        import sherpa_onnx
        from huggingface_hub import hf_hub_download
        get = lambda f: hf_hub_download("mihuai/turkish-stt-66m-v2", f)
        self.recs = {"tr": sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=get("tokens.txt"), encoder=get("encoder.int8.onnx"), decoder=get("decoder.int8.onnx"),
            joiner=get("joiner.int8.onnx"), num_threads=2, sample_rate=RATE, feature_dim=80,
            decoding_method="modified_beam_search")}
        if english:
            en, part = EN_STT, "epoch-99-avg-1-chunk-16-left-128.int8.onnx"
            self.recs["en"] = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=f"{en}/tokens.txt", encoder=f"{en}/encoder-{part}", decoder=f"{en}/decoder-{part}",
                joiner=f"{en}/joiner-{part}", num_threads=2, sample_rate=RATE, feature_dim=80,
                decoding_method="modified_beam_search")
        self.gain, self.s, self.heard = 10 ** (gain_db / 20), {}, {}

    def start(self, pcm=b""):
        self.s, self.heard = {lang: rec.create_stream() for lang, rec in self.recs.items()}, {}
        self.feed(pcm)

    def feed(self, pcm):
        if self.s and pcm:
            a = np.clip(np.frombuffer(pcm, np.int16) / 32768 * self.gain, -1, 1).astype(np.float32)
            for lang, s in self.s.items():
                s.accept_waveform(RATE, a)
                while self.recs[lang].is_ready(s):
                    self.recs[lang].decode_stream(s)
                self.heard[lang] = self.recs[lang].get_result(s).strip()

    def partial(self, lang="tr"):
        """What the last feed heard: feed runs on Talk's worker thread, and reading a stream while it decodes is not safe."""
        return self.heard.get(lang, self.heard.get("tr", ""))

    def text(self):
        """Text so far in every language. The decoders run ~0.3 s behind the audio, so flush them with silence
        first; if the caller goes on, that silence just sits inside the turn."""
        if not self.s:
            return {}
        self.feed(bytes(int(0.4 * RATE) * 2))
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


VOICE_RULES = """You are on a live phone call right now: the user is calling you on delta's number (555 0101) and
everything you write is spoken to them by a Turkish text-to-speech voice, sentence by sentence, as you write it.
- Speak Turkish (English only if they do). Short, natural spoken sentences, like a friend on the phone: usually one or two.
- No markdown, lists, code, URLs, emoji or parentheses; numbers, dates and times written as words. Never read out paths or ids.
- Before any tool use, say one short sentence of what you are about to do ("Bakıyorum, bir saniye."), then do it.
- Anything long (a table, a list, a document, code) goes to an atc page or a message; on the call say only the gist and where it is.
- Read back and wait for their clear "evet" before anything outward or destructive (sending, buying, deleting, calling someone).
- Their words reach you through speech recognition and can be wrong ("sanık" may be "sağanak"); guess the meaning, ask only if unsure.
- A message starting with "(sözünü kestim" means they interrupted you: they heard only the part it quotes.
- A message starting with "(önceki mesajım yarımdı" replaces your previous turn's question: answer the full version.
- When they want to end the call, say a short goodbye and end your reply with [KAPAT].
- When they ask to switch language, or clearly speaks the other language, start your reply with [LANG:en] or [LANG:tr];
  their words then reach you through that language's transcriber and the voice changes. In English mode you also see what
  the Turkish transcriber heard, so a switch back to Turkish is recognizable even when the English transcript is garbled."""

PROGRESS = [(r"mail|gmail", "Maillerine bakıyorum."), (r"openwa|whatsapp", "WhatsApp'a bakıyorum."),
            (r"web|search|fetch|browser|chrome", "İnternete bakıyorum."), (r"calendar|takvim", "Takvimine bakıyorum."),
            (r"atc", None), (r"Agent|Task", "Bunu bir ajana veriyorum."), (r".", "Bakıyorum.")]


class ClaudeBrain:
    """One Claude Code process for the whole call, fed turns over stream-json and read token by token."""
    def __init__(self, args):
        self.a, self.p, self.events, self.busy = args, None, asyncio.Queue(), False

    async def start(self):
        if self.p and self.p.returncode is None:
            return
        cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
               "--include-partial-messages", "--model", self.a.claude_model, "--append-system-prompt", VOICE_RULES]
        if self.a.effort:
            cmd += ["--effort", self.a.effort]
        self.p = await asyncio.create_subprocess_exec(*cmd, cwd=os.path.expanduser("~"), stdin=asyncio.subprocess.PIPE,
                                                      stdout=asyncio.subprocess.PIPE, limit=1 << 24)
        asyncio.create_task(self.read())

    async def read(self):
        async for line in self.p.stdout:
            try:
                self.events.put_nowait(json.loads(line))
            except ValueError:
                pass

    def write(self, obj):
        self.p.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())

    async def turn(self, text):
        """Yields ("text", delta) and ("tool", name) until Claude's turn ends."""
        while self.busy:  # what is left of an interrupted turn
            if (await self.events.get()).get("type") == "result":
                self.busy = False
        self.busy = True
        self.write({"type": "user", "message": {"role": "user", "content": text}})
        while True:
            e = await self.events.get()
            if e.get("type") == "result":
                self.busy = False
                return
            ev = e.get("event", {}) if e.get("type") == "stream_event" else {}
            if ev.get("type") == "content_block_delta" and ev["delta"].get("type") == "text_delta":
                yield "text", ev["delta"]["text"]
            elif ev.get("type") == "content_block_start" and ev["content_block"].get("type") == "tool_use":
                yield "tool", ev["content_block"].get("name", "")
            elif ev.get("type") == "content_block_start" and ev["content_block"].get("type") == "text":
                yield "text", " "

    def interrupt(self):
        if self.busy and self.p and self.p.returncode is None:
            self.write({"type": "control_request", "request_id": f"int{time.time()}", "request": {"subtype": "interrupt"}})

    async def finish(self, note):
        """Call over: let a running turn finish its work with a note to report the result itself, then close."""
        if self.p and self.p.returncode is None:
            if self.busy:
                self.write({"type": "user", "message": {"role": "user", "content": note}})
                while True:
                    e = await self.events.get()
                    if e.get("type") == "result" and self.events.empty():
                        break
            self.p.stdin.close()
            try:
                await asyncio.wait_for(self.p.wait(), 5)
            except asyncio.TimeoutError:
                self.p.kill()


class HubBrain:
    """atc's hub (`atc hub`, :8820): this call is the "phone" channel of the assistant's one conversation,
    or "guest-call" when one of their guests is on the line."""
    def __init__(self, args, http):
        self.a, self.http, self.ws, self.busy, self.events = args, http, None, False, asyncio.Queue()
        self.channel, self.guest = "phone", None

    async def as_guest(self, name):
        self.channel, self.guest = "guest-call", name
        if self.ws and not self.ws.closed:
            await self.ws.close()

    async def start(self):
        """Connects once per call (when it is answered, or for the opening of a call out), as the channel it is on by then."""
        if self.ws and not self.ws.closed:
            return
        if not getattr(self, "connecting", None) or self.connecting.done():
            self.connecting = asyncio.ensure_future(self.http.ws_connect(f"{self.a.hub}/ws?channel={self.channel}", heartbeat=15))
        ws = await self.connecting
        if ws is not self.ws:
            self.ws = ws
            asyncio.create_task(self.read(ws))

    async def read(self, ws):
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                self.events.put_nowait(json.loads(msg.data))
        self.events.put_nowait({"type": "done", "lost": True})

    async def quiet(self):
        """Until the hub has no turn of this channel running or queued (`owners`/`pending` in its status), up to 10 s.
        Another connection's turn on the same channel streams its reply here too: on one call the assistant's
        English answer to the last call's end note was still streaming when an app call's opening was sent, and the
        opening took that text, and its done, for its own, so they heard it first."""
        for _ in range(100):
            try:
                async with self.http.get(f"{self.a.hub}/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
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

    def interrupt(self):
        if self.busy and self.ws and not self.ws.closed:
            asyncio.ensure_future(self.ws.send_str(json.dumps({"type": "interrupt"})))

    async def finish(self, note):
        if self.ws and not self.ws.closed:
            if note:
                await self.ws.send_str(json.dumps({"type": "note", "text": "[görüşme bitti] " + note}))
            await self.ws.close()


class Talk:
    def __init__(self, args, http, send_audio, send_cmd):
        self.a, self.http, self.send_audio, self.send_cmd = args, http, send_audio, send_cmd
        self.hangup = False
        self.brain = {"claude": lambda: ClaudeBrain(args), "hub": lambda: HubBrain(args, http)}.get(args.brain, lambda: None)()
        self.heard, self.unfinished = None, None
        self.vad, self.cache = Vad(args.vad_fresh_peak), {}
        self.turn = once("turn", SmartTurn) if args.smart_turn else None
        self.stt = once(("stt", args.gain_db, args.english), lambda: StreamSTT(args.gain_db, args.english)) if args.stt == "stream" else None
        if self.stt:
            self.stt.s, self.stt.heard = {}, {}
        self.lang, self.voices = "tr", voices()
        self.history = [{"role": "system", "content": SYSTEM}]
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
        self.last_ack, self.canned_at = None, 0.0
        self.t0 = self.speaking_task = None
        self.track = {"in": bytearray(), "out": bytearray()}
        self.rate, self.down = RATE, None
        self.guest = None
        self.app, self.shown, self.next_shown, self.steady, self.heard_shown = False, None, None, 0, ""
        self.said_recently, self.echoing = [], False
        self.on_hold = False
        self.first_audio = {}

    async def off(self, fn, *args):
        """Run the transcribers and smart-turn on one worker thread (they release the GIL), so the event loop keeps
        pacing delta's voice: inline, a decode under load held the loop past the uplink's 120 ms lead and the phone
        ran dry mid-sentence (dry_ms 371 ms/s while speaking on one loaded call)."""
        return await asyncio.get_running_loop().run_in_executor(CPU, fn, *args)

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
        words = [w for w in re.findall(r"\w+", heard.lower()) if w not in BACKCHANNEL and not self.echoed(w, self.echoing)]
        return not STOP.search(heard) and len(words) < 2 if self.echoing else not words

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
        like = lambda w: any(w == s or difflib.SequenceMatcher(None, w, s).ratio() >= .75 for s in sent)
        return [w for w in re.findall(r"\w+", heard.lower()) if w not in LINE_CHECK and w not in BACKCHANNEL and not like(w)]

    def line_check(self, text):
        """A turn that only tests the line («Alo?», «Ses geliyor mu?», «Duyuyor musun?») is answered at once with
        LINE_OK instead of 2-4 s of Claude, which a caller who hears nothing fills with more of the same; Claude is
        told with their next turn. Twice a call at most: past that the line itself is the trouble, and Claude may say so."""
        words = set(re.findall(r"\w+", re.sub(r"\(.*?\)", "", text).lower()))
        return (self.lang == "tr" and LINE_OK in self.cache and self.line_checks < 2 and not self.unfinished
                and not self.cut and not self.opening and bool(words & LINE_CORE) and words <= LINE_CHECK)

    def echo(self, text):
        words = re.findall(r"\w+", text.lower())
        return bool(words) and sum(map(self.echoed, words)) / len(words) >= .7

    def show(self, **kw):
        """What the app's call screen shows: the state, what they are saying, what delta says, the tool it uses."""
        if self.app:
            asyncio.ensure_future(self.send_cmd({"cmd": "persona", **kw}))

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
        self.rate, self.down, self.cache, self.greeting = rate, None, {}, b""
        self.log(event="rate", rate=rate)
        asyncio.create_task(self.prerender())

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
        return ends[self.a.chunk_sentences - 1] if len(ends) >= self.a.chunk_sentences else None

    async def tts(self, text, lang=None, voice=None, rate=None):
        """Speech for text, as PCM chunks the moment the TTS server sends them. A request that fails before any audio
        (a reused keep-alive connection the server had already closed) is tried once more."""
        rate = rate or self.rate
        if rate == self.rate and text in self.cache:
            yield self.cache[text]
            return
        lang = lang or self.lang
        en, got = lang == "en", False
        body = {"model": TTS_MODEL, "voice": voice or self.voices[lang], "input": text if en else TTS_PREFIX + text,
                "engine": TTS_ENGINE_EN if en else TTS_ENGINE, "response_format": "pcm", "sample_rate": rate}
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

    def queue(self, item, pcm=b"", last=False):
        """Frames for the uplink. item = [text, frames queued and not yet sent, synthesis finished, leftover bytes]."""
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

    async def on_audio(self, pcm):
        """Turn-taking. The caller's turn stays open until delta's answer is audible: at spec_ms of silence a
        reply starts in the background (STT, LLM, TTS), at end_ms (or when smart-turn says the turn sounds
        finished) its audio may play. Speech before that audio starts reopens the turn: once a turn has gone to
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
                if not self.in_speech and self.speech_ms >= self.a.min_speech:
                    self.in_speech, self.pending = True, False
                    if self.opening or self.holding:
                        self.discard = True
                    elif self.reply and not self.reply.done() and not self.live:
                        if self.brain and self.unfinished:
                            self.reopening = True
                        else:
                            self.reply.cancel()
                            self.log(event="turn-reopened")
                    else:
                        self.utt, self.voiced_ms = bytearray(self.preroll), self.speech_ms
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
                if self.in_speech and self.talking() and not self.paused:
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
        if self.paused and self.in_speech:
            heard = self.stt.partial(self.lang) if self.stt else ""
            words = [w for w in re.findall(r"\w+", heard.lower()) if w not in BACKCHANNEL and not self.echoed(w)]
            if STOP.search(heard) or len(words) >= self.a.barge_words or time.time() - self.paused_at > self.a.barge_max:
                self.paused = False
                self.log(event="interrupted", heard=heard)
                self.interrupt()
        if self.discard and self.silence_ms >= self.a.spec_ms:
            self.discard, self.in_speech, self.utt = False, False, bytearray()
            self.log(event="ignored", heard=self.stt.partial(self.lang) if self.stt else "", why="our opening line is on its way")
        if self.reopening and self.silence_ms >= self.a.spec_ms:
            self.reopening, self.in_speech = False, False
            self.log(event="ignored", heard=self.stt.partial(self.lang) if self.stt else "")
        if self.reopened and self.silence_ms >= self.a.spec_ms:
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
        if self.in_speech and self.silence_ms >= self.a.spec_ms and self.talking():
            self.in_speech, self.utt = False, bytearray()
            self.log(event="resumed" if self.paused else "backchannel", heard=self.stt.partial(self.lang) if self.stt else "")
            self.paused = False
        if self.in_speech and self.silence_ms >= self.a.spec_ms and not self.pending:
            self.pending, done = True, False
            text = await self.off(self.stt.text) if self.stt else None
            if self.turn:
                prob = await self.off(self.turn, bytes(self.utt))
                held = bool(UNFINISHED.search((text or {}).get(self.lang, "") if isinstance(text, dict) else text or ""))
                done = prob > self.a.turn_threshold and not held
                self.log(event="smart-turn", p=round(prob, 3), held=held)
            self.commit.clear()
            self.reply = asyncio.create_task(self.respond(bytes(self.utt), time.time() - self.silence_ms / 1000, text, self.voiced_ms))
            self.reply.add_done_callback(lambda t: t.cancelled() or not t.exception() or self.log(event="error", error=repr(t.exception())))
            if done:
                self.commit.set()
        if self.in_speech and self.silence_ms >= self.a.end_ms:
            self.commit.set()
        if self.commit.is_set() and self.pending:
            self.in_speech = False
        self.preroll = (self.preroll + pcm)[-int(self.a.preroll * RATE) * 2:]

    async def whisper(self, utt, lang="tr", prompt="", timeout=None):
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
        try:
            second = await self.whisper(utt, self.lang, question, timeout=2.5)
        except Exception as e:
            self.log(event="second", error=repr(e))
            second = ""
        heard = second
        if WHISPER_JUNK.search(second) or len(re.findall(r"\w+", second)) > max(2, voiced_ms // 150):
            second = ""
        self.log(event="second", stream=text, whisper=heard, used=bool(second), voiced_ms=voiced_ms)
        norm = lambda t: re.sub(r"\W+", " ", t.lower()).strip()
        if not second or norm(second) == norm(text):
            return text or (UNCLEAR if voiced_ms >= self.a.unclear_ms else "")
        if not text:
            return f"{second} (sadece ikinci okuma duydu, ilki boş kaldı)"
        return f"{text} (aynı sesi ikinci okuma «{second}» diye duydu)"

    async def respond(self, utt, ended, text=None, voiced_ms=0):
        if (picked := voices()) != self.voices:
            self.voices, self.cache = picked, {}
            self.log(event="voice", voices=picked)
            asyncio.create_task(self.render(self.phrases()))
        timing = {"speech_end": round(ended - self.t0, 3), "utt_s": round(len(utt) / 2 / RATE, 2)}
        mark = lambda k: timing.__setitem__(k, round(time.time() - ended, 3))
        if text is None:
            text = await self.whisper(utt)
        if isinstance(text, dict):
            heard_tr, text = text.get("tr", ""), text.get(self.lang, "")
            if self.lang == "en" and heard_tr:
                text += f" (Turkish transcriber heard: «{heard_tr}»)"
            if self.a.second_ms and utt:
                text = await self.second_reading(utt, "" if HALLUCINATIONS.search(text) else text, voiced_ms)
        mark("stt")
        if HALLUCINATIONS.search(text):
            self.log(event="dropped", text=text, **timing)
            return
        if self.echo(text):
            self.log(event="dropped", text=text, why="delta's own voice coming back", **timing)
            return
        if self.brain:
            return await self.respond_claude(text, timing, mark)
        now = time.localtime()
        clock = f"Şu an {now.tm_mday} {AYLAR[now.tm_mon - 1]} {now.tm_year} {GUNLER[now.tm_wday]}, saat {now.tm_hour}:{now.tm_min:02d}."
        sent = {"role": "user", "content": f"[{clock}] " + ("(sözünü keserek) " if self.cut else "") + text}
        messages = self.history + [sent]
        reply, buf, first = "", "", True

        async def speak(sentence):
            nonlocal first
            chunks = self.tts(sentence)
            head = await anext(chunks, b"")
            if first:
                mark("first_audio")
            await self.commit.wait()
            if first:
                mark("committed")
                self.cut = False
                self.log(event="user", text=text, **timing)
                self.history += [dict(sent), {"role": "assistant", "content": ""}]
                self.spoken, self.live, self.utt, first = [], True, bytearray(), False
            self.history[-1]["content"] = reply
            item = [sentence, 0, False, b""]
            self.speaking.append(item)
            self.queue(item, head)
            async for chunk in chunks:
                self.queue(item, chunk)
            self.queue(item, last=True)

        inline = ""
        for _ in range(3):
            calls = {}
            body = {"model": LLM_MODEL, "messages": messages, "stream": True, "max_tokens": 200, "temperature": 0.7, "tools": TOOLS}
            async with self.http.post(LLM_URL, json=body) as r:
                async for line in r.content:
                    line = line.decode().strip()
                    if not line.startswith("data:") or "[DONE]" in line:
                        continue
                    d = (json.loads(line[5:])["choices"] or [{}])[0].get("delta", {})
                    for c in d.get("tool_calls") or []:
                        call = calls.setdefault(c.get("index", 0), {"id": c.get("id"), "name": "", "arguments": ""})
                        call["name"] += c.get("function", {}).get("name") or ""
                        call["arguments"] += c.get("function", {}).get("arguments") or ""
                    delta = d.get("content") or ""
                    if (delta or calls) and "llm_first" not in timing:
                        mark("llm_first")
                    if inline or "<" in delta:
                        inline += delta
                        if "<function" not in inline and len(inline) > 12:
                            delta, inline = inline, ""
                        else:
                            continue
                    buf += delta
                    reply += delta
                    while cut := self.piece_end(buf, first):
                        sentence, buf = buf[:cut].strip(), buf[cut:]
                        await speak(sentence)
            for i, (name, args) in enumerate(re.findall(r"<function=(\w+)>(.*?)(?:</function>|$)", inline, re.S)):
                params = dict(re.findall(r"<parameter=(\w+)>\s*(.*?)\s*</parameter>", args, re.S))
                calls[100 + i] = {"id": f"inline{i}", "name": name, "arguments": json.dumps(params, ensure_ascii=False)}
            inline = ""
            if not calls:
                break
            if buf.strip():
                await speak(buf.strip())
                buf = ""
            if not reply.strip() and any(c["name"] != "telefonu_kapat" for c in calls.values()):
                filler = random.choice(FILLERS)
                reply += filler + " "
                await speak(filler)
            said = {"role": "assistant", "content": reply.strip(), "tool_calls": [
                {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in calls.values()]}
            results = []
            for c in calls.values():
                if c["name"] == "telefonu_kapat":
                    self.hangup, result = True, "Görüşme sen konuşmayı bitirince kapanacak."
                else:
                    result = await run_tool(self.http, c["name"], c["arguments"])
                self.log(event="tool", name=c["name"], arguments=c["arguments"], result=result)
                results.append({"role": "tool", "tool_call_id": c["id"], "content": result + "\n(Sadece sorulanı, tek kısa cümleyle söyle.)"})
            messages = messages + [said, *results]
        if buf.strip():
            await speak(buf.strip())
        self.log(event="delta", text=reply, **timing)
        if self.hangup:
            while self.speaking:
                await asyncio.sleep(0.1)
            await asyncio.sleep(0.5)
            self.log(event="hangup")
            await self.send_cmd({"cmd": "hangup"})

    async def respond_claude(self, text, timing, mark):
        """Claude talks: its text streams into TTS sentence by sentence. Nothing is sent before the turn is
        committed (a message to Claude can't be taken back); a tool call gets a spoken progress line."""
        await self.commit.wait()
        mark("committed")
        if self.line_check(text):
            self.line_checks += 1
            self.checked.append(text)
            self.canned_at = time.monotonic()
            self.say(LINE_OK, self.cache[LINE_OK])
            self.log(event="line-check", text=text, **timing)
            self.history += [{"role": "user", "content": text}, {"role": "assistant", "content": LINE_OK}]
            return
        if self.unfinished:
            sent = f"(önceki mesajım yarımdı, tamamı şu) {text}"
        elif self.cut and self.heard is not None:
            sent = f"(sözünü kestim; cevabından sadece şunu duydum: «{self.heard}») {text}"
        else:
            sent = text
        if self.checked:
            sent = f"(hattı denedi: «{' / '.join(self.checked)}»; sen hemen «{LINE_OK}» dedin) {sent}"
            self.checked = []
        self.cut, self.heard, self.unfinished = False, None, text
        self.log(event="user", text=sent, **timing)
        self.show(you=text)
        self.history += [{"role": "user", "content": sent}, {"role": "assistant", "content": ""}]
        self.spoken = []
        reply, buf, first = "", "", True
        self.tools_open = 0
        wants_ack = self.a.ack_ms and not self.opening and not self.holding \
            and len(re.findall(r"\w+", re.sub(r"\s*\(.*", "", text))) > 2
        ack = asyncio.create_task(self.ack_later(lambda: first and not reply) if wants_ack else asyncio.sleep(0))
        hold = asyncio.create_task(self.hold_on())

        async def speak(sentence):
            nonlocal first
            ack.cancel()
            if first:
                mark("first_audio")
                await self.may_speak.wait()
                self.live, self.utt, self.opening, self.unfinished, first = True, bytearray(), False, None, False
            item, head = [sentence, 0, False, b""], b""
            self.speaking.append(item)
            async for chunk in self.tts(sentence):
                if head is not None:
                    head += chunk
                    if len(head) < self.a.prebuffer * self.rate * 2 / 1000:
                        continue
                    chunk, head = head, None
                self.queue(item, chunk)
            self.queue(item, head or b"", last=True)

        try:
            async for kind, value in self.brain.turn(sent):
                if "llm_first" not in timing and value.strip():
                    mark("llm_first")
                if kind == "tool":
                    self.log(event="tool", name=value)
                    self.show(tool=value)
                    self.tools_open += 1
                    if buf.strip():
                        await speak(buf.replace("[KAPAT]", "").strip())
                        buf = ""
                    elif first and (line := next(p for r, p in PROGRESS if re.search(r, value, re.I))) and not self.canned_lately():
                        self.canned_at = time.monotonic()
                        await speak(line)
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
                    if tag.group(1) != self.lang:
                        self.lang = tag.group(1)
                        self.log(event="language", lang=self.lang)
                while cut := self.piece_end(buf, first):
                    sentence, buf = buf[:cut].strip(), buf[cut:]
                    await speak(sentence.replace("[KAPAT]", "").strip())
            if buf.replace("[KAPAT]", "").strip():
                await speak(buf.replace("[KAPAT]", "").strip())
        except asyncio.CancelledError:
            ack.cancel(), hold.cancel()
            self.brain.interrupt()
            raise
        ack.cancel(), hold.cancel()
        self.unfinished = None
        self.log(event="delta", text=reply, **timing)
        if "[KAPAT]" in reply:
            self.hangup = True
            while self.speaking:
                await asyncio.sleep(0.1)
            await asyncio.sleep(0.5)
            self.log(event="hangup")
            await self.send_cmd({"cmd": "hangup"})

    async def hold_on(self):
        """While a tool runs and the line has been quiet for progress_ms, a short "still on it" line, at most
        progress_max a turn and progress_every apart. Tied to the tool being open, not to when the next tool
        starts: that fired just before the answer, which by then was Claude writing, not the tool working."""
        said, last = 0, 0.0
        while said < self.a.progress_max:
            await asyncio.sleep(0.1)
            now = time.monotonic()
            if self.tools_open and not self.speaking and not self.in_speech and now - self.last_voice >= self.a.progress_ms / 1000 \
                    and now - last >= self.a.progress_every_ms / 1000:
                line = random.choice([h for h in HOLD if h != getattr(self, "last_hold", None)])
                self.last_hold, said, last, self.canned_at = line, said + 1, now, now
                self.say(line, self.cache.get(line) or b"".join([c async for c in self.tts(line)]))
                self.log(event="hold", text=line)

    def canned_lately(self):
        return time.monotonic() - self.canned_at < self.a.canned_gap_ms / 1000

    async def ack_later(self, silent):
        """Claude is slower than a person: if nothing at all has come from it after ack_ms (silent()), a short thinking
        phrase ("Dur bakayım."), never the same one twice running and never within canned_gap_ms of another canned line
        (respond_claude decides when to try at all). They picked these over silence and a bare "Hmm" on real turns."""
        await asyncio.sleep(self.a.ack_ms / 1000)
        ready = [a for a in ACKS[self.lang] if a in self.cache and a != self.last_ack]
        if not self.speaking and not self.in_speech and ready and silent() and not self.canned_lately():
            self.last_ack, self.canned_at = random.choice(ready), time.monotonic()
            self.say("", self.cache[self.last_ack])
            self.log(event="ack", text=self.last_ack)

    def save(self):
        if not self.t0:
            return
        if self.speaking_task:
            self.speaking_task.cancel()
        n = max(len(self.track["in"]), len(self.track["out"]))
        l, r = (np.frombuffer(bytes(self.track[s]).ljust(n, b"\0"), np.int16) for s in ("in", "out"))
        with wave.open(os.path.join(self.dir, "call.wav"), "wb") as w:
            w.setnchannels(2), w.setsampwidth(2), w.setframerate(RATE), w.writeframes(np.stack([l, r], 1).tobytes())
        json.dump(self.history, open(os.path.join(self.dir, "history.json"), "w"), ensure_ascii=False, indent=1)
        print(f"saved {self.dir}/", flush=True)

    async def warm(self):
        if self.brain and not isinstance(self.brain, HubBrain):
            await self.brain.start()
        await self.prerender()
        asyncio.create_task(self.render(self.phrases(), rate=APP_RATE))
        if not self.brain:
            async with self.http.post(LLM_URL, json={"model": LLM_MODEL, "messages": self.history, "max_tokens": 1}) as r:
                await r.read()

    @staticmethod
    def phrases(first=True, rest=True):
        lines = [(t, "tr") for t in [GREETING, LINE_OK, *FILLERS, *HOLD, *[p for _, p in PROGRESS if p]]] if first else []
        return lines + ([(t, "tr") for t in ACKS["tr"]] + [(t, "en") for t in ACKS["en"]] if rest else [])

    async def prerender(self):
        await self.render(self.phrases(rest=False))
        self.greeting = self.cache.get(GREETING, b"")
        asyncio.create_task(self.render(self.phrases(first=False)))

    async def render(self, lines, rate=None):
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
            voice, engine = voices[lang], TTS_ENGINE_EN if lang == "en" else TTS_ENGINE
            made = [os.stat(f).st_mtime_ns for f in (f"{HIGGS_VOICES}/{voice}.wav", f"{HIGGS_VOICES}/prompt_text") if os.path.exists(f)]
            key = hashlib.sha1(f"{voice}|{made}|{engine}|{'' if lang == 'en' else TTS_PREFIX}{t}{'' if rate == RATE else f'|{rate}'}".encode()).hexdigest()[:20]
            path = os.path.join(PHRASES, key + ".pcm")
            if os.path.exists(path):
                pcm = open(path, "rb").read()
            elif pcm := b"".join([c async for c in self.tts(t, lang, voice, rate)]):
                open(path + ".tmp", "wb").write(pcm)
                os.replace(path + ".tmp", path)
            if self.voices is not voices or rate != self.rate:
                if ahead:
                    continue
                return
            if pcm:
                self.cache[t] = pcm

    def open(self):
        if (picked := voices()) != self.voices:
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
        opening = OUTBOUND_GUEST.format(guest=self.guest, reason=reason or "belirtilmedi") if self.guest else OUTBOUND
        self.reply = asyncio.create_task(self.respond(b"", time.time(), opening))
        self.reply.add_done_callback(lambda _: setattr(self, "opening", False))

    async def start(self):
        if not self.t0:
            self.open()
        self.log(event="answered", **({"guest": self.guest} if self.guest else {}))
        if isinstance(self.brain, HubBrain):
            asyncio.create_task(self.brain.start())
        self.speaking_task = asyncio.create_task(self.speaker())
        if self.holding:
            asyncio.create_task(self.release())
            return
        if not self.greeting:
            self.greeting = self.cache[GREETING] = b"".join([c async for c in self.tts(GREETING)])
        self.history.append({"role": "assistant", "content": GREETING})
        asyncio.create_task(self.greet())

    async def greet(self):
        """The greeting waits for the far end's audio to start (the first frame that is not digital zero), up to
        greet_wait_ms: a WhatsApp call goes active before its audio flows, and on one call the greeting
        played into the 4.4 s before it did, so their first words were «Alo? Ses geliyor mu?». The app line has its own
        hold and is not waited for; a phone or WhatsApp line is normally up within 0.2 s."""
        start = time.monotonic()
        while not self.app and not self.line_up and time.monotonic() - start < self.a.greet_wait_ms / 1000:
            await asyncio.sleep(0.02)
        self.log(event="greeting", waited_ms=round((time.monotonic() - start) * 1000), line_up=self.line_up)
        self.say(GREETING, self.greeting)

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


ANSWER = [re.sub(r"\D", "", n)[-10:] for n in os.environ.get("TALK_ANSWER", "15550100").split(",") if n.strip()]


def voices():
    """The voice per language: what phone.example last picked (voice.json), else the service's environment."""
    try:
        picked = json.load(open(VOICES))
    except (OSError, ValueError):
        picked = {}
    return {"tr": picked.get("tr") or TTS_VOICE, "en": picked.get("en") or TTS_VOICE_EN}


def allowed(number):
    """the user's own number."""
    return bool(number) and re.sub(r"\D", "", number)[-10:] in ANSWER


def guest_of(number):
    """The guest's name if this number is in atc's guest list (read fresh, so `atc guest add` applies at once)."""
    tail = re.sub(r"\D", "", number or "")[-10:]
    try:
        lines = open(GUESTS).read().splitlines()
    except OSError:
        return None
    for line in lines:
        parts = line.split("#")[0].split()
        if len(parts) >= 2 and tail and re.sub(r"\D", "", parts[-1])[-10:] == tail:
            return " ".join(parts[:-1])
    return None


async def be_guest(talk, name):
    talk.guest = name
    await talk.brain.as_guest(name)


def call_over(talk):
    if talk.guest:
        return (f"({talk.guest} ile görüşme kapandı. kullanıcının bilmesi ya da karar vermesi gereken bir şey çıktıysa "
                f"report ile asistana bildir; ona söz verdiğin bir şey varsa onu da takip et.)")
    return "(Görüşme kapandı. Yarım kalan bir iş varsa bitir, sonucunu `atc notify` ile kısaca bildir.)"


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
                if event.get("guest") and args.brain == "hub":
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
                if guest and args.brain == "hub":
                    await be_guest(talk, guest)
                if event.get("via") == "app" or allowed(number) or (guest and args.brain == "hub"):
                    own = line_of(event)
                    await ws.send_str(json.dumps({"cmd": "answer"}))
                else:
                    print(json.dumps({"event": "not-answered", "number": event.get("number") or caller}), flush=True)
            if event.get("call") == "ringing":
                ringing = True
            if event.get("call") == "offhook" and not ringing and not active and not talk.t0 and talk.brain:
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
        if talk.brain:
            await talk.brain.finish(call_over(talk) if active else
                                    "(Açmadı: telefon çaldı ama açmadı, hazırladığın açılış duyulmadı.)" if talk.t0 else None)


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
        start = time.monotonic()
        for n, i in enumerate(range(0, len(pcm) + RATE * 2 * args.tail, FRAME)):
            await talk.on_audio(pcm[i:i + FRAME].ljust(FRAME, b"\0"))
            await asyncio.sleep(max(0, start + (n + 1) * 0.02 - time.monotonic()))
        talk.save()
        if talk.brain:
            talk.brain.interrupt()
            await talk.brain.finish("(Görüşme kapandı, bu bir testti; bir şey yapma.)")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://127.0.0.1:8807/call")
    p.add_argument("--line", choices=["app", "device"], help="take calls on this line only (atc's app, or delta's SIM and WhatsApp), so a talker per line can each hold a call; none = both")
    p.add_argument("--dial")
    p.add_argument("--sim")
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
    p.add_argument("--end-ms", type=int, default=600, help="ms of silence that ends the caller's turn (backstop with --smart-turn)")
    p.add_argument("--brain", choices=["local", "claude", "hub"], default="local")
    p.add_argument("--hub", default="http://127.0.0.1:8820", help="brain hub: the shared session's hub")
    p.add_argument("--claude-model", default="opus")
    p.add_argument("--effort", default="low")
    p.add_argument("--ack-ms", type=int, default=2500, help="claude brain: ms after their turn with nothing from Claude before a thinking phrase (0 = never)")
    p.add_argument("--english", action="store_true", help="load the English transcriber, so Claude can switch the call with [LANG:en] (needs --stt stream)")
    p.add_argument("--reopen-ms", type=int, default=700, help="ms of speech that take back a turn already sent to Claude")
    p.add_argument("--barge-words", type=int, default=3, help="words (not hı hı, evet...) that make an overlap a real interruption")
    p.add_argument("--barge-max", type=float, default=2.0, help="s of paused overlap after which it counts as an interruption anyway")
    p.add_argument("--stt", choices=["whisper", "stream"], default="whisper")
    p.add_argument("--second-ms", type=int, default=600, help="stream STT: a turn with at most this much speech, or one word, is read again by Whisper (0 = never)")
    p.add_argument("--unclear-ms", type=int, default=200, help="speech no transcriber could read still reaches Claude as unclear from this much on")
    p.add_argument("--preroll", type=float, default=0.8, help="s of audio before speech onset that goes into the turn")
    p.add_argument("--gain-db", type=float, default=6, help="stream STT: 0-8 dB read a real call best, 18+ distorts")
    p.add_argument("--smart-turn", action="store_true", help="end the turn at spec-ms when smart-turn says it is complete")
    p.add_argument("--turn-threshold", type=float, default=0.5)
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
