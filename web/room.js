// A room is everything around a character: a picture, the light it throws on them, its colour grade, glows and sun
// shafts, particles (dust, rain, snow, embers) and how it shifts with the call's state. It lives beside its picture in
// personas/_rooms, as <name>.json next to <name>.jpg. A picture with no such file still works: its look is worked out
// from the picture. Positions are 0..1 of the picture. See docs/persona-rig.md.

import { clamp, lerp, rand, smooth } from "./motion.js";

const WHITE = [1, 1, 1];

/** How far a room's mean brightness (0 to 1) says it is daylit: 0 is a lamp-lit room, 1 a sunny one. */
export const daylight = (mean) => smooth(.3, .6, mean);

/** How a room shifts with the call: a little dimmer and softer while thinking, a little warmer while speaking. */
export const MOODS = {
  listening: {},
  hearing: { exposure: 1.02 },
  thinking: { exposure: .94, warm: -.018, blur: .5, glow: .9 },
  tool: { exposure: .96, warm: -.01, glow: .95 },
  speaking: { exposure: 1.03, warm: .012, glow: 1.06 },
};

/** A room's settings with every default filled in. `seen` is what the picture itself suggests, for a room with no file. */
export function roomLook(spec = {}, seen = {}) {
  const light = { from: [.1, .35], reach: .75, color: WHITE, strength: 0, wrap: .14, wrapColor: [1, .8, .6], shadow: .22, left: WHITE, right: WHITE, flicker: null, ...seen.light, ...spec.light };
  return {
    title: spec.title || "",
    dim: spec.dim ?? seen.dim ?? .62,
    blur: spec.blur ?? seen.blur ?? 2.5,
    parallax: spec.parallax ?? .9,
    vignette: spec.vignette ?? seen.vignette ?? 1,
    light,
    character: { tint: WHITE, contrast: 1, saturation: 1, exposure: 1, ...seen.character, ...spec.character },
    picture: { tint: WHITE, contrast: 1, saturation: 1, exposure: 1, ...spec.picture },
    glows: spec.glows || [],
    shafts: spec.shafts || [],
    particles: spec.particles || [],
    moods: { ...MOODS, ...spec.moods },
  };
}

/** What a picture suggests when nobody wrote its room: from its pixels (RGBA, any size), the character takes a little of
 *  its colour and brightness, and the light from whichever side is brighter. A lamp-lit room goes well back, to 62%; a
 *  daylit one stays bright, or a sunny office turns to dusk, and its vignette eases off. */
export function lookFromPixels(data, width) {
  let n = 0, left = [0, 0, 0], right = [0, 0, 0], lefts = 0, rights = 0;
  for (let i = 0; i < data.length; i += 4) {
    const side = (i / 4) % width < width / 2 ? left : right;
    for (let c = 0; c < 3; c++) side[c] += data[i + c] / 255;
    if (side === left) lefts++; else rights++;
    n++;
  }
  left = left.map((v) => v / Math.max(1, lefts));
  right = right.map((v) => v / Math.max(1, rights));
  const mean = left.map((v, i) => (v + right[i]) / 2), L = Math.max(.02, luminance(mean)), day = daylight(L);
  const hue = mean.map((v) => clamp(v / L, .6, 1.5));
  const side = (s) => hue.map((_, i) => clamp(1 + .25 * (s[i] / Math.max(.02, mean[i]) - 1), .88, 1.12));
  return {
    dim: lerp(.62, .96, day),
    blur: 2.5,
    vignette: 1 - .8 * day,
    character: { tint: hue.map((v) => lerp(1, v, .16)), exposure: lerp(.94, 1.03, day) },
    light: { wrap: .14, wrapColor: mean.map((v) => clamp(v * 1.5)), shadow: lerp(.16, .22, day), left: side(left), right: side(right) },
  };
}

/** How bright a picture's pixels are on average, 0 to 1. */
export function brightness(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += luminance([data[i], data[i + 1], data[i + 2]]);
  return sum / (data.length / 4) / 255;
}

const luminance = (c) => .2126 * c[0] + .7152 * c[1] + .0722 * c[2];

