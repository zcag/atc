// A 2D character drawn from a library of drawings ("kind": "rig"). Every drawing comes from the same painted
// portrait: the head at a few angles, and for each angle its eyes (gaze directions, half shut, shut), brows (up,
// knit) and mouth shapes, plus pose layers (a hand to the chin, a notebook, a pen). Like cel animation, the right
// drawing is swapped in for each moment with only a very short dissolve; between head angles the drawings are bent a
// little (skinned meshes: the nose and eyes move more than the outline) so a turn reads as one motion. Pose layers
// rise into frame from below. A grade and a vignette, the lamp's flickering glow and dust in its light give the room
// depth. Behaviour decides the acting from the call's state and both voices; Director turns it into drawings.

import { PI, clamp, smooth, lerp, rand, chance, Spring, Saccade, Pulses, wander } from "./motion.js";

const VS = `#version 300 es
layout(location=0) in vec2 pos;
layout(location=1) in vec2 uv;
layout(location=2) in vec4 bi;
layout(location=3) in vec4 bw;
uniform mat3x2 B[8];
uniform vec4 view;
uniform vec2 shift;
out vec2 t;
void main() {
  vec3 h = vec3(pos, 1.);
  vec2 q = bw.x * (B[int(bi.x)] * h) + bw.y * (B[int(bi.y)] * h) + bw.z * (B[int(bi.z)] * h) + bw.w * (B[int(bi.w)] * h);
  gl_Position = vec4((q + shift - view.xy) * view.zw, 0., 1.);
  t = uv;
}`;
const FS = `#version 300 es
precision mediump float;
uniform sampler2D tex;
uniform float alpha;
in vec2 t;
out vec4 o;
void main() { o = texture(tex, t) * alpha; }`;
const DUST_VS = `#version 300 es
layout(location=0) in vec4 d;
uniform vec4 view;
uniform float px;
out float a;
void main() { gl_Position = vec4((d.xy - view.xy) * view.zw, 0., 1.); gl_PointSize = d.z * px; a = d.w; }`;
const DUST_FS = `#version 300 es
precision mediump float;
uniform vec3 color;
in float a;
out vec4 o;
void main() { float r = length(gl_PointCoord - .5) * 2.; float k = a * smoothstep(1., 0., r) * smoothstep(1., .2, r); o = vec4(color * k, 0.); }`;

/** 2x3 affine matrices as [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (column-major like mat3x2). */
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/** The transform of a bone at its origin o, from the sum of its parameters' [dx, dy, deg, sx, sy]. */
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

