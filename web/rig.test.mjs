import test from "node:test";
import assert from "node:assert/strict";
import { pose, Behaviour } from "./rig.js";

const rig = {
  boneOrder: ["root", "head"],
  bones: { root: { o: [0, 0], p: {} }, head: { parent: "root", o: [10, 10], p: { yaw: [4, 0, 0, 0, 0], roll: [0, 0, 90, 0, 0] } } },
  featureOrder: ["jaw"],
  features: { jaw: { o: [0, 0], p: { jaw: [0, 5, 0, 0, 0] } } },
};
const apply = (m, o, [x, y]) => [m[o] * x + m[o + 2] * y + m[o + 4], m[o + 1] * x + m[o + 3] * y + m[o + 5]];

test("rest pose is the identity and deformers are zero", () => {
  const { B, F } = pose(rig, {});
  assert.deepEqual([...B.slice(6, 12)].map((v) => v + 0), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([...F.slice(0, 6)].map((v) => v + 0), [0, 0, 0, 0, 0, 0]);
});

test("bones turn about their origin and translate by their parameters", () => {
  const { B } = pose(rig, { roll: 1, yaw: 1 });
  const [x, y] = apply(B, 6, [20, 10]);
  assert.ok(Math.abs(x - 14) < 1e-5 && Math.abs(y - 20) < 1e-5, `${x},${y}`);
});

test("deformers store their displacement", () => {
  const { F } = pose(rig, { jaw: .5 });
  assert.deepEqual(apply(F, 0, [3, 4]).map((v) => +v.toFixed(5)), [0, 2.5]);
});

test("a long call never yields a bad or runaway parameter, and blinks at a human rate", () => {
  const b = new Behaviour(), dt = 1 / 30, states = ["listening", "hearing", "thinking", "tool", "speaking"];
  let blinks = 0, closed = false, s = "listening";
  for (let i = 0; i < 30 * 600; i++) {
    if (i % 200 === 0) s = states[(i / 200) % states.length];
    const t = i * dt, it = s === "speaking" ? Math.abs(Math.sin(t * 9)) * .8 : 0;
    const p = b.step(dt, s, s === "hearing" ? .5 : 0, it, it * .8, it * .1);
    for (const [k, v] of Object.entries(p)) {
      assert.ok(Number.isFinite(v), `${k} not finite at ${i}`);
      assert.ok(Math.abs(v) <= 1.6, `${k} = ${v} at ${i}`);
    }
    if (p.blinkR > .95 && !closed) blinks++;
    closed = p.blinkR > .95;
  }
  assert.ok(blinks > 600 / 7 && blinks < 600 / 1.5, `${blinks} blinks in 10 minutes`);
});

test("a frame after a long pause does not jump", () => {
  const b = new Behaviour();
  for (let i = 0; i < 90; i++) b.step(1 / 30, "listening", 0, 0, 0, 0);
  const a = b.step(1 / 30, "listening", 0, 0, 0, 0), c = b.step(.1, "listening", 0, 0, 0, 0);
  for (const k of ["yaw", "pitch", "roll", "sway"]) assert.ok(Math.abs(a[k] - c[k]) < .1, k);
});
