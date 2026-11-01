// The call screen's illustrated characters ("kind": "illustration"). One painted portrait and edits of it: face
// variants (blinks, glances, brows, smiles, mouth shapes) and whole-head variants (turns, nods, a lean). Each
// variant comes with optical flow to and from the portrait, so the shader morphs: eyelids slide, lips part,
// irises travel and the head turns by moving pixels, and only what is new (teeth, a closed lid) fades in.
// A behaviour model (Mind) decides every frame where he looks and how he moves, from the call's state and both
// voices' loudness. The phone's call screen runs this same file in a WebView (persona.html).

const PI = Math.PI, clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;
const pick = (list) => { let r = Math.random() * list.reduce((a, [, w]) => a + w, 0); for (const [n, w] of list) if ((r -= w) <= 0) return n; return list[0][0]; };

/** Critically damped follower: x reaches its target smoothly in about 1/hz seconds. */
class Spring {
  constructor(hz, x = 0) { this.hz = hz; this.x = x; this.v = 0; }
  to(target, dt) {
    const w = 2 * PI * this.hz, f = 1 + 2 * dt * w, dtw2 = dt * w * w;
    this.v = (this.v + dtw2 * (target - this.x)) / (f + dt * dtw2);
    this.x += this.v * dt;
    return this.x;
  }
  kick(v) { this.v += v; }
}

/** A quick move from where it is to a target along a minimum-jerk curve, the way eyes jump. */
class Saccade {
  constructor() { this.from = 0; this.to = 0; this.t = 1; this.dur = .1; this.x = 0; }
  go(to, dur) { this.from = this.x; this.to = to; this.t = 0; this.dur = dur; }
  step(dt) {
    this.t = Math.min(1, this.t + dt / this.dur);
    const s = this.t, k = s * s * s * (10 - 15 * s + 6 * s * s);
    return (this.x = lerp(this.from, this.to, k));
  }
}

/** Short gestures that rise and fall back: a nod, a brow flash, an "mm". hit(amount, rise, fall) adds one. */
class Pulses {
  constructor() { this.list = []; this.x = 0; }
  hit(amount, rise = .08, fall = .35) { this.list.push({ a: amount, rise, fall, t: 0 }); }
  step(dt) {
    let x = 0;
    for (const p of this.list) {
      p.t += dt;
      x += p.a * (p.t < p.rise ? smooth(0, p.rise, p.t) : 1 - smooth(0, p.fall, p.t - p.rise));
    }
    this.list = this.list.filter((p) => p.t < p.rise + p.fall);
    return (this.x = x);
  }
}

/** Which drawing a feature shows: a change of drawing is held at least `hold` seconds and cross-fades in `fade`. */
class Drawing {
  constructor(fade) { this.fade = fade; this.cur = null; this.prev = null; this.at = -9; }
  set(name, t, hold = 0) {
    if (name === this.cur || t - this.at < hold) return;
    this.prev = this.cur;
    this.cur = name;
    this.at = t;
  }
  shown(t) { return this.cur ? clamp((t - this.at) / this.fade) : this.prev ? 1 - clamp((t - this.at) / this.fade) : 0; }
  weights(t) {
    const k = clamp((t - this.at) / this.fade), w = {};
    if (this.prev && k < 1) w[this.prev] = 1 - k;
    if (this.cur) w[this.cur] = k;
    return w;
  }
}

/** Slow wandering noise in -1..1 from a few incommensurate sines. */
const wander = (t, seed) => (Math.sin(t * .23 + seed) + Math.sin(t * .37 + seed * 2.1) * .7 + Math.sin(t * .61 + seed * 3.7) * .4) / 2.1;

