const OUT_RATE = 24000;
const FACE = { state: "listening", hearing: "", you: "", said: "", tool: "" };
const WHY = { busy: "the line is busy", nobody: "nobody is there to answer", gone: "the call is over", lost: "connection lost", hangup: "hung up" };

let st = { phase: "idle", since: 0, muted: false, why: "" };
let face = FACE;
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const set = (p) => { st = { ...st, ...p }; emit(); };

let ctx, mic, up, down, ears, mouth, ws, live = false, lostAt = 0, closed = true, stats = {}, timers = [], lock = null, sink = null;

const rms = (an, buf) => {
  if (!an) return 0;
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.min(1, Math.sqrt(s / buf.length) * 6);
};
const scratch = new Float32Array(512);

export const Call = {
  get: () => st,
  face: () => face,
  live: () => st.phase === "calling" || st.phase === "active",
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  levels: () => [st.muted ? 0 : rms(ears, scratch), rms(mouth, scratch)],
  supported: () => !!(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode && window.WebSocket),

  async dial() {
    if (Call.live()) return;
    face = FACE;
    set({ phase: "calling", since: 0, muted: false, why: "" });
    closed = false;
    live = false;
    lostAt = 0;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
      ctx.resume();
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      await ctx.audioWorklet.addModule("call-worklet.js");
    } catch (e) {
      return end({ NotAllowedError: "no microphone permission", NotFoundError: "no microphone found" }[e.name] || e.message || String(e));
    }
    if (closed) return teardown();
    const src = ctx.createMediaStreamSource(mic);
    const low = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 7000 });
    up = new AudioWorkletNode(ctx, "call-up", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    up.port.onmessage = (e) => live && ws?.readyState === 1 && ws.send(e.data);
    ears = new AnalyserNode(ctx, { fftSize: 1024 });
    src.connect(low).connect(up).connect(ctx.destination);
    src.connect(ears);
    down = new AudioWorkletNode(ctx, "call-down", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    down.port.onmessage = (e) => (stats = e.data);
    mouth = new AnalyserNode(ctx, { fftSize: 1024 });
    down.connect(mouth);
    play(down);
    open("call");
    timers.push(setTimeout(() => st.phase === "calling" && hangup("no answer"), 20000));
    timers.push(setInterval(report, 10000));
  },

  hangup: () => hangup("you hung up"),

  mute() {
    set({ muted: !st.muted });
    up?.port.postMessage({ quiet: st.muted });
  },

  interrupt() {
    if (!["speaking", "thinking", "tool"].includes(face.state)) return;
    send({ cmd: "interrupt" });
    down?.port.postMessage("flush");
  },
};

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
      }
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
  const has = (k) => k in o;
  face = {
    state: o.state || face.state,
    hearing: has("hearing") ? o.hearing || "" : has("you") ? "" : face.hearing,
    you: o.you || face.you,
    said: o.said || face.said,
    tool: o.tool || face.tool,
  };
  emit();
}

const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));

function report() {
  if (!live) return;
  const aec = mic?.getAudioTracks()[0]?.getSettings().echoCancellation;
  send({ cmd: "stats", ...stats, route: "browser", aec: aec === undefined ? "unknown" : aec ? "on" : "off", client: "web" });
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
  ws?.close(1000);
  ws = null;
  mic?.getTracks().forEach((t) => t.stop());
  sink?.pause();
  ctx?.close();
  ctx = mic = up = down = ears = mouth = sink = null;
  lock?.release().catch(() => {});
  lock = null;
}

async function wake() {
  if (closed || document.visibilityState !== "visible") return;
  lock = await navigator.wakeLock?.request("screen").catch(() => null);
}

document.addEventListener("visibilitychange", () => st.phase === "active" && (!lock || lock.released) && wake());
addEventListener("pagehide", () => Call.live() && hangup("you left"));
