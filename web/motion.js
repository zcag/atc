// Motion helpers shared by the call characters: easing, springs, eye-like jumps, short gestures, slow noise.

export const PI = Math.PI;
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const chance = (p) => Math.random() < p;
export const pick = (list) => { let r = Math.random() * list.reduce((a, [, w]) => a + w, 0); for (const [n, w] of list) if ((r -= w) <= 0) return n; return list[0][0]; };

/** Critically damped follower: x reaches its target smoothly in about 1/hz seconds. */
export class Spring {
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
export class Saccade {
  constructor() { this.from = 0; this.to = 0; this.t = 1; this.dur = .1; this.x = 0; }
  go(to, dur) { this.from = this.x; this.to = to; this.t = 0; this.dur = dur; }
  step(dt) {
    this.t = Math.min(1, this.t + dt / this.dur);
    const s = this.t, k = s * s * s * (10 - 15 * s + 6 * s * s);
    return (this.x = lerp(this.from, this.to, k));
  }
}

/** Short gestures that rise and fall back: a nod, a brow flash, an "mm". hit(amount, rise, fall) adds one. */
export class Pulses {
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
export class Drawing {
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
export const wander = (t, seed) => (Math.sin(t * .23 + seed) + Math.sin(t * .37 + seed * 2.1) * .7 + Math.sin(t * .61 + seed * 3.7) * .4) / 2.1;