/** The behaviour: from the call's state and both voices' loudness to the face's weights and the head's pose. */
export class Mind {
  constructor() {
    this.t = 0;
    this.state = "listening";
    this.since = 0;
    this.gx = new Saccade();
    this.gy = new Saccade();
    this.nextGaze = 1;
    this.fixUntil = 0;
    this.blinkAt = 2;
    this.blinkT = -1;
    this.blinkLen = .2;
    this.headYaw = new Spring(1.3);
    this.headPitch = new Spring(1.1);
    this.nod = new Pulses();
    this.lean = new Spring(.5);
    this.tilt = new Spring(.45);
    this.smile = new Spring(.9);
    this.smileOpen = new Spring(1.6);
    this.browUp = new Spring(2);
    this.flash = new Pulses();
    this.knit = new Spring(.8);
    this.half = new Spring(1.2);
    this.wide = new Pulses();
    this.purse = new Spring(1.2);
    this.press = new Pulses();
    this.rising = false;
    this.roundT = 0;
    this.spreadT = 0;
    this.open = new Spring(9);
    this.round = new Spring(5);
    this.spread = new Spring(5);
    this.level = 0;
    this.slow = 0;
    this.peak = 0;
    this.lastSyl = -1;
    this.voiceOn = 0;
    this.youOn = 0;
    this.youSince = -1;
    this.youQuiet = 0;
    this.pulse = 0;
    this.breathPhase = 0;
    this.breathRate = 1 / 4.2;
    this.sigh = 0;
    this.read = 0;
    this.posture = { yaw: 0, pitch: 0, roll: 0, until: 4 };
    this.postYaw = new Spring(.25);
    this.postPitch = new Spring(.25);
    this.postRoll = new Spring(.2);
    this.torsoX = new Spring(.35);
    this.torsoR = new Spring(.3);
    this.greet = rand(.5, .9);
    this.eyes = new Drawing(.035);
    this.brows = new Drawing(.12);
    this.mouth = new Drawing(.035);
  }

  enter(state) {
    const was = this.state;
    this.state = state;
    this.since = this.t;
    this.fixUntil = this.t;
    this.nextGaze = this.t + (state === "thinking" || state === "tool" ? .05 : rand(.15, .4));
    if (chance(.75)) this.blink(this.t + rand(0, .08));
    if (state === "hearing") { this.wide.hit(.45, .12, .7); this.flash.hit(.5, .12, .8); }
    if (was === "speaking" && state !== "speaking") { this.nod.hit(rand(.2, .32), .2, .5); this.flash.hit(.25, .15, .6); this.pulse = 1; }
    if (state === "speaking" && was !== "speaking") { this.sigh = Math.max(this.sigh, .6); if (chance(.5)) this.nextGaze = this.t; }
    if (state === "thinking" && chance(.5)) this.nod.hit(-.25, .25, .6);
  }

  blink(at, len = rand(.17, .26)) { if (this.blinkT < 0) { this.blinkAt = at; this.blinkLen = len; } }

  lookAt(x, y, hold) {
    const amp = Math.hypot(x - this.gx.to, y - this.gy.to);
    const dur = .045 + .09 * Math.min(1, amp);
    this.gx.go(x, dur);
    this.gy.go(y, dur);
    this.fixUntil = this.t + hold;
    if (amp > .45 && chance(.55)) this.blink(this.t + .01);
  }

  /** Where to look next, by state: people hold eye contact while listening, look away to think, read while working. */
  gaze() {
    const s = this.state, k = this.t - this.since;
    if (s === "thinking") {
      const side = chance(.5) ? 1 : -1;
      return this.lookAt(side * rand(.35, .8), rand(.45, .9), rand(.9, 2.2));
    }
    if (s === "tool") {
      if (chance(.15) && k > 2) return this.lookAt(rand(-.1, .1), rand(-.05, .05), rand(.6, 1.1));
      this.read = (this.read + 1) % 5;
      return this.lookAt(-.45 + this.read * .22, -rand(.7, .9), this.read === 4 ? rand(.4, .7) : rand(.18, .32));
    }
    if (s === "speaking" && (k < .5 && chance(.6) || chance(.12))) return this.lookAt(rand(.3, .6) * (chance(.5) ? 1 : -1), rand(-.25, .35), rand(.4, .9));
    if (s === "listening" && chance(.12)) {
      const where = pick([["desk", 1], ["window", 1], ["aside", 1]]);
      if (where === "desk") return this.lookAt(rand(-.5, -.2), -rand(.5, .8), rand(.8, 1.6));
      if (where === "window") return this.lookAt(rand(.55, .9), rand(-.05, .2), rand(.7, 1.4));
      return this.lookAt(rand(-.6, .6), rand(-.2, .3), rand(.5, 1));
    }
    const micro = s === "hearing" ? .04 : .06;
    this.lookAt(rand(-micro, micro), rand(-micro, micro) * .7, rand(.5, 1.8));
  }