/** Every bone's world matrix (rest pose = identity) from the parameters, packed for the shader. */
export function pose(rig, params) {
  const world = {}, B = new Float32Array(8 * 6);
  rig.boneOrder.forEach((name, i) => {
    const b = rig.bones[name];
    world[name] = b.parent ? mul(world[b.parent], affine(b.o, b.p, params)) : affine(b.o, b.p, params);
    B.set(world[name], i * 6);
  });
  return B;
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

/** One drawing at a time in a slot. A change dissolves from the old drawing to the new one over `dur`; a drawing is
 *  kept at least `hold` seconds. layers() says what to draw over the slot's base, in order, with what opacity. */
export class Swap {
  constructor(name = "base") { this.cur = name; this.prev = null; this.k = 1; this.dur = .05; this.since = 9; }
  to(name, dur, hold = 0) {
    if (name === this.cur || this.since < hold) return;
    this.prev = this.cur;
    this.cur = name;
    this.k = dur > 0 ? 0 : 1;
    this.dur = dur;
    this.since = 0;
    if (this.k >= 1) this.prev = null;
  }
  step(dt) {
    this.since += dt;
    if (this.k < 1 && (this.k = Math.min(1, this.k + dt / this.dur)) >= 1) this.prev = null;
  }
  layers() {
    const e = smooth(0, 1, this.k);
    if (!this.prev) return [[this.cur, 1]];
    if (this.cur === "base") return [[this.prev, 1 - e]];
    return [[this.prev, this.prev === "base" ? 0 : 1], [this.cur, e]];
  }
}

const YAW = 12, PITCH = 12; // degrees of head turn per unit of Behaviour's yaw and pitch

/** From Behaviour's continuous acting to drawings: the head angle nearest to where he faces (the rest of the turn
 *  is done by bending), eyes by blink and gaze, brows, the mouth shape from the voice, and the pose layer. */
export class Director {
  constructor(rig) {
    this.keys = Object.entries(rig.angles);
    this.angle = new Swap(this.nearest(0, 0));
    this.eyes = new Swap();
    this.brows = new Swap();
    this.mouth = new Swap();
    this.pose = { cur: null, k: 0 };
    this.gx = 0; this.gy = 0;
  }

  angles(k) { return this.keys.find(([n]) => n === k)[1]; }

  nearest(y, p, cur) {
    const d = (k) => { const [ky, kp] = this.angles(k); return Math.hypot(y - ky, (p - kp) * 1.2); };
    let best = cur, bd = cur ? d(cur) - 1.5 : Infinity;
    for (const [k] of this.keys) if (d(k) < bd) { best = k; bd = d(k); }
    return best;
  }

  step(dt, p) {
    const Y = -p.yaw * YAW, P = p.pitch * PITCH;
    this.angle.to(this.nearest(Y, P, this.angle.cur), .11, .25);
    const axis = (v, cur, hi) => (Math.abs(v) > .42 ? Math.sign(v) * hi : Math.abs(v) < .22 ? 0 : cur);
    this.gx = axis(p.gazeX, this.gx, 12);
    this.gy = axis(-p.gazeY, this.gy, 10);
    const b = Math.max(p.blinkR, p.blinkL);
    if (b > .7) this.eyes.to("shut", .02);
    else if (b > .28) this.eyes.to("half", .02);
    else if ((p.pose === "read" || p.pose === "write") && p.gazeY > .5) this.eyes.to(`r${p.gazeX < -.15 ? -12 : 0}`, .035, this.eyes.cur === "half" ? 0 : .08);
    else this.eyes.to(this.gx || this.gy ? `g${this.gx}_${this.gy}` : "base", .035, this.eyes.cur === "half" ? 0 : .08);
    this.brows.to(p.brow > .3 ? "up" : p.knit > .3 ? "knit" : "base", .12, .2);
    const open = p.jaw / .72;
    let m = "base";
    if (open >= .1) {
      const lvl = open < .38 ? 1 : open < .7 ? 2 : 3;
      m = p.round > .35 ? `o${Math.min(2, lvl)}` : p.wide > .3 ? `e${Math.min(2, lvl)}` : `a${lvl}`;
    } else if (p.round > .5) m = "u";
    this.mouth.to(m, .045, .07);
    for (const s of [this.angle, this.eyes, this.brows, this.mouth]) s.step(dt);
    const Z = this.pose;
    if (Z.cur !== (p.pose || null)) {
      Z.k -= dt / .4;
      if (Z.k <= 0) { Z.k = 0; Z.cur = p.pose || null; }
    } else if (Z.cur) Z.k = Math.min(1, Z.k + dt / .6);
    return { Y, P };
  }
}

/** The behaviour: from the call's state and both voices to acting, every frame. Eyes lead, the head follows on a
 *  spring, the body trails; blinks, breaths and glances come at human intervals. Each state has its own business:
 *  listening is relaxed, hearing him leans in and nods, thinking puts a hand to the chin or looks up and away, a tool
 *  means reading or writing in a notebook, speaking looks at him with beats on stressed syllables. */
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
    this.jaw = new Spring(9); this.round = new Spring(7); this.wide = new Spring(7);
    this.bright = 0;
    this.youSince = -1; this.youQuiet = -9;
    this.pose = null;
  }

  enter(state) {
    const was = this.state;
    this.state = state;
    this.since = this.t;
    this.nextHead = this.t;
    this.nextGaze = this.t + (state === "speaking" ? .05 : .15);
    this.pose = state === "thinking" ? (chance(.7) ? "think" : null) : state === "tool" ? (chance(.55) ? "read" : "write") : null;
    this.readX = undefined;
    if (state === "hearing") { this.brow.hit(.5, .15, .8); this.tilt.hit(chance(.5) ? .35 : -.35, .5, 2.5); }
    if (state === "thinking") { this.brow.hit(-.2, .3, 1.5); if (chance(.6)) this.blinkNow(); }
    if (state === "tool") this.blinkNow();
    if (was === "speaking" && state !== "speaking") { this.nod.hit(rand(.15, .25), .2, .55); this.smileP.hit(.25, .3, 1.5); }
  }

  blinkNow(dur = rand(.16, .24)) { if (this.blink.t < 0) { this.blink.t = 0; this.blink.dur = dur; } }

  look(x, y, dur) {
    const big = Math.hypot(x - this.gaze.x, y - this.gaze.y);
    this.gaze = { x, y };
    this.gx.go(x, dur + big * .05);
    this.gy.go(y, dur + big * .05);
    if (big > .45 && chance(.35)) this.blinkNow(rand(.14, .2));
  }

  /** Where he looks (eye direction, -1..1) and where his head goes, per state. */
  plan(s, t) {
    const T = this.target;
    if (s === "thinking") {
      const side = (this.thinkSide ??= chance(.5) ? 1 : -1);
      if (t > this.nextGaze) {
        this.look(side * rand(.5, .9), rand(-.9, -.55), rand(.12, .2));
        this.nextGaze = t + rand(1.1, 2.6);
        if (chance(.2)) this.thinkSide = -side;
      }
      if (t > this.nextHead) {
        const hand = this.pose === "think";
        T.yaw = hand ? 0 : side * rand(.3, .5); T.pitch = hand ? -.05 : rand(-.5, -.35); T.roll = side * rand(.1, hand ? .15 : .3);
        this.nextHead = t + rand(1.8, 3.2);
      }
      return;
    }
    this.thinkSide = undefined;
    if (s === "tool") {
      if (t > this.nextGaze) {
        if (this.pose === "write") {
          this.look(rand(-.5, .5), rand(.7, 1), .05);
          this.nextGaze = t + rand(.35, .8);
        } else if (chance(.06) && t - this.since > 1.5) {
          this.look(0, 0, .06);
          this.nextGaze = t + rand(.5, .9);
        } else {
          this.readX = (this.readX ?? -.7) + rand(.6, .8);
          if (this.readX > .8) { this.readX = -.7; this.look(-.7, rand(.75, 1), .08); this.nextGaze = t + rand(.3, .45); }
          else { this.look(this.readX, rand(.75, 1), .04); this.nextGaze = t + rand(.25, .45); }
        }
      }
      if (t > this.nextHead) { T.yaw = rand(-.2, -.1); T.pitch = .95; T.roll = rand(-.08, .08); this.nextHead = t + rand(2, 4); }
      return;
    }
    const speaking = s === "speaking", hearing = s === "hearing";
    if (t > this.nextGaze) {
      if (this.away) {
        this.away = 0;
        this.look(rand(-.08, .08), rand(-.06, .06), .05);
        this.nextGaze = t + rand(1.2, speaking ? 3 : 5);
      } else if (chance(speaking ? .45 : hearing ? .1 : .3)) {
        this.away = 1;
        const a = rand(0, 2 * PI);
        this.look(Math.cos(a) * rand(.5, .9), Math.sin(a) * rand(.3, .7) - (speaking ? .15 : 0), rand(.06, .1));
        this.nextGaze = t + rand(.5, speaking ? 1.4 : 1.1);
      } else {
        this.look(this.gaze.x * .3 + rand(-.1, .1), this.gaze.y * .3 + rand(-.08, .08), .035);
        this.nextGaze = t + rand(.6, 2);
      }
    }
    if (t > this.nextHead) {
      const k = speaking ? 1 : .6;
      T.yaw = (this.away ? this.gaze.x * .5 : 0) + rand(-.25, .25) * k + (speaking && chance(.25) ? Math.sign(rand(-1, 1)) * rand(.45, .6) : 0);
      T.pitch = (hearing ? .08 : 0) + rand(-.1, .12) * k;
      T.roll = (hearing ? .15 * Math.sign(T.roll || 1) : 0) + rand(-.12, .12) * k;
      this.nextHead = t + rand(speaking ? .9 : 1.8, speaking ? 2.4 : 4);
    }
  }

  step(dt, s, you, it, lo, hi) {
    const t = (this.t += dt);
    if (s !== this.state) this.enter(s);
    const speaking = s === "speaking";

    if (you > .1) {
      if (this.youSince < 0) { this.youSince = t; if (t - this.youQuiet > 1.2) this.brow.hit(.45, .12, .6); }
      this.youQuiet = t;
    } else if (this.youSince >= 0 && t - this.youQuiet > .45) {
      if (t - this.youSince > .8 && !speaking && chance(.75)) { this.nod.hit(rand(.18, .3), .22, .5); if (chance(.4)) this.nod.hit(rand(.1, .18), .7, .5); }
      this.youSince = -1;
    }

    const v = speaking ? it : 0;
    this.level = v > this.level ? lerp(this.level, v, 1 - Math.exp(-dt * 50)) : lerp(this.level, v, 1 - Math.exp(-dt * 16));
    this.slow = lerp(this.slow, this.level, 1 - Math.exp(-dt * 1.8));
    if (speaking && this.level - this.slow > .16 && t - this.lastBeat > .3) {
      this.lastBeat = t;
      if (chance(.55)) this.nod.hit(rand(.08, .16), .16, .4);
      if (chance(.4)) this.brow.hit(rand(.4, .7), .1, .5);
      if (chance(.2)) this.tilt.hit(rand(-.15, .15), .2, .8);
    }
    const bright = v > .03 ? hi / (lo + hi + .02) : this.bright;
    this.bright = lerp(this.bright, bright, 1 - Math.exp(-dt * 20));
    const sib = speaking ? smooth(.28, .45, this.bright) * smooth(.03, .1, this.level) : 0;
    const jaw = this.jaw.to(speaking ? .72 * smooth(.03, .85, this.level) * (1 - .7 * sib) : 0, dt);
    const round = this.round.to(speaking ? smooth(.1, .04, this.bright) * smooth(.05, .3, this.level) * .8 : 0, dt);
    const wide = this.wide.to(speaking ? (smooth(.14, .26, this.bright) * .6 + sib * .5) * smooth(.03, .2, this.level) : 0, dt);

    this.plan(s, t);
    const gx = this.gx.step(dt), gy = this.gy.step(dt);

    const T = this.target, still = this.pose === "think" ? .3 : 1, drift = (speaking ? 1 : .7) * still;
    const nod = this.nod.step(dt) * still, tilt = this.tilt.step(dt);
    const yaw = this.head.yaw.to(T.yaw + .06 * drift * wander(t * .8, 1), dt);
    const pitch = this.head.pitch.to(T.pitch + .05 * drift * wander(t * .9, 2), dt) + nod;
    const roll = this.head.roll.to(T.roll + tilt + .06 * wander(t * .6, 3), dt);
    const sway = this.body.sway.to(-roll * .35 + .25 * wander(t * .35, 5), dt);
    const lean = this.body.lean.to(-yaw * .25 + (s === "hearing" ? .35 : 0), dt);

    this.breath.phase += dt * this.breath.rate * (speaking ? 1.15 : 1);
    if (this.breath.phase >= 1) { this.breath.phase -= 1; this.breath.rate = 1 / rand(3.6, 5); }
    const ph = this.breath.phase, breath = ph < .4 ? smooth(0, .4, ph) : 1 - smooth(.4, 1, ph);

    const B = this.blink;
    if (B.t < 0 && t > B.next) this.blinkNow();
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

    const browHit = this.brow.step(dt);
    const knit = this.knit.to(s === "thinking" ? .55 + .15 * wander(t, 9) : s === "tool" ? .2 : 0, dt);
    const brow = this.browS.to(browHit + (s === "hearing" ? .1 : 0) - knit * .2, dt);
    const smileBase = { listening: .35, hearing: .25, thinking: .1, tool: .12, speaking: .22 }[s] ?? .25;
    const smile = this.smile.to(smileBase + .12 * wander(t * .5, 4), dt) + this.smileP.step(dt);

    return {
      yaw, pitch, roll, sway, lean, breath,
      gazeX: clamp(gx, -1, 1), gazeY: clamp(gy, -1, 1),
      blinkR: blink, blinkL: blink, brow, knit,
      smile: smile * (1 - .5 * jaw), jaw, round, wide, pose: this.pose,
    };
  }
}

