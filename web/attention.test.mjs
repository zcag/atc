import test from "node:test";
import assert from "node:assert/strict";
import { attention, TICK } from "./attention.js";

const T0 = 1_700_000_000_000, on = { sessionId: "a" }, other = { sessionId: "b" };
const run = (a, from, to, f) => { for (let s = from; s <= to; s += TICK) a.tick(T0 + s * 1000, f(s)); };
const secs = (a) => Object.fromEntries(a.take(T0 + 600_000).map((e) => [e.sessionId, e.slots.length * TICK]));

test("counts a minute after the last input, then holds", () => {
  const a = attention();
  run(a, 0, 170, () => ({ on, here: true, input: T0 }));
  assert.deepEqual(secs(a), { a: 65 });
});

test("a pause counts once input returns within the bridge", () => {
  const a = attention();
  run(a, 0, 170, () => ({ on, here: true, input: T0 }));
  run(a, 175, 200, () => ({ on, here: true, input: T0 + 175_000 }));
  assert.deepEqual(secs(a), { a: 205 });
});

test("a longer pause counts its first minute only", () => {
  const a = attention();
  run(a, 0, 300, () => ({ on, here: true, input: T0 }));
  run(a, 305, 305, () => ({ on, here: true, input: T0 + 305_000 }));
  assert.deepEqual(secs(a), { a: 70 });
});

test("a pause belongs to the session that was open during it", () => {
  const a = attention();
  run(a, 0, 100, () => ({ on, here: true, input: T0 }));
  run(a, 105, 105, () => ({ on: other, here: true, input: T0 + 104_000 }));
  assert.deepEqual(secs(a), { a: 105, b: 5 });
});

test("leaving the page ends a pause, being away from it counts nothing", () => {
  const a = attention();
  run(a, 0, 100, () => ({ on, here: true, input: T0 }));
  a.left(T0 + 102_000, T0);
  run(a, 105, 200, () => ({ on, here: false, input: T0 }));
  assert.deepEqual(secs(a), { a: 105 });
});

test("a late tick fills the slot it skipped, a stalled page does not", () => {
  const a = attention();
  for (const s of [0, 5, 10.2, 19.9, 25, 80]) a.tick(T0 + s * 1000, { on, here: true, input: T0 + s * 1000 });
  assert.deepEqual(secs(a), { a: 35 });
});

test("what could not be sent goes out with the next one", () => {
  const a = attention();
  run(a, 0, 10, () => ({ on, here: true, input: T0 }));
  a.back(a.take(T0 + 10_000));
  assert.deepEqual(secs(a), { a: 15 });
});