  step(dt, state, you, it, lo = it * .9, hi = it * .1) {
    this.t += dt;
    if (state !== this.state) this.enter(state);
    if (this.greet && this.t > this.greet) { this.greet = 0; this.nod.hit(.3, .22, .55); this.flash.hit(.35, .15, .7); this.pulse = 1; }
    const s = this.state, t = this.t, speaking = s === "speaking", thinking = s === "thinking", tool = s === "tool";
    const hearing = s === "hearing" || (s === "listening" && you > .1);

    if (t >= this.fixUntil && t >= this.nextGaze) this.gaze();
    const ex = this.gx.step(dt), ey = this.gy.step(dt);

    if (this.blinkT < 0 && t >= this.blinkAt) this.blinkT = 0;
    let lid = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const k = this.blinkT / this.blinkLen;
      lid = k < .35 ? smooth(0, .35, k) : k < .45 ? 1 : 1 - smooth(.45, 1, k);
      if (k >= 1) {
        this.blinkT = -1;
        const every = thinking ? 5 : speaking ? 2.8 : tool ? 4.5 : 3.6;
        this.blinkAt = t + (chance(.1) ? rand(.12, .25) : every * rand(.4, 1.5));
        this.blinkLen = s === "listening" && chance(.15) ? rand(.35, .55) : rand(.17, .26);
      }
    }

    // His voice: an onset after quiet raises attention, a pause after talking earns a nod and an "mm".
    if (you > .1) {
      if (this.youSince < 0) { this.youSince = t; if (t - this.youQuiet > 1.2) { this.flash.hit(.35, .1, .6); this.wide.hit(.2, .1, .5); } }
      this.youQuiet = t;
    } else if (this.youSince >= 0 && t - this.youQuiet > .45) {
      if (t - this.youSince > .8 && !speaking && chance(.75)) { this.nod.hit(rand(.3, .5), .18, .45); if (chance(.5)) this.press.hit(.6, .1, .35); this.pulse = 1; }
      this.youSince = -1;
    }
    this.youOn = lerp(this.youOn, hearing ? 1 : 0, 1 - Math.exp(-dt * 3));

    // His own voice: a rise well above its recent level is a stressed syllable, which lifts the brows and nods.
    const v = speaking ? it : 0;
    this.level = v > this.level ? lerp(this.level, v, 1 - Math.exp(-dt * 60)) : lerp(this.level, v, 1 - Math.exp(-dt * 18));
    this.slow = lerp(this.slow, this.level, 1 - Math.exp(-dt * 2));
    if (this.level - this.slow > .18 && t - this.lastSyl > .35) {
      this.lastSyl = t;
      if (chance(.6)) this.nod.hit(rand(.15, .3), .12, .3);
      if (chance(.4)) this.flash.hit(rand(.3, .6), .1, .45);
    }
    // What is being said, roughly, from where its energy sits: high-band frames are s, sh, f, t (teeth together,
    // lips spread), dark vowels round the lips, bright ones widen them.
    const bright = v > .03 ? hi / (lo + hi + .02) : 0;
    this.bright = lerp(this.bright ?? 0, bright, 1 - Math.exp(-dt * 25));
    const sib = speaking ? smooth(.3, .5, this.bright) * smooth(.02, .08, this.level) : 0;
    this.sib = lerp(this.sib ?? 0, sib, 1 - Math.exp(-dt * 20));
    if (!this.rising && this.level > .1 && this.level > this.slow) { this.rising = true; this.jitter = rand(-.25, .25); }
    else if (this.rising && this.level < .06) this.rising = false;
    this.roundT = clamp(smooth(.09, .05, this.bright) + (this.jitter ?? 0) * .6) * (1 - this.sib);
    this.spreadT = clamp(smooth(.13, .22, this.bright) - (this.jitter ?? 0) * .5) * (1 - this.sib);
    this.voiceOn = lerp(this.voiceOn, speaking ? 1 : 0, 1 - Math.exp(-dt * 2));
    const open = this.open.to(.9 * smooth(.04, .8, this.level) * (1 - .75 * this.sib), dt);
    const round = this.round.to(this.roundT, dt), spread = this.spread.to(this.spreadT, dt);
    if (speaking && this.level < .03 && this.slow > .1 && chance(dt * 2)) this.press.hit(.7, .05, .2);

