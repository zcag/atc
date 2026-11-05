// The quiet characters ("kind": "minimal"): a thin white mark that only moves with the voices, for calls in public.
// persona.json's "style" picks it: "line", a hairline across the screen that ripples, or "bars", four short bars
// like a voice meter. Thinking shows as a slow streak along the line, or a slow wave through the bars.

const STYLES = {
  line(g, w, h, t, o) {
    const y = h / 2, amp = h * .09 * o.gain * o.level, n = 120;
    g.lineWidth = 1.5 * o.k;
    g.strokeStyle = `rgba(${o.rgb},${.35 + .5 * Math.min(1, o.level * 2)})`;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const x = i / n, env = Math.sin(Math.PI * x) ** 2;
      const yy = y + amp * env * (Math.sin(x * 14 + o.phase) * .6 + Math.sin(x * 31 - t * 9) * .4);
      i ? g.lineTo(x * w, yy) : g.moveTo(x * w, yy);
    }
    g.stroke();
    if (o.think < .01) return;
    const p = (Math.sin(t * 1.6) * .5 + .5) * .8 + .1, a = (p - .12) * w, b = (p + .12) * w;
    const gr = g.createLinearGradient(a, 0, b, 0);
    gr.addColorStop(0, `rgba(${o.rgb},0)`);
    gr.addColorStop(.5, `rgba(${o.rgb},${.9 * o.think})`);
    gr.addColorStop(1, `rgba(${o.rgb},0)`);
    g.strokeStyle = gr;
    g.lineWidth = 2 * o.k;
    g.beginPath(); g.moveTo(a, y); g.lineTo(b, y); g.stroke();
  },
  bars(g, w, h, t, o) {
    const n = 4, bw = 6 * o.k, gap = 10 * o.k, base = 8 * o.k, max = Math.min(h * .22 * o.gain, 90 * o.k);
    const x0 = w / 2 - (n * bw + (n - 1) * gap) / 2;
    g.fillStyle = `rgba(${o.rgb},${.5 + .4 * Math.min(1, o.level * 2)})`;
    for (let i = 0; i < n; i++) {
      const v = o.level * (.55 + .45 * Math.sin(t * (7 + i * 2.3) + i * 1.7)) + o.think * .25 * (Math.sin(t * 3 - i * .9) * .5 + .5);
      const bh = base + max * Math.max(0, v);
      g.beginPath(); g.roundRect(x0 + i * (bw + gap), h / 2 - bh / 2, bw, bh, bw / 2); g.fill();
    }
  },
};

/** Draws the minimal character described by `spec` into a canvas. now() gives {state, you, it}. Returns stop.
 *  opts.ink() gives a CSS color to draw in (white without it), opts.gain scales the movement for a small canvas. */
export function minimal(canvas, spec, now, opts = {}) {
  const draw = STYLES[spec.style] || STYLES.line, g = canvas.getContext("2d");
  if (opts.background) canvas.style.background = `linear-gradient(#0006, #0006), center / cover no-repeat url("${opts.background}")`;
  const o = { level: 0, think: 0, phase: 0, k: 1, gain: opts.gain || 1, rgb: "255,255,255" };
  let inkAt = -1e9;
  const ease = (v, to, dt, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
  let raf, last = performance.now(), drew = false;
  const frame = (ms) => {
    raf = requestAnimationFrame(frame);
    const t = ms / 1000, dt = Math.min((ms - last) / 1000, .1), { state, you = 0, it = 0 } = now();
    last = ms;
    const target = { speaking: .1 + .8 * it, hearing: .08 + .6 * you, thinking: .05, tool: .05 }[state] ?? .02 + .2 * you;
    o.level = ease(o.level, target, dt, target > o.level ? .08 : .25);
    o.think = ease(o.think, +(state === "thinking" || state === "tool"), dt, .4);
    o.phase += dt * 6 * (state === "hearing" ? -1 : 1);
    o.k = Math.min(devicePixelRatio || 1, 2);
    if (opts.ink && ms - inkAt > 1000) { inkAt = ms; o.rgb = rgbOf(opts.ink()); }
    const w = Math.round(canvas.clientWidth * o.k), h = Math.round(canvas.clientHeight * o.k);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    if (w && h) draw(g, w, h, t, o);
    if (!drew) { drew = true; opts.first?.(); }
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
function rgbOf(color) {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",");
}
