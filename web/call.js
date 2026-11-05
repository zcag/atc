import { logged, onLine } from "./call-log.js";

const OUT_RATE = 24000;
const SPEECH_GAIN = 2.5;
const FACE = { state: "listening", hearing: "", you: "", said: "", tool: "", line: "assistant", title: "", person: "", background: "", moving: false, knock: "", lang: "", log: [] };
const TAIL_MS = 250;
const WHY = { busy: "the line is busy", nobody: "nobody is there to answer", gone: "the call is over", lost: "connection lost", hangup: "hung up" };

const remembered = () => { try { return localStorage.getItem("atc.callPtt") === "1"; } catch { return false; } };

let st = { phase: "idle", since: 0, muted: false, why: "", ptt: remembered(), talking: false };
let face = FACE;
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const set = (p) => { st = { ...st, ...p }; emit(); };

let ctx, mic, up, down, ears, mouth, low, high, ws, live = false, lostAt = 0, closed = true, stats = {}, timers = [], lock = null, sink = null, tail = 0;
const closedMic = () => st.muted || (st.ptt && !st.talking && !tail);
const applyMic = () => up?.port.postMessage({ quiet: closedMic() });

const rms = (an, buf, gain = 6) => {
  if (!an) return 0;
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.min(1, Math.sqrt(s / buf.length) * gain);
};
const scratch = new Float32Array(512);

export const Call = {
  get: () => st,
  face: () => face,
  live: () => st.phase === "calling" || st.phase === "active",
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  levels: () => [closedMic() ? 0 : rms(ears, scratch), rms(mouth, scratch)],
  speech: () => [rms(mouth, scratch, SPEECH_GAIN), rms(low, scratch, SPEECH_GAIN), rms(high, scratch, SPEECH_GAIN)],
  supported: () => !!(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode && window.WebSocket),

  async dial() {
    if (Call.live()) return;
    face = FACE;
    set({ phase: "calling", since: 0, muted: false, why: "", talking: false });
    closed = false;
    live = false;
    lostAt = 0;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
      ctx.resume();
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      await ctx.audioWorklet.addModule("call-worklet.js");
      if (closed) return teardown();
      const src = ctx.createMediaStreamSource(mic);
      up = new AudioWorkletNode(ctx, "call-up", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      up.port.onmessage = (e) => {
        if (e.data === "closed") return st.talking || send({ cmd: "talk-up" });
        if (live && ws?.readyState === 1) ws.send(e.data);
      };
      applyMic();
      ears = new AnalyserNode(ctx, { fftSize: 1024 });
      src.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 7000 })).connect(up).connect(ctx.destination);
      src.connect(ears);
      down = new AudioWorkletNode(ctx, "call-down", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      down.port.onmessage = (e) => (stats = e.data);
      mouth = new AnalyserNode(ctx, { fftSize: 1024 });
      down.connect(mouth);
      low = new AnalyserNode(ctx, { fftSize: 1024 });
      high = new AnalyserNode(ctx, { fftSize: 1024 });
      down.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 700, Q: .5 })).connect(low);
      down.connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 3000, Q: .5 })).connect(high);
    } catch (e) {
      return end({ NotAllowedError: "no microphone permission", NotFoundError: "no microphone found" }[e.name] || e.message || String(e));
    }
    play(down);
    open("call");
    timers.push(setTimeout(() => st.phase === "calling" && hangup("no answer"), 20000));
    timers.push(setInterval(report, 10000));
  },

  hangup: () => hangup("you hung up"),

  mute() {
    if (st.ptt) return;
    set({ muted: !st.muted });
    applyMic();
  },

  togglePtt() {
    if (st.talking) letGo();
    set({ ptt: !st.ptt, muted: false });
    try { localStorage.setItem("atc.callPtt", st.ptt ? "1" : "0"); } catch {}
    applyMic();
  },

  press() {
    if (!st.ptt || st.talking || st.phase !== "active") return;
    const stillOpen = tail;
    clearTimeout(tail);
    tail = 0;
    set({ talking: true });
    applyMic();
    if (stillOpen) return;
    down?.port.postMessage("flush");
    send({ cmd: "talk-down" });
  },

  release() {
    if (!st.talking) return;
    tail = setTimeout(letGo, TAIL_MS);
    set({ talking: false });
  },

  interrupt() {
    if (!["speaking", "thinking", "tool"].includes(face.state)) return;
    send({ cmd: "interrupt" });
    down?.port.postMessage("flush");
  },
};

