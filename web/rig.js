// A rigged 2D character ("kind": "rig"): painted parts (room, body, head with eye holes and a cut between the lips,
// eyeballs and the inside of the mouth behind it, glasses) as triangle meshes. Every vertex is first moved by
// additive deformers in the rest pose (jaw, lips, mouth corners, lids, brows, cheeks, irises), then skinned to a
// few bones (body, neck, head, face, back) whose offsets fake the head turning in depth. Both run on the GPU from
// a handful of numbers per frame, which Behaviour sets from the call's state and both voices' loudness.

import { PI, clamp, smooth, lerp, rand, chance, Spring, Saccade, Pulses, wander } from "./motion.js";

const VS = `#version 300 es
layout(location=0) in vec2 pos;
layout(location=1) in vec2 uv;
layout(location=2) in vec4 bi;
layout(location=3) in vec4 bw;
layout(location=4) in vec4 fi;
layout(location=5) in vec4 fw;
uniform mat3x2 B[8];
uniform mat3x2 F[16];
uniform vec4 view;
out vec2 t;
void main() {
  vec3 h = vec3(pos, 1.);
  vec2 p = pos + fw.x * (F[int(fi.x)] * h) + fw.y * (F[int(fi.y)] * h) + fw.z * (F[int(fi.z)] * h) + fw.w * (F[int(fi.w)] * h);
  h = vec3(p, 1.);
  vec2 q = bw.x * (B[int(bi.x)] * h) + bw.y * (B[int(bi.y)] * h) + bw.z * (B[int(bi.z)] * h) + bw.w * (B[int(bi.w)] * h);
  gl_Position = vec4((q - view.xy) * view.zw, 0., 1.);
  t = uv;
}`;
const FS = `#version 300 es
precision mediump float;
uniform sampler2D tex;
in vec2 t;
out vec4 o;
void main() { o = texture(tex, t); }`;

/** 2x3 affine matrices as [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (column-major like mat3x2). */
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ID = [1, 0, 0, 1, 0, 0];

/** The transform of a bone or deformer at its origin o, from the sum of its parameters' [dx, dy, deg, sx, sy]. */
function affine(o, p, params) {
  let dx = 0, dy = 0, r = 0, sx = 0, sy = 0;
  for (const k in p) {
    const v = params[k];
    if (!v) continue;
    const q = p[k];
    dx += q[0] * v; dy += q[1] * v; r += q[2] * v; sx += q[3] * v; sy += q[4] * v;
  }
  const c = Math.cos(r * PI / 180), s = Math.sin(r * PI / 180), X = 1 + sx, Y = 1 + sy;
  const a = c * X, b = s * X, cc = -s * Y, d = c * Y;
  return [a, b, cc, d, o[0] + dx - (a * o[0] + cc * o[1]), o[1] + dy - (b * o[0] + d * o[1])];
}

/** Rest-pose matrices for every bone (world) and deformer (minus identity) from the parameters. */
export function pose(rig, params) {
  const world = {}, B = new Float32Array(8 * 6), F = new Float32Array(16 * 6);
  rig.boneOrder.forEach((name, i) => {
    const b = rig.bones[name];
    world[name] = b.parent ? mul(world[b.parent], affine(b.o, b.p, params)) : affine(b.o, b.p, params);
    B.set(world[name], i * 6);
  });
  rig.featureOrder.forEach((name, i) => {
    const f = rig.features[name], m = affine(f.o, f.p, params);
    F.set([m[0] - 1, m[1], m[2], m[3] - 1, m[4], m[5]], i * 6);
  });
  return { B, F };
}

/** How much of the image a w x h view shows (it covers the view) and where: [cx, cy, sx, sy] for the shader. */
function framing(rig, w, h) {
  const [W, H] = rig.size, v = rig.view || {}, zoom = v.zoom || 1, [fx, fy] = v.focus || [.5, .4];
  let sx = 1, sy = (h * W) / (w * H);
  if (sy > 1) { sx = 1 / sy; sy = 1; }
  sx /= zoom; sy /= zoom;
  const cx = clamp(fx, sx / 2, 1 - sx / 2) * W, cy = clamp(fy, sy / 2, 1 - sy / 2) * H;
  return [cx, cy, 2 / (sx * W), -2 / (sy * H)];
}

/** The behaviour: from the call's state and both voices to the rig's parameters, every frame. Eyes lead, the head
 *  follows on a spring, the body follows the head; blinks, breaths and glances come at human intervals. */