/** Draws the character at `base` into a canvas. now() gives {state, you, it, lo, hi}. Returns stop; with opts.dt it
 *  draws nothing by itself and returns a frame function for fixed-step recording instead. */
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
  const program = (vs, fs) => {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    return { prog, u: (n) => (u[n] ??= gl.getUniformLocation(prog, n)) };
  };
  const dust = R.dust && Array.from({ length: R.dust.n }, () => ({}));
  const respawn = (d, anywhere) => {
    const [x, y, w, h] = R.dust.box;
    Object.assign(d, { x: x + rand(0, w), y: anywhere ? y + rand(0, h) : y + h, vx: rand(-4, 4), vy: rand(-9, -3), s: rand(...R.dust.size), a: rand(.15, .55), ph: rand(0, 9), life: 0 });
  };
  dust?.forEach((d) => respawn(d, true));
  let G = null;
  const setup = () => {
    const main = program(VS, FS), motes = program(DUST_VS, DUST_FS);
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
    const parts = {};
    for (const p of R.parts) {
      const n = p.v.length / 2, d = new Float32Array(n * 12), [bx, by, bw, bh] = p.box, [u0, v0, u1, v1] = p.uv || [0, 0, 1, 1];
      for (let i = 0; i < n; i++) {
        const x = p.v[2 * i], y = p.v[2 * i + 1], o = i * 12;
        d.set([x, y, u0 + (x - bx) / bw * (u1 - u0), v0 + (y - by) / bh * (v1 - v0)], o);
        d.set(p.bi[i], o + 4);
        d.set(p.bw[i], o + 8);
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
      [2, 2, 4, 4].reduce((off, size, loc) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 48, off * 4);
        return off + size;
      }, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(p.t), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      parts[p.name] = { vao, count: p.t.length, tex: tex[p.tex], blend: p.blend };
    }
    const dvao = gl.createVertexArray(), dbuf = gl.createBuffer();
    gl.bindVertexArray(dvao);
    gl.bindBuffer(gl.ARRAY_BUFFER, dbuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(main.prog);
    gl.uniform1f(main.u("alpha"), 0);
    for (const q of Object.values(parts)) {
      gl.bindTexture(gl.TEXTURE_2D, q.tex);
      gl.bindVertexArray(q.vao);
      gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
    gl.finish();
    G = { main, motes, parts, dvao, dbuf, ddata: new Float32Array((dust?.length || 0) * 4) };
  };
  setup();
  const lost = (e) => { e.preventDefault(); G = null; };
  const restored = () => setup();
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);

  const behaviour = new Behaviour(), director = new Director(R);
  const BLEND = { add: [gl.ONE, gl.ONE], mul: [gl.DST_COLOR, gl.ZERO] };
  let last = performance.now(), raf, drew = false, clock = 0;
  const draw = (name, alpha = 1, shift = [0, 0]) => {
    const q = G.parts[name];
    if (!q || alpha <= .002) return;
    const [s, d] = BLEND[q.blend] || [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    gl.blendFunc(s, d);
    gl.uniform1f(G.main.u("alpha"), alpha);
    gl.uniform2f(G.main.u("shift"), shift[0], shift[1]);
    gl.bindTexture(gl.TEXTURE_2D, q.tex);
    gl.bindVertexArray(q.vao);
    gl.drawElements(gl.TRIANGLES, q.count, gl.UNSIGNED_SHORT, 0);
  };
  const frame = (ms) => {
    if (!opts.dt) raf = requestAnimationFrame(frame);
    const dt = opts.dt || clamp((ms - last) / 1000, 0, .1);
    last = ms;
    clock += dt;
    const { state, you, it, lo, hi } = now();
    const params = (opts.params || ((p) => p))(behaviour.step(dt, state, you || 0, it || 0, lo || 0, hi || 0));
    const { Y, P } = director.step(dt, params);
    opts.tick?.(params, director);
    if (dust) for (const d of dust) {
      d.life += dt;
      d.x += (d.vx + 3 * Math.sin(clock * .7 + d.ph)) * dt;
      d.y += d.vy * dt;
      if (d.y < R.dust.box[1] || d.life > 40) respawn(d, false);
    }
    if (!G) return;
    const k = Math.min(devicePixelRatio || 1, 2), w = opts.dt ? canvas.width : Math.round(canvas.clientWidth * k), h = opts.dt ? canvas.height : Math.round(canvas.clientHeight * k);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const view = framing(R, w, h);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(G.main.prog);
    gl.uniform4fv(G.main.u("view"), view);
    const bones = (key) => {
      const [ky, kp] = key ? director.angles(key) : [0, 0];
      gl.uniformMatrix3x2fv(G.main.u("B"), false, pose(R, { ...params, yawRes: key ? clamp(Y - ky, -6, 6) : 0, pitchRes: key ? clamp(P - kp, -6, 6) : 0 }));
    };
    bones(null);
    draw("plate");
    draw("body");
    for (const [key, a] of director.angle.layers()) {
      if (a <= .002) continue;
      bones(key);
      draw(`head.${key}`, a);
      for (const slot of ["brows", "eyes", "mouth"]) for (const [name, w_] of director[slot].layers()) if (name !== "base") draw(`${key}.${slot}.${name}`, a * w_);
    }
    const Z = director.pose;
    if (Z.cur && Z.k > 0) {
      bones(director.angle.cur);
      const e = 1 - (1 - Z.k) ** 3;
      draw(`pose.${Z.cur}`, clamp(e * 4), [0, (1 - e) * .2 * R.size[1] + 3 * params.breath]);
    }
    bones(null);
    draw("vignette");
    draw("glow", .9 + .06 * Math.sin(clock * 1.3) + .04 * Math.sin(clock * 3.7 + 1));
    if (dust) {
      dust.forEach((d, i) => G.ddata.set([d.x, d.y, d.s, d.a * clamp(d.life / 2) * (.6 + .4 * Math.sin(clock * 1.5 + d.ph))], i * 4));
      gl.useProgram(G.motes.prog);
      gl.uniform4fv(G.motes.u("view"), view);
      gl.uniform1f(G.motes.u("px"), view[2] * w / 2);
      gl.uniform3fv(G.motes.u("color"), R.dust.color.map((c) => c / 255));
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(G.dvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.dbuf);
      gl.bufferData(gl.ARRAY_BUFFER, G.ddata, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, dust.length);
    }
    gl.bindVertexArray(null);
    if (!drew) { drew = true; opts.first?.(); }
  };
  if (opts.dt) return frame;
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored); };
}
