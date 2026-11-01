import test from "node:test";
import assert from "node:assert/strict";
import { pose, Behaviour, Director, Swap } from "./rig.js";

const rig = {
  boneOrder: ["root", "head"],
  bones: { root: { o: [0, 0], p: {} }, head: { parent: "root", o: [10, 10], p: { yaw: [4, 0, 0, 0, 0], roll: [0, 0, 90, 0, 0] } } },
  angles: { y0p0: [0, 0], y8p0: [8, 0], "y-8p0": [-8, 0], y0p12: [0, 12] },
};
const apply = (m, o, [x, y]) => [m[o] * x + m[o + 2] * y + m[o + 4], m[o + 1] * x + m[o + 3] * y + m[o + 5]];

test("rest pose is the identity", () => {
  assert.deepEqual([...pose(rig, {}).slice(6, 12)].map((v) => v + 0), [1, 0, 0, 1, 0, 0]);
});

test("bones turn about their origin and translate by their parameters", () => {
  const [x, y] = apply(pose(rig, { roll: 1, yaw: 1 }), 6, [20, 10]);
  assert.ok(Math.abs(x - 14) < 1e-5 && Math.abs(y - 20) < 1e-5, `${x},${y}`);
});

test("a swap dissolves from the old drawing to the new one and keeps a drawing its hold time", () => {
  const s = new Swap();
  s.to("a1", .1);
  assert.deepEqual(s.layers(), [["base", 0], ["a1", 0]]);
  s.step(.05);
  assert.ok(s.layers()[1][1] > .3 && s.layers()[1][1] < .7);
  s.step(.06);
  assert.deepEqual(s.layers(), [["a1", 1]]);
  s.to("a2", .1, .5);
  assert.equal(s.cur, "a1");
  s.step(.5);
  s.to("base", .1);
  s.step(.05);
  assert.equal(s.layers().length, 1);
  assert.equal(s.layers()[0][0], "a1");
});

test("the director picks the nearest head angle, with hysteresis, and drawings by blink, gaze and voice", () => {
  const d = new Director(rig), base = { yaw: 0, pitch: 0, gazeX: 0, gazeY: 0, blinkR: 0, blinkL: 0, brow: 0, knit: 0, jaw: 0, round: 0, wide: 0 };
  const run = (p, n = 30) => { for (let i = 0; i < n; i++) d.step(1 / 30, { ...base, ...p }); };
  run({ yaw: -.5 });
  assert.equal(d.angle.cur, "y8p0");
  run({ yaw: -.32 });
  assert.equal(d.angle.cur, "y8p0", "stays put just past the midpoint");
  run({ yaw: .6 });
  assert.equal(d.angle.cur, "y-8p0");
  run({ blinkR: 1, blinkL: 1 }, 2);
  assert.equal(d.eyes.cur, "shut");
  run({ gazeX: .8, gazeY: .8 });
  assert.equal(d.eyes.cur, "g12_-10", "looking down is negative in the drawings");
  run({ jaw: .6, round: .6 });
  assert.equal(d.mouth.cur, "o2");
  run({ pose: "read", pitch: .95, gazeY: .9, gazeX: -.5 });
  assert.equal(d.angle.cur, "y0p12");
  assert.equal(d.eyes.cur, "r-12");
  assert.equal(d.pose.cur, "read");
  assert.equal(d.pose.k, 1);
});

test("a long call never yields a bad or runaway parameter, and blinks at a human rate", () => {
  const b = new Behaviour(), dt = 1 / 30, states = ["listening", "hearing", "thinking", "tool", "speaking"];
  let blinks = 0, closed = false, s = "listening";
  for (let i = 0; i < 30 * 600; i++) {
    if (i % 200 === 0) s = states[(i / 200) % states.length];
    const t = i * dt, it = s === "speaking" ? Math.abs(Math.sin(t * 9)) * .8 : 0;
    const p = b.step(dt, s, s === "hearing" ? .5 : 0, it, it * .8, it * .1);
    for (const [k, v] of Object.entries(p)) {
      if (k === "pose") continue;
      assert.ok(Number.isFinite(v), `${k} not finite at ${i}`);
      assert.ok(Math.abs(v) <= 1.6, `${k} = ${v} at ${i}`);
    }
    if (p.blinkR > .95 && !closed) blinks++;
    closed = p.blinkR > .95;
  }
  assert.ok(blinks > 600 / 7 && blinks < 600 / 1.5, `${blinks} blinks in 10 minutes`);
});

test("thinking and tool use bring their poses, the others none", () => {
  const seen = { thinking: new Set(), tool: new Set(), speaking: new Set() };
  for (let n = 0; n < 40; n++) for (const s of Object.keys(seen)) {
    const b = new Behaviour();
    b.step(1 / 30, "listening", 0, 0, 0, 0);
    seen[s].add(b.step(1 / 30, s, 0, 0, 0, 0).pose);
  }
  assert.deepEqual([...seen.speaking], [null]);
  assert.ok(seen.thinking.has("think"));
  assert.ok(seen.tool.has("read") && seen.tool.has("write") && !seen.tool.has(null));
});
