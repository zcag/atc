import test from "node:test";
import assert from "node:assert/strict";
import { roomLook, lookFromPixels, Mood, MOODS, flicker, Particles } from "./room.js";

test("a room with nothing written gets a whole look, and what it writes wins", () => {
  const plain = roomLook();
  assert.equal(plain.dim, .62);
  assert.deepEqual(plain.character.tint, [1, 1, 1]);
  assert.equal(plain.moods.thinking.exposure, MOODS.thinking.exposure);
  const room = roomLook({ dim: .9, light: { strength: .4 }, moods: { thinking: { exposure: .5 } } }, { dim: .3, light: { wrap: .6, strength: .1 } });
  assert.equal(room.dim, .9);
  assert.equal(room.light.strength, .4);
  assert.equal(room.light.wrap, .6, "what the picture suggests fills what the room leaves out");
  assert.equal(room.moods.thinking.exposure, .5);
  assert.equal(room.moods.speaking.exposure, MOODS.speaking.exposure);
});

test("a picture's look follows its colour and its brighter side, within limits", () => {
  const px = (l, r) => { const d = []; for (let i = 0; i < 16; i++) d.push(...(i % 2 ? r : l), 255); return Uint8Array.from(d); };
  const cold = lookFromPixels(px([60, 90, 200], [60, 90, 200]), 2);
  assert.ok(cold.character.tint[2] > 1 && cold.character.tint[0] < 1, `${cold.character.tint}`);
  const bright = lookFromPixels(px([240, 240, 240], [240, 240, 240]), 2), dark = lookFromPixels(px([10, 10, 10], [10, 10, 10]), 2);
  assert.ok(bright.character.exposure > dark.character.exposure);
  assert.ok(bright.dim > dark.dim, "a daylit picture stays bright, a lamp-lit one goes back");
  assert.ok(bright.vignette < dark.vignette);
  const lit = lookFromPixels(px([250, 250, 250], [30, 30, 30]), 2);
  assert.ok(lit.light.left[0] > lit.light.right[0]);
  for (const v of [...lit.light.left, ...lit.light.right, ...bright.character.tint]) assert.ok(v > .8 && v < 1.2, `${v}`);
});

test("moods ease over about a second and come back", () => {
  const m = new Mood(MOODS);
  m.step(1 / 60, "thinking");
  assert.ok(m.exposure > .99, "no jump");
  for (let i = 0; i < 240; i++) m.step(1 / 60, "thinking");
  assert.ok(Math.abs(m.exposure - MOODS.thinking.exposure) < .001);
  for (let i = 0; i < 240; i++) m.step(1 / 60, "listening");
  assert.ok(Math.abs(m.exposure - 1) < .001 && Math.abs(m.warm) < .001);
});

test("lights stay near their level", () => {
  for (const kind of ["lamp", "fire", "neon", "sun", "steady"]) for (let t = 0; t < 200; t += .017) {
    const v = flicker(kind, t, 3);
    assert.ok(v > .3 && v <= 1.05, `${kind} ${v} at ${t}`);
  }
});

test("every kind of particle stays in its box and keeps moving the right way", () => {
  for (const [kind, down] of [["rain", true], ["snow", true], ["dust", false], ["ember", false]]) {
    const p = new Particles({ kind, box: [.5, .1, .4, .4], n: 30 }, [1000, 2000]);
    const [x, y, w, h] = p.box, start = p.list[0].y;
    p.list[0].y = y + h / 2;
    const before = p.list[0].y;
    p.step(1 / 60, 0);
    assert.equal(p.list[0].y > before, down, kind);
    for (let i = 0; i < 3000; i++) p.step(1 / 60, i / 60);
    for (const d of p.list) assert.ok(d.y >= y - 30 && d.y <= y + h + 30, `${kind} y ${d.y}`);
    const out = p.fill(new Float32Array(120), 1);
    for (const v of out) assert.ok(Number.isFinite(v));
    assert.ok(start >= y);
  }
});