    this.pulse = Math.max(0, this.pulse - dt * 1.2);
    const smileBase = { listening: .35, hearing: .25, thinking: .05, tool: .1, speaking: .2 }[s] ?? .2;
    const smile = this.smile.to(smileBase + this.pulse * .35 + .18 * wander(t * .7, 4) * (s === "listening" ? 1 : .3), dt);
    const smileOpen = this.smileOpen.to(speaking ? 0 : this.pulse * .3, dt);
    const knit = this.knit.to(thinking ? .3 + .15 * wander(t, 9) : tool ? .3 : 0, dt);
    const half = this.half.to(thinking ? .25 : tool ? .35 : s === "listening" ? .08 : 0, dt);
    const wide = this.wide.step(dt);
    const browUp = this.browUp.to(hearing ? .12 : 0, dt) + this.flash.step(dt);
    const purse = this.purse.to(thinking && wander(t, 2) > .2 ? .5 : 0, dt);
    const press = this.press.step(dt);

    if (speaking && this.level > .12 && this.slow < .06 && t - (this.phraseAt ?? 0) > 1.2) {
      this.phraseAt = t;
      this.posture = { yaw: rand(-.3, .3), pitch: rand(-.18, .12), roll: rand(-.035, .035), until: t + rand(4, 8) };
    }
    if (t > this.posture.until) {
      const calm = speaking ? 1 : .7;
      this.posture = { yaw: rand(-.18, .18) * calm, pitch: rand(-.12, .1) * calm, roll: rand(-.025, .025), until: t + rand(6, 14) };
    }
    this.postYaw.hz = this.postPitch.hz = speaking ? .7 : .25;
    const py = this.postYaw.to(this.posture.yaw, dt), pp = this.postPitch.to(this.posture.pitch, dt), pr = this.postRoll.to(this.posture.roll, dt);
    const sway = speaking ? 1.3 : hearing ? .7 : 1;
    const yaw = this.headYaw.to(ex * .45 + py + .1 * sway * wander(t, 1) + (hearing ? .08 : 0), dt);
    const pitch = this.headPitch.to(ey * .4 + pp - (speaking ? this.level * .12 : 0) + .06 * sway * wander(t, 5) + (tool ? -.4 : thinking ? .25 : 0), dt);
    const nod = this.nod.step(dt);
    const lean = this.lean.to(hearing ? .55 : speaking ? .2 : tool ? .25 : 0, dt);
    const roll = this.tilt.to(hearing ? .05 : thinking ? -.035 : 0, dt) + pr + .008 * wander(t, 7) * sway;

    this.sigh = Math.max(0, this.sigh - dt * .5);
    this.breathRate = lerp(this.breathRate, speaking ? 1 / 3.2 : 1 / 4.4, 1 - Math.exp(-dt));
    this.breathPhase += dt * this.breathRate * 2 * PI;
    if (s === "listening" && chance(dt / 25)) this.sigh = 1;
    const torso = [this.torsoX.to(yaw * .012 + .004 * wander(t * .6, 11), dt), this.torsoR.to(roll * .35 + yaw * .01 + .006 * wander(t * .5, 13), dt),
      .004 * (.5 + .5 * Math.sin(this.breathPhase)) + .003 * this.sigh];
    const breath = .005 * Math.sin(this.breathPhase) + .006 * this.sigh * Math.sin(Math.min(PI, (1 - this.sigh) * PI * 2));

    // Eyes, brows and mouth switch between renders of one model of his face (a gaze grid, blink steps, mouth
    // openings by shape): neighbours differ little, so stepping through them at frame rate reads as motion.
    const tx = this.gx.to, ty = this.gy.to;
    let eye = null;
    if (lid > .72) eye = "b3";
    else if (lid > .45) eye = "b2";
    else if (lid > .2) eye = "b1";
    else {
      const gx = clamp(Math.round(tx * 2.4), -2, 2) * 6, gy = clamp(Math.round(ty * 1.6), -1, 1) * 10;
      eye = gx || gy ? `g_${gx}_${gy}` : half > .2 ? "rest" : null;
    }
    this.eyes.set(eye, t);