/** Eases the room's shifts between call states, about a second each way. */
export class Mood {
  constructor(moods) { this.moods = moods; this.exposure = 1; this.warm = 0; this.blur = 0; this.glow = 1; }
  step(dt, state) {
    const m = this.moods[state] || {}, k = 1 - Math.exp(-dt / .45);
    this.exposure = lerp(this.exposure, m.exposure ?? 1, k);
    this.warm = lerp(this.warm, m.warm ?? 0, k);
    this.blur = lerp(this.blur, m.blur ?? 0, k);
    this.glow = lerp(this.glow, m.glow ?? 1, k);
    return this;
  }
}

/** A light's brightness now, near 1: a lamp's slow breathing, a fire's flutter, neon's rare dropout, sun through cloud. */
export function flicker(kind, t, seed = 0) {
  if (kind === "fire") return .8 + .11 * Math.sin(7 * t + seed) + .06 * Math.sin(13.1 * t + seed * 2) + .03 * Math.sin(23 * t + seed * 3);
  if (kind === "neon") return Math.sin(t * .7 + seed) > .985 ? .35 : .96 + .03 * Math.sin(41 * t);
  if (kind === "sun") return .93 + .07 * Math.sin(.35 * t + seed);
  if (kind === "steady") return 1;
  return .9 + .06 * Math.sin(1.3 * t + seed) + .04 * Math.sin(3.7 * t + 1 + seed);
}

/** Particles in a box of the picture, one kind each, moving in art pixels. fill() writes [x, y, size, alpha] per particle. */
export class Particles {
  constructor(set, size) {
    const [W, H] = size, [x, y, w, h] = set.box || [0, 0, 1, 1];
    this.kind = set.kind || "dust";
    this.layer = set.layer || (this.kind === "rain" ? "back" : "front");
    this.color = (set.color || [255, 196, 140]).map((c) => c / 255);
    this.box = set.px || [x * W, y * H, w * W, h * H];
    this.sizes = set.size || { dust: [2.5, 7], rain: [10, 26], snow: [4, 11], ember: [3, 7] }[this.kind] || [3, 7];
    this.strength = set.strength ?? 1;
    this.streak = this.kind === "rain" ? 9 : 0;
    this.speed = set.speed ?? 1;
    this.list = Array.from({ length: set.n || 40 }, () => this.spawn({}, true));
  }

  spawn(d, anywhere) {
    const [x, y, w, h] = this.box, s = this.speed;
    const start = { dust: y + h, rain: y, snow: y, ember: y + h }[this.kind] ?? y;
    const v = { dust: [rand(-4, 4), rand(-9, -3)], rain: [rand(-18, -10), rand(520, 760)], snow: [rand(-14, 14), rand(26, 60)], ember: [rand(-16, 16), rand(-120, -55)] }[this.kind] || [0, 0];
    const a = { dust: rand(.15, .55), rain: rand(.08, .24), snow: rand(.3, .8), ember: rand(.5, 1) }[this.kind] ?? .5;
    return Object.assign(d, { x: x + rand(0, w), y: anywhere ? y + rand(0, h) : start, vx: v[0] * s, vy: v[1] * s, s: rand(...this.sizes), a, ph: rand(0, 9), life: anywhere ? rand(2, 9) : 0 });
  }

  step(dt, clock) {
    const [, y, , h] = this.box, sway = { dust: 3, snow: 18, ember: 22 }[this.kind] || 0;
    for (const d of this.list) {
      d.life += dt;
      d.x += (d.vx + sway * Math.sin(clock * .7 + d.ph)) * dt;
      d.y += d.vy * dt;
      const limit = this.kind === "ember" ? 6 : 40;
      if (d.y < y || d.y > y + h || d.life > limit) this.spawn(d, false);
    }
  }

  fill(out, clock) {
    const [, y, , h] = this.box;
    this.list.forEach((d, i) => {
      const fade = this.kind === "ember" ? clamp(1 - (y + h - d.y) / h) * clamp(d.life * 3) * (.7 + .3 * Math.sin(clock * 9 + d.ph)) : this.kind === "rain" ? 1 : clamp(d.life / 2) * (.6 + .4 * Math.sin(clock * 1.5 + d.ph));
      out.set([d.x, d.y, d.s, d.a * fade * this.strength], i * 4);
    });
    return out;
  }
}