function letGo() {
  clearTimeout(tail);
  tail = 0;
  if (st.talking) set({ talking: false });
  up?.port.postMessage({ quiet: closedMic(), ack: true });
}

function play(node) {
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);
  sink = new Audio();
  sink.srcObject = dest.stream;
  sink.play().catch(() => node.connect(ctx.destination));
}

function open(hello) {
  const w = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/call/line`);
  w.binaryType = "arraybuffer";
  ws = w;
  w.onopen = () => w.send(JSON.stringify({ cmd: hello, out_rate: OUT_RATE }));
  w.onmessage = (e) => {
    if (w !== ws) return;
    if (typeof e.data !== "string") return down?.port.postMessage(e.data, [e.data]);
    let o;
    try { o = JSON.parse(e.data); } catch { return; }
    if (o.event === "active") {
      live = true;
      lostAt = 0;
      if (st.phase !== "active") {
        set({ phase: "active", since: Date.now() });
        wake();
      } else if (st.ptt && !tail) send({ cmd: st.talking ? "talk-down" : "talk-up" });
    } else if (o.event === "ended") end(WHY[o.why] || o.why || "ended");
    else if (o.event === "persona") persona(o);
  };
  w.onclose = (e) => dropped(w, e.reason || "line closed");
}

function dropped(w, why) {
  if (closed || w !== ws) return;
  if (!live) return end(why);
  const now = Date.now();
  if (!lostAt) lostAt = now;
  if (now - lostAt > 8000) return end("connection lost");
  timers.push(setTimeout(() => !closed && open("resume"), 1000));
}

function persona(o) {
  const has = (k) => k in o, first = face.lang;
  face = {
    state: o.state || face.state,
    hearing: has("hearing") ? o.hearing || "" : has("you") ? "" : face.hearing,
    you: has("you") ? o.you : face.you,
    said: has("said") ? o.said : face.said,
    tool: o.tool || face.tool,
    line: o.line || face.line,
    title: has("title") ? o.title : face.title,
    person: has("person") ? o.person : face.person,
    background: has("background") ? o.background : face.background,
    moving: has("moving") ? o.moving : face.moving,
    knock: has("knock") ? o.knock : face.knock,
    lang: o.lang || face.lang,
    log: face.log,
  };
  face.log = logged(face.log, o, onLine(face));
  if (o.lang && !first) try { localStorage.setItem("atc.callLang", o.lang); } catch {}
  emit();
}

const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));

function report() {
  if (!live) return;
  const aec = mic?.getAudioTracks()[0]?.getSettings().echoCancellation;
  send({ cmd: "stats", ...stats, ptt: st.ptt, route: "browser", aec: aec === undefined ? "unknown" : aec ? "on" : "off", client: "web" });
}

function hangup(why) {
  report();
  send({ cmd: "hangup" });
  end(why);
}

function end(why) {
  if (closed && st.phase === "ended") return;
  report();
  teardown();
  set({ phase: "ended", why });
}

function teardown() {
  closed = true;
  live = false;
  timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
  timers = [];
  clearTimeout(tail);
  tail = 0;
  st = { ...st, talking: false };
  ws?.close(1000);
  ws = null;
  mic?.getTracks().forEach((t) => t.stop());
  sink?.pause();
  ctx?.close();
  ctx = mic = up = down = ears = mouth = low = high = sink = null;
  lock?.release().catch(() => {});
  lock = null;
}

async function wake() {
  if (closed || document.visibilityState !== "visible") return;
  lock = await navigator.wakeLock?.request("screen").catch(() => null);
}

document.addEventListener("visibilitychange", () => st.phase === "active" && (!lock || lock.released) && wake());
addEventListener("keyup", (e) => e.key === " " && Call.release());
addEventListener("blur", () => Call.release());
addEventListener("pagehide", () => Call.live() && hangup("you left"));