    const up = browUp + wide, down = knit;
    this.brows.set(up > .55 ? "br_u2" : up > .22 ? "br_u1" : down > .5 ? "br_k2" : down > .22 ? "br_k1" : null, t);

    let mouth = null;
    if (speaking) {
      const i = clamp(Math.floor(Math.pow(open, 1.4) * 5), 0, 4);
      if (this.sib > .45) mouth = "e_0";
      else if (open > .05) mouth = round > .65 ? `o_${Math.min(2, i >> 1)}` : spread > .6 && i < 3 ? `e_${i >> 1}` : `m_${i}`;
    } else if (press > .3 || purse > .3) mouth = "press";
    else if ((s === "listening" || s === "hearing") && this.pulse > .6) mouth = "smile2";
    else if (smile > .45) mouth = "smile1";
    this.mouth.set(mouth, t);

    const face = { ...this.eyes.weights(t), ...this.brows.weights(t), ...this.mouth.weights(t) };
    return {
      face,
      head: { head_r: clamp(yaw, 0, 1), head_l: clamp(-yaw, 0, 1), head_up: clamp(pitch - nod, 0, 1), head_down: clamp(nod - pitch, 0, 1.1), lean: clamp(lean) },
      roll, breath, torso, light: .03 * Math.sin(t * 1.7) * Math.sin(t * .37),
      parallax: [-yaw * .006, pitch * .003],
    };
  }
}

const VS = `#version 300 es
in vec2 p; out vec2 v; void main() { v = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;

const FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D plate, chr, face, fflow, fmask, head;
uniform vec4 box, fade;
uniform vec2 size, fgrid, hgrid, span, center, pivot, headc, parallax;
uniform float fid[8], fw[8], fm[8], hw[6];
uniform float fscale, hscale, roll, breath, light, premul;
uniform vec3 torso;
vec2 cell(float i, vec2 grid, vec2 f) { float r = floor((i + .5) / grid.x); return (vec2(i - r * grid.x, r) + clamp(f, .002, .998)) / grid; }
void main() {
  vec2 uv = center + (v - .5) * span;
  vec2 q = uv;
  vec2 hip = vec2(.5, 1.25), d = (q - hip) * vec2(size.x / size.y, 1.);
  float ta = -torso.y;
  q = hip + vec2(cos(ta) * d.x - sin(ta) * d.y, sin(ta) * d.x + cos(ta) * d.y) * vec2(size.y / size.x, 1.);
  q.x -= torso.x * smoothstep(1.1, .3, q.y);
  q.y += torso.z * smoothstep(.85, .6, q.y) * smoothstep(.35, .55, q.y);
  float near = exp(-pow(length((q - headc) * vec2(1., 1.25)) / .26, 2.6));
  float a = -roll * near;
  vec2 r = (q - pivot) * vec2(size.x / size.y, 1.);
  q = pivot + vec2(cos(a) * r.x - sin(a) * r.y, sin(a) * r.x + cos(a) * r.y) * vec2(size.y / size.x, 1.);
  float body = smoothstep(.45, .62, q.y);
  q.y -= breath * body * (q.y - 1.);
  q.x -= breath * .35 * body * (q.x - .5);
  vec2 dh = vec2(0.);
  for (int j = 0; j < 6; j++) if (hw[j] > .001) dh += hw[j] * (texture(head, cell(float(j), hgrid, q)).rg * 255. - 128.) / hscale;
  q -= dh / size;
  vec4 c = texture(chr, q);
  if (premul > .5) c.rgb /= max(c.a, .001);
  vec2 bpx = box.zw * size;
  vec2 f = (q - box.xy) / box.zw;
  if (all(greaterThan(f, vec2(0.))) && all(lessThan(f, vec2(1.)))) {
    vec4 F[8]; float m[8];
    vec2 D = vec2(0.);
    for (int k = 0; k < 8; k++) {
      if (fw[k] <= .001) continue;
      F[k] = fm[k] > .5 ? (texture(fflow, cell(fid[k], fgrid, f)) * 255. - 128.) / fscale : vec4(0.);
      m[k] = texture(fmask, cell(fid[k], fgrid, f)).r;
      D += fw[k] * m[k] * F[k].xy;
    }
    vec3 acc = vec3(0.); float A = 0.;
    for (int k = 0; k < 8; k++) {
      if (fw[k] <= .001) continue;
      float wk = fw[k] * m[k];
      if (wk < .002) continue;
      vec2 dk = fm[k] > .5 ? D - wk * F[k].xy + (1. - fw[k]) * m[k] * F[k].zw : vec2(0.);
      acc += wk * texture(face, cell(fid[k], fgrid, f - dk / bpx)).rgb;
      A += wk;
    }
    if (A > 1.) { acc /= A; A = 1.; }
    vec3 col = texture(face, cell(0., fgrid, f - D / bpx)).rgb * (1. - A) + acc;
    float edge = smoothstep(0., .06, min(min(f.x, f.y), min(1. - f.x, 1. - f.y)));
    c.rgb = mix(c.rgb, col, edge * c.a);
  }
  vec3 rgb = mix(texture(plate, uv + parallax).rgb, c.rgb, c.a);
  rgb *= 1. + light * exp(-pow(length((uv - vec2(.17, .41)) * vec2(1., .6)) / .35, 2.));
  float e = smoothstep(0., fade.x, v.y) * smoothstep(0., fade.y, 1. - v.y) * smoothstep(0., fade.z, v.x) * smoothstep(0., fade.z, 1. - v.x);
  o = vec4(rgb * e, e);
}`;