export class Behaviour {
  constructor() {
    this.t = 0;
    this.state = "listening";
    this.since = 0;
    this.head = { yaw: new Spring(1.1), pitch: new Spring(1.1), roll: new Spring(.8) };
    this.body = { sway: new Spring(.45), lean: new Spring(.4) };
    this.target = { yaw: 0, pitch: 0, roll: 0 };
    this.nextHead = 0;
    this.gx = new Saccade();
    this.gy = new Saccade();
    this.gaze = { x: 0, y: 0 };
    this.nextGaze = .8;
    this.away = 0;
    this.blink = { t: -1, dur: .2, next: rand(1.5, 3), again: false };
    this.breath = { phase: 0, rate: 1 / 4.3 };
    this.nod = new Pulses();
    this.tilt = new Pulses();
    this.brow = new Pulses();
    this.smileP = new Pulses();
    this.smile = new Spring(.7, .3);
    this.knit = new Spring(.8);
    this.browS = new Spring(3);
    this.level = 0; this.slow = 0; this.lastBeat = 0;
    this.jaw = new Spring(9); this.round = new Spring(7); this.wide = new Spring(7); this.lip = new Spring(8);
    this.bright = 0;
    this.youSince = -1; this.youQuiet = -9;
  }

  enter(state) {
    const was = this.state;
    this.state = state;
    this.since = this.t;
    this.nextHead = this.t;
    this.nextGaze = this.t + (state === "speaking" ? .05 : .15);
    if (state === "hearing") { this.brow.hit(.5, .15, .8); this.tilt.hit(chance(.5) ? .35 : -.35, .5, 2.5); }
    if (state === "thinking") { this.brow.hit(-.2, .3, 1.5); if (chance(.6)) this.blinkNow(); }
    if (state === "tool") this.blinkNow();
    if (was === "speaking" && state !== "speaking") { this.nod.hit(rand(.15, .25), .2, .55); this.smileP.hit(.25, .3, 1.5); }
  }

  blinkNow(dur = rand(.16, .24)) { if (this.blink.t < 0) { this.blink.t = 0; this.blink.dur = dur; } }

  /** Gaze and head targets per state: where he looks, as eye direction (-1..1) and head pose. */
  plan(s, t) {
    const T = this.target;
    if (s === "thinking") {
      const side = this.thinkSide ??= chance(.5) ? 1 : -1;
      if (t > this.nextGaze) {
        this.look(side * rand(.35, .7), rand(-.75, -.4), rand(.12, .2));
        this.nextGaze = t + rand(.9, 2.2);
        if (chance(.25)) this.thinkSide = -side;
      }
      if (t > this.nextHead) { T.yaw = this.gaze.x * .35; T.pitch = -.25 + rand(-.05, .05); T.roll = side * rand(.15, .3); this.nextHead = t + rand(1.5, 3); }
      return;
    }
    this.thinkSide = undefined;
    if (s === "tool") {
      if (t > this.nextGaze) {
        this.readX = (this.readX ?? -.4) + rand(.18, .3);
        if (this.readX > .45) { this.readX = -.45; this.look(-.45, .65, .09); this.nextGaze = t + rand(.25, .4); }
        else { this.look(this.readX, .6 + rand(-.04, .04), .04); this.nextGaze = t + rand(.18, .32); }
      }
      if (t > this.nextHead) { T.yaw = rand(-.1, .1); T.pitch = .38; T.roll = rand(-.08, .08); this.nextHead = t + rand(2, 4); }
      return;
    }
    // listening, hearing, speaking: mostly at him, with glances away; speakers look away more, at phrase starts
    const speaking = s === "speaking", hearing = s === "hearing";
    if (t > this.nextGaze) {
      if (this.away) {
        this.away = 0;
        this.look(rand(-.06, .06), rand(-.04, .04), .05);
        this.nextGaze = t + rand(1.2, speaking ? 3 : 5);
      } else if (chance(speaking ? .45 : hearing ? .12 : .3)) {
        this.away = 1;
        const a = rand(0, 2 * PI);
        this.look(Math.cos(a) * rand(.3, .6), Math.sin(a) * rand(.15, .4) - (speaking ? .1 : 0), rand(.06, .1));
        this.nextGaze = t + rand(.4, speaking ? 1.4 : 1);
      } else {
        this.look(this.gaze.x * .3 + rand(-.07, .07), this.gaze.y * .3 + rand(-.05, .05), .035);
        this.nextGaze = t + rand(.5, 1.8);
      }
    }
    if (t > this.nextHead) {
      const k = speaking ? 1 : .6;
      T.yaw = (this.away ? this.gaze.x * .25 : 0) + rand(-.12, .12) * k;
      T.pitch = (hearing ? .06 : 0) + rand(-.06, .08) * k;
      T.roll = (hearing ? .12 * Math.sign(T.roll || 1) : 0) + rand(-.1, .1) * k;
      this.nextHead = t + rand(speaking ? .8 : 1.8, speaking ? 2.2 : 4);
    }
  }

