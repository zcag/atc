import test from "node:test";
import assert from "node:assert/strict";
import { glider } from "./glide.js";

const FRAME_MS = 1000 / 60;

function rig({ top = 5000, height = 20000, still = false } = {}) {
  const el = { scrollTop: top, scrollHeight: height, clientHeight: 800 };
  let queued = null, now = 0;
  const g = glider(el, { frame: (f) => { queued = f; }, still: () => still });
  const run = (ms) => {
    for (const end = now + ms; now < end && queued; now += FRAME_MS) {
      const f = queued;
      queued = null;
      f(now);
    }
  };
  return { el, g, run, moving: () => queued !== null };
}

test("a tap moves a few lines, then comes to rest", () => {
  const { el, g, run, moving } = rig();
  g.press(1, "KeyJ", false);
  g.release("KeyJ");
  run(2000);
  assert.ok(!moving());
  const moved = el.scrollTop - 5000;
  assert.ok(moved > 60 && moved < 160, `moved ${moved}`);
});

test("holding keeps a steady speed, and repeats do not change it", () => {
  const { el, g, run } = rig();
  g.press(1, "KeyJ", false);
  run(500);
  const a = el.scrollTop;
  g.press(1, "KeyJ", true);
  run(500);
  const b = el.scrollTop;
  run(500);
  assert.ok(Math.abs(b - a - (el.scrollTop - b)) < 20, `${b - a} vs ${el.scrollTop - b}`);
  assert.ok(b - a > 400 && b - a < 500, `${b - a}`);
});

test("k and up go up", () => {
  const { el, g, run } = rig();
  g.press(-1, "ArrowUp", false);
  run(300);
  assert.ok(el.scrollTop < 5000);
});

test("releasing a key that is no longer the held one does not stop the glide", () => {
  const { el, g, run } = rig();
  g.press(1, "KeyJ", false);
  run(200);
  g.press(-1, "KeyK", false);
  g.release("KeyJ");
  run(1000);
  assert.ok(el.scrollTop < 5000);
});

test("stops at both ends and never overshoots", () => {
  const top = rig({ top: 30 });
  top.g.press(-1, "KeyK", false);
  top.run(500);
  assert.equal(top.el.scrollTop, 0);
  top.g.release("KeyK");
  top.run(500);
  assert.ok(!top.moving());

  const end = rig({ top: 19190 });
  end.g.press(1, "KeyJ", false);
  end.run(500);
  assert.equal(end.el.scrollTop, 19200);
});

test("something else moving the page is followed, not undone", () => {
  const { el, g, run } = rig();
  g.press(1, "KeyJ", false);
  run(100);
  el.scrollTop = 9000;
  run(100);
  assert.ok(el.scrollTop >= 9000 && el.scrollTop < 9200, `${el.scrollTop}`);
});

test("stop ends it where it is", () => {
  const { el, g, run, moving } = rig();
  g.press(1, "KeyJ", false);
  run(200);
  g.stop();
  const at = el.scrollTop;
  run(200);
  assert.equal(el.scrollTop, at);
  assert.ok(!moving());
});

test("with reduced motion each press and repeat is one instant step", () => {
  const { el, g, moving } = rig({ still: true });
  g.press(1, "KeyJ", false);
  g.press(1, "KeyJ", true);
  assert.equal(el.scrollTop, 5200);
  assert.ok(!moving());
});