/** How much of the portrait a w x h view shows (it covers the view, zoomed by view.zoom) and where. */
export function framing(rig, w, h) {
  const [W, H] = rig.size, view = rig.view || {}, zoom = view.zoom || 1, [fx, fy] = view.focus || [.5, .4];
  let sx = 1, sy = (h * W) / (w * H);
  if (sy > 1) { sx = 1 / sy; sy = 1; }
  sx /= zoom; sy /= zoom;
  return { span: [sx, sy], center: [clamp(fx, sx / 2, 1 - sx / 2), clamp(fy, sy / 2, 1 - sy / 2)] };
}

/** Draws the character at `base` (a persona folder URL) into a canvas. now() gives {state, you, it}. Returns stop;
 *  with opts.dt it draws nothing by itself and returns a frame function for fixed-step recording instead. */
export async function illustration(canvas, base, now, opts = {}) {
  const rig = await (await fetch(base + "rig.json")).json();
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: !!opts.dt });
  if (!gl) throw new Error("no WebGL2");
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = {};
  const u = (n) => (U[n] ??= gl.getUniformLocation(prog, n));
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const files = [["plate.jpg", "plate"], ["char.png", "chr"], ["face.jpg", "face"], ["faceflow.png", "fflow"], ["facemask.jpg", "fmask"], ["head.png", "head"]];
  await Promise.all(files.map(async ([file, name], unit) => {
    const img = new Image();
    img.src = base + file;
    await img.decode();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    gl.uniform1i(u(name), unit);
  }));
  const [W, H] = rig.size, [bx, by, bw, bh] = rig.box;
  gl.uniform2f(u("size"), W, H);
  gl.uniform4f(u("box"), bx / W, by / H, bw / W, bh / H);
  gl.uniform2f(u("fgrid"), ...rig.face.grid);
  gl.uniform2f(u("hgrid"), ...rig.head.grid);
  gl.uniform1f(u("fscale"), rig.face.scale);
  gl.uniform1f(u("hscale"), rig.head.scale);
  gl.uniform2f(u("pivot"), ...(rig.pivot || [.55, .52]));
  gl.uniform2f(u("headc"), ...(rig.head_center || [.52, .35]));
  gl.uniform4f(u("fade"), ...(rig.view?.fade || [.001, .3, .001]), 0);
  gl.uniform1f(u("premul"), 0);
  const fidx = Object.fromEntries(rig.face.cells.map((n, i) => [n, i]));
  const hidx = Object.fromEntries(rig.head.cells.map((n, i) => [n, i]));
  const mind = new Mind();
  const fid = new Float32Array(8), fw = new Float32Array(8), fm = new Float32Array(8), hw = new Float32Array(6);
  const morphs = rig.face.morph || rig.face.cells.map(() => true);
  let last = performance.now(), raf, drew = false;
  const frame = (ms) => {
    if (!opts.dt) raf = requestAnimationFrame(frame);
    const dt = opts.dt || Math.min(.1, (ms - last) / 1000);
    last = ms;
    const k = Math.min(devicePixelRatio || 1, 2), w = opts.dt ? canvas.width : Math.round(canvas.clientWidth * k), h = opts.dt ? canvas.height : Math.round(canvas.clientHeight * k);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const { state, you, it, lo, hi } = now();
    const pose = (opts.pose || ((p) => p))(mind.step(dt, state, you, it, lo, hi));
    const active = Object.entries(pose.face).filter(([n, x]) => x > .004 && n in fidx).sort((a, b) => b[1] - a[1]).slice(0, 8);
    fid.fill(0); fw.fill(0); fm.fill(0);
    active.forEach(([n, x], i) => { fid[i] = fidx[n]; fw[i] = Math.min(1, x); fm[i] = morphs[fidx[n]] ? 1 : 0; });
    hw.fill(0);
    for (const [n, x] of Object.entries(pose.head)) if (n in hidx) hw[hidx[n]] = x;
    const view = framing(rig, w, h);
    gl.uniform1fv(u("fid"), fid);
    gl.uniform1fv(u("fw"), fw);
    gl.uniform1fv(u("fm"), fm);
    gl.uniform1fv(u("hw"), hw);
    gl.uniform2f(u("span"), ...view.span);
    gl.uniform2f(u("center"), ...view.center);
    gl.uniform2f(u("parallax"), ...pose.parallax);
    gl.uniform1f(u("roll"), pose.roll);
    gl.uniform1f(u("breath"), pose.breath);
    gl.uniform3f(u("torso"), ...(pose.torso || [0, 0, 0]));
    gl.uniform1f(u("light"), pose.light);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    opts.tick?.(pose);
    if (!drew) { drew = true; opts.first?.(); }
  };
  if (opts.dt) return frame;
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/** A footage character ("kind": "footage"): his face rendered offline as whole frames, driven by recorded human
 *  performances, in one video (footage.mp4) whose stretches are tagged by call state (footage.json). It keeps playing
 *  the stretch that fits the call; to change state, or before a stretch runs out, it waits for a precomputed jump to
 *  a frame that looks and moves alike, pre-seeks a second video there and cross-fades. */