  look(x, y, dur) {
    const big = Math.hypot(x - this.gaze.x, y - this.gaze.y);
    this.gaze = { x, y };
    this.gx.go(x, dur + big * .05);
    this.gy.go(y, dur + big * .05);
    if (big > .45 && chance(.35)) this.blinkNow(rand(.14, .2));
  }

  step(dt, s, you, it, lo, hi) {
    const t = (this.t += dt);
    if (s !== this.state) this.enter(s);
    const speaking = s === "speaking";

    // his voice heard: start of a turn lifts the brows, end of a long one gets a nod
    if (you > .1) {
      if (this.youSince < 0) { this.youSince = t; if (t - this.youQuiet > 1.2) this.brow.hit(.35, .12, .6); }
      this.youQuiet = t;
    } else if (this.youSince >= 0 && t - this.youQuiet > .45) {
      if (t - this.youSince > .8 && !speaking && chance(.7)) { this.nod.hit(rand(.18, .3), .22, .5); if (chance(.4)) this.nod.hit(rand(.1, .18), .7, .5); }
      this.youSince = -1;
    }

    // its own voice: envelope, stressed syllables (beats) nod and lift the brows a little
    const v = speaking ? it : 0;
    this.level = v > this.level ? lerp(this.level, v, 1 - Math.exp(-dt * 50)) : lerp(this.level, v, 1 - Math.exp(-dt * 16));
    this.slow = lerp(this.slow, this.level, 1 - Math.exp(-dt * 1.8));
    if (speaking && this.level - this.slow > .16 && t - this.lastBeat > .3) {
      this.lastBeat = t;
      if (chance(.55)) this.nod.hit(rand(.08, .16), .16, .4);
      if (chance(.35)) this.brow.hit(rand(.25, .5), .1, .45);
      if (chance(.2)) this.tilt.hit(rand(-.12, .12), .2, .8);
    }
    const bright = v > .03 ? hi / (lo + hi + .02) : this.bright;
    this.bright = lerp(this.bright, bright, 1 - Math.exp(-dt * 20));
    const sib = speaking ? smooth(.28, .45, this.bright) * smooth(.03, .1, this.level) : 0;
    const jaw = this.jaw.to(speaking ? .72 * smooth(.03, .85, this.level) * (1 - .7 * sib) : 0, dt);
    const round = this.round.to(speaking ? smooth(.1, .04, this.bright) * smooth(.05, .3, this.level) * .8 : 0, dt);
    const wide = this.wide.to(speaking ? (smooth(.14, .26, this.bright) * .6 + sib * .5) * smooth(.03, .2, this.level) : 0, dt);
    const lip = this.lip.to(speaking ? jaw * .5 + sib * .4 : 0, dt);

    this.plan(s, t);
    const gx = this.gx.step(dt), gy = this.gy.step(dt);

    // head: target plus slow drift plus gestures; the body trails it
    const T = this.target, drift = speaking ? 1 : .7;
    const nod = this.nod.step(dt), tilt = this.tilt.step(dt);
    const yaw = this.head.yaw.to(T.yaw + .06 * drift * wander(t * .8, 1), dt);
    const pitch = this.head.pitch.to(T.pitch + .05 * drift * wander(t * .9, 2), dt) + nod;
    const roll = this.head.roll.to(T.roll + tilt + .06 * wander(t * .6, 3), dt);
    const sway = this.body.sway.to(-roll * .35 + .25 * wander(t * .35, 5), dt);
    const lean = this.body.lean.to(yaw * .25 + (s === "hearing" ? .2 : 0), dt);

    // breathing: inhale a bit quicker than exhale; speech breathes at phrase gaps
    this.breath.phase += dt * this.breath.rate * (speaking ? 1.15 : 1);
    if (this.breath.phase >= 1) { this.breath.phase -= 1; this.breath.rate = 1 / rand(3.6, 5); }
    const ph = this.breath.phase, breath = ph < .4 ? smooth(0, .4, ph) : 1 - smooth(.4, 1, ph);

    // blinks: every 2-6 s, sometimes twice; close fast, open slower
    const B = this.blink;
    if (B.t < 0 && t > B.next) { this.blinkNow(); }
    let blink = 0;
    if (B.t >= 0) {
      B.t += dt;
      const close = B.dur * .38, k = B.t;
      blink = k < close ? smooth(0, close, k) : 1 - smooth(close + .02, B.dur, k);
      if (k >= B.dur) {
        B.t = -1;
        if (!B.again && chance(.12)) { B.again = true; B.next = t + .12; }
        else { B.again = false; B.next = t + Math.min(7, Math.exp(rand(Math.log(1.8), Math.log(5.5)))); }
      }
    }

    // brows and smile
    const browHit = this.brow.step(dt);
    const knit = this.knit.to(s === "thinking" ? .45 + .15 * wander(t, 9) : s === "tool" ? .25 : 0, dt);
    const brow = this.browS.to(browHit + (s === "hearing" ? .15 : 0) - knit * .2, dt);
    const smileBase = { listening: .35, hearing: .25, thinking: .1, tool: .12, speaking: .22 }[s] ?? .25;
    const smile = this.smile.to(smileBase + .12 * wander(t * .5, 4), dt) + this.smileP.step(dt);

    // the eyes stay on him while the head turns (looking at the camera means countering the head)
    const lidDown = .28 * Math.max(0, gy) + .1 * Math.max(0, pitch) - .12 * Math.max(0, -gy) - .1 * brow;
    return {
      yaw, pitch, roll, sway, lean, breath,
      gazeX: clamp(gx - yaw * .5, -1, 1), gazeY: clamp(gy - pitch * .4, -1, 1),
      blinkR: clamp(Math.max(blink, lidDown + .04 * smile), -.2, 1), blinkL: clamp(Math.max(blink, lidDown + .04 * smile), -.2, 1),
      browR: brow, browL: brow * .9, knit,
      smile: smile * (1 - .5 * jaw), jaw, round, wide, lipup: lip * .6, lipdown: lip,
    };
  }
}

