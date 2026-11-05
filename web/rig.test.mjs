import test from "node:test";
import assert from "node:assert/strict";
import { pose, Behaviour, Director, Swap, daylight } from "./rig.js";

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
  run({ smile: .9 });
  assert.equal(d.mouth.cur, "s2", "a broad smile when not speaking");
  run({ smile: .9, jaw: .5 }, 2);
  assert.equal(d.mouth.cur, "a2", "speech takes the mouth back at once");
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

const run = (b, s, seconds, dt = 1 / 30) => { let p; for (let i = 0; i < seconds / dt; i++) p = b.step(dt, s, 0, 0, 0, 0); return p; };

test("a rendered drawing that doesn't exist at this angle is never asked for", () => {
  const angles = { y0p0: [0, 0], y0p12: [0, 12] };
  const d = new Director({ ...rig, angles, parts: [{ name: "y0p12.eyes.r0" }, { name: "y0p12.eyes.r-12" }, { name: "y0p0.eyes.g0_-10" }] });
  const base = { yaw: 0, pitch: 0, gazeX: 0, gazeY: .9, blinkR: 0, blinkL: 0, brow: 0, knit: 0, jaw: 0, round: 0, wide: 0, pose: "read" };
  for (let i = 0; i < 30; i++) d.step(1 / 30, base);
  assert.equal(d.angle.cur, "y0p0");
  assert.equal(d.eyes.cur, "g0_-10");
  for (let i = 0; i < 30; i++) d.step(1 / 30, { ...base, pitch: 1 });
  assert.equal(d.angle.cur, "y0p12");
  assert.equal(d.eyes.cur, "r0");
});

test("a prop stays through the gap between two tools and goes when speech starts", () => {
  for (let n = 0; n < 20; n++) {
    const b = new Behaviour();
    const prop = run(b, "tool", 1).pose;
    assert.equal(run(b, "thinking", 2).pose, prop);
    assert.equal(run(b, "tool", 1).pose, prop);
    assert.equal(run(b, "speaking", .1).pose, null);
  }
});

test("a pause between sentences changes nothing, and thinking raises its hand only after a moment", () => {
  for (let n = 0; n < 20; n++) {
    const b = new Behaviour();
    run(b, "speaking", 1);
    run(b, "thinking", .3);
    assert.equal(b.state, "speaking");
    assert.equal(run(b, "speaking", .1).pose, null);
    assert.equal(run(b, "thinking", .7).pose, null);
  }
});

test("reading doesn't make the eyes flutter", () => {
  const b = new Behaviour(), dt = 1 / 60;
  let blinks = 0, closed = false;
  b.step(dt, "tool", 0, 0, 0, 0);
  for (let i = 0; i < 120 / dt; i++) {
    const p = b.step(dt, "tool", 0, 0, 0, 0);
    if (p.blinkR > .9 && !closed) blinks++;
    closed = p.blinkR > .9;
  }
  assert.ok(blinks < 60, `${blinks} blinks in 2 minutes of reading`);
});

test("the mouth follows a voice's own range: as open at half the loudness, closed in its dips", () => {
  const share = (gain) => {
    const b = new Behaviour(), d = new Director(rig), dt = 1 / 60, use = {};
    for (let i = 0; i < 60 / dt; i++) {
      const t = i * dt, it = gain * (.5 + .5 * Math.sin(t * 9)) ** 2;
      d.step(dt, b.step(dt, "speaking", 0, it, it * .8, it * .08));
      if (t > 10) use[d.mouth.cur] = (use[d.mouth.cur] || 0) + 1;
    }
    return use;
  };
  const loud = share(.8), quiet = share(.4), count = 50 * 60;
  for (const u of [loud, quiet]) {
    assert.ok((u.base || 0) / count > .1, `closed too rarely ${JSON.stringify(u)}`);
    assert.ok((u.a3 || 0) / count < .35, `wide open too often ${JSON.stringify(u)}`);
  }
  assert.ok(Math.abs((loud.a3 || 0) - (quiet.a3 || 0)) / count < .1, `${JSON.stringify(loud)} ${JSON.stringify(quiet)}`);
});

test("thinking and tool use bring their poses, the others none", () => {
  const seen = { thinking: new Set(), tool: new Set(), speaking: new Set() };
  for (let n = 0; n < 40; n++) for (const s of Object.keys(seen)) {
    const b = new Behaviour();
    b.step(1 / 30, "listening", 0, 0, 0, 0);
    seen[s].add(run(b, s, 1).pose);
  }
  assert.deepEqual([...seen.speaking], [null]);
  const b = new Behaviour(), poses = new Set();
  for (let i = 0; i < 30 * 120; i++) {
    const t = i / 30, it = (t % 3) < 2.2 ? Math.abs(Math.sin(t * 9)) * .8 : 0;
    poses.add(b.step(1 / 30, "speaking", 0, it, it * .8, it * .1).pose);
  }
  assert.ok(poses.has("explain"), "speaking gestures now and then");
  assert.ok(seen.thinking.has("think"));
  assert.ok(seen.tool.has("read") && seen.tool.has("write") && !seen.tool.has(null));
});

test("a character's manner moves more and gestures more, stays in range, and leaves the default alone", () => {
  const run = (manner) => {
    const b = new Behaviour(manner), dt = 1 / 30;
    let turn = 0, gesture = 0, last = null;
    for (let i = 0; i < 18000; i++) {
      const t = i * dt, it = .2 + .2 * Math.sin(t * 9) * (Math.sin(t * 1.3) > -.6);
      const p = b.step(dt, t % 40 < 30 ? "speaking" : "listening", 0, it, .2, .1);
      for (const k of ["yaw", "pitch", "roll", "brow", "smile", "gazeX", "gazeY"]) assert.ok(Number.isFinite(p[k]) && Math.abs(p[k]) < 2.5, `${k} ${p[k]}`);
      turn += Math.abs(p.yaw) * dt;
      if (p.pose === "explain" && last !== "explain") gesture++;
      last = p.pose;
    }
    return { turn, gesture };
  };
  const random = Math.random;
  let seed = 1;
  Math.random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const runs = (manner) => {
    const all = Array.from({ length: 6 }, () => run(manner));
    return { turn: all.reduce((n, r) => n + r.turn, 0), gesture: all.reduce((n, r) => n + r.gesture, 0) };
  };
  const plain = runs(), lively = runs({ head: 1.5, glance: 1.5, brow: 1.5, nod: 1.2, tilt: 1.5, gesture: 2.2, smile: .08, sheepish: .5 });
  Math.random = random;
  assert.ok(lively.turn > plain.turn * 1.2, `turn ${lively.turn} against ${plain.turn}`);
  assert.ok(lively.gesture > plain.gesture, `gestures ${lively.gesture} against ${plain.gesture}`);
  assert.deepEqual(new Behaviour().m, new Behaviour({}).m);
});

test("a lamp-lit room counts as none, a sunny one as full daylight", () => {
  assert.equal(daylight(.15), 0);
  assert.equal(daylight(.3), 0);
  assert.equal(daylight(.7), 1);
  assert.ok(daylight(.45) > 0 && daylight(.45) < 1);
});