export async function footage(canvas, base, now, opts = {}, failed) {
  const meta = await (await fetch(base + "footage.json")).json();
  const src = URL.createObjectURL(await (await fetch(base + "footage.mp4")).blob());
  const fps = meta.fps, segOf = new Int32Array(meta.frames);
  meta.segments.forEach((s, i) => segOf.fill(i, s.start, s.end + 1));
  const from = new Map();
  for (const [a, b, c] of meta.jumps) (from.get(a) || from.set(a, []).get(a)).push([b, c]);
  const has = new Set(meta.segments.map((s) => s.state));
  const video = () => Object.assign(document.createElement("video"), { src, muted: true, playsInline: true, preload: "auto" });
  let cur = video(), next = video();
  await Promise.all([cur, next].map((v) => new Promise((r) => (v.readyState >= 2 ? r() : v.addEventListener("loadeddata", r, { once: true })))));
  const first = meta.segments.find((s) => s.state === "listening") || meta.segments[0];
  cur.currentTime = (first.start + .5) / fps;
  await cur.play().catch(() => {});
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: !!opts.dt });
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D a, b;
uniform vec2 span, center;
uniform float mixb, fade;
void main() {
  vec2 uv = center + (v - .5) * span;
  vec3 c = mix(texture(a, uv).rgb, texture(b, uv).rgb, mixb);
  float e = smoothstep(0., fade, 1. - v.y);
  o = vec4(c * e, e);
}`]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pl = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(pl);
  gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const tex = [0, 1].map((i) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, w, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U(i ? "b" : "a"), i);
    return t;
  });
  gl.uniform1f(U("fade"), meta.view?.fade?.[1] ?? .3);
  const upload = (i, v) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); };
  let plan = null, fade = null, voiceAt = -9, jumpedAt = 0, raf, stateSince = performance.now(), lastWant = "", drew = false;
  const frame = (v) => Math.min(meta.frames - 1, Math.floor(v.currentTime * fps + .02));
  const want = (state, t) => {
    const w = state === "speaking" ? (t - voiceAt < .9 ? "speaking" : "listening") : state === "thinking" || state === "tool" ? (has.has(state) ? state : "thinking") : "listening";
    return has.has(w) ? w : "listening";
  };
  const choose = (fi, target, wide) => {
    let best = null;
    for (let a = fi + 3; a <= Math.min(fi + 12, meta.segments[segOf[fi]].end - 1); a++) {
      for (const [b, c] of from.get(a) || []) {
        const s = meta.segments[segOf[b]];
        if (s.state !== target || b > s.end - 40) continue;
        const cost = c + (a - fi) * .001;
        if (!best || cost < best.cost) best = { a, b, cost };
      }
    }
    return best;
  };
  const tick = (ms) => {
    raf = requestAnimationFrame(tick);
    const t = ms / 1000, k = Math.min(devicePixelRatio || 1, 2), W = Math.round(canvas.clientWidth * k), H = Math.round(canvas.clientHeight * k);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const { state, it } = now();
    if (it > .06) voiceAt = t;
    const target = want(state, t);
    if (target !== lastWant) { lastWant = target; stateSince = ms; plan = null; }
    const fi = frame(cur), seg = meta.segments[segOf[fi]];
    if (!fade && !plan && (fi > seg.end - 30 || seg.state !== target && ms - jumpedAt > 1200)) {
      plan = choose(fi, target, true);
      const waited = ms - stateSince, ending = fi > seg.end - 8;
      if (plan && plan.cost > .16 && waited < 4000 && !ending) plan = null;
      else if (plan && plan.cost > .16) plan.hard = true;
      if (plan) { next.currentTime = (plan.b + .5) / fps; next.pause(); }
    }
    if (!fade && fi >= seg.end - 1 && !cur.paused) cur.pause();
    if (plan && !fade && (fi >= plan.a || cur.paused) && !next.seeking && next.readyState >= 2) {
      next.play().catch(() => {});
      fade = { at: ms, len: plan.hard ? 250 : 160 };
      jumpedAt = ms;
      plan = null;
    }
    const view = framing({ size: meta.size, view: meta.view }, W, H);
    upload(0, cur);
    let x = 0;
    if (fade) {
      x = Math.min(1, (ms - fade.at) / fade.len);
      upload(1, next);
    }
    gl.useProgram(prog);
    gl.uniform2f(U("span"), ...view.span);
    gl.uniform2f(U("center"), ...view.center);
    gl.uniform1f(U("mixb"), x * x * (3 - 2 * x));
    gl.viewport(0, 0, W, H);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (fade && x >= 1) { cur.pause(); [cur, next] = [next, cur]; fade = null; }
    if (!drew && cur.currentTime > .3) {
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(W / 2), Math.floor(H * .65), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (px[3] === 0 || px[0] + px[1] + px[2] === 0) {
        cancelAnimationFrame(raf);
        cur.pause(); next.pause();
        return failed?.(new Error("video frames cannot be drawn here"));
      }
      drew = true;
      opts.first?.();
    }
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); cur.pause(); next.pause(); URL.revokeObjectURL(src); };
}

/** Draws whichever kind of character lives at `base`. A footage character that cannot draw video on this device
 *  (it checks its first frames) is replaced by its "fallback" folder, an illustration. */
export async function persona(canvas, base, now, opts = {}) {
  const spec = await (await fetch(base + "persona.json")).json();
  if (spec.kind !== "footage") return illustration(canvas, base, now, opts);
  let stop = () => {};
  const fallback = async (e) => {
    console.warn("persona: footage failed, using the illustration:", e?.message || e);
    stop();
    stop = await illustration(canvas, base + spec.fallback, now, opts);
  };
  try {
    stop = await footage(canvas, base, now, opts, spec.fallback && fallback);
  } catch (e) {
    if (!spec.fallback) throw e;
    await fallback(e);
  }
  return () => stop();
}