/** Draws the rigged character at `base` into a canvas. now() gives {state, you, it, lo, hi}. Returns stop; with
 *  opts.dt it draws nothing by itself and returns a frame function for fixed-step recording instead. */
export async function rig(canvas, base, now, opts = {}) {
  const R = await (await fetch(base + "rig.json")).json();
  const images = {};
  await Promise.all([...new Set(R.parts.map((p) => p.tex))].map(async (f) => {
    const img = new Image();
    img.src = base + f;
    await img.decode();
    images[f] = img;
  }));
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: !!opts.dt });
  if (!gl) throw new Error("no WebGL2");
  let G = null;
  const setup = () => {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const tex = {};
    for (const [f, img] of Object.entries(images)) {
      tex[f] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex[f]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    }
    const parts = R.parts.map((p) => {
      const n = p.v.length / 2, d = new Float32Array(n * 20), [bx, by, bw, bh] = p.box;
      for (let i = 0; i < n; i++) {
        const x = p.v[2 * i], y = p.v[2 * i + 1], o = i * 20;
        d.set([x, y, (x - bx) / bw, (y - by) / bh], o);
        d.set(p.bi[i], o + 4);
        d.set(p.bw[i], o + 8);
        if (p.fi) { d.set(p.fi[i], o + 12); d.set(p.fw[i], o + 16); }
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
      [2, 2, 4, 4, 4, 4].reduce((off, size, loc) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 80, off * 4);
        return off + size;
      }, 0);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(p.t), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao, count: p.t.length, tex: tex[p.tex] };
    });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    G = { parts, B: gl.getUniformLocation(prog, "B"), F: gl.getUniformLocation(prog, "F"), view: gl.getUniformLocation(prog, "view") };
  };
  setup();
  const lost = (e) => { e.preventDefault(); G = null; };
  const restored = () => setup();
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);

  const behaviour = new Behaviour();
  let last = performance.now(), raf, drew = false;
  const frame = (ms) => {
    if (!opts.dt) raf = requestAnimationFrame(frame);
    const dt = opts.dt || clamp((ms - last) / 1000, 0, .1);
    last = ms;
    const { state, you, it, lo, hi } = now();
    const params = (opts.params || ((p) => p))(behaviour.step(dt, state, you || 0, it || 0, lo || 0, hi || 0));
    opts.tick?.(params);
    if (!G) return;
    const k = Math.min(devicePixelRatio || 1, 2), w = opts.dt ? canvas.width : Math.round(canvas.clientWidth * k), h = opts.dt ? canvas.height : Math.round(canvas.clientHeight * k);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const { B, F } = pose(R, params);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniformMatrix3x2fv(G.B, false, B);
    gl.uniformMatrix3x2fv(G.F, false, F);
    gl.uniform4fv(G.view, framing(R, w, h));
    for (const p of G.parts) {
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.bindVertexArray(p.vao);
      gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_SHORT, 0);
    }
    if (!drew) { drew = true; opts.first?.(); }
  };
  if (opts.dt) return frame;
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored); };
}
