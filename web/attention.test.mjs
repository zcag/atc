import test from "node:test";
import assert from "node:assert/strict";
import { attention, TICK } from "./attention.js";

const T0 = 1_700_000_000_000, on = { sessionId: "a" }, other = { sessionId: "b" };
const run = (a, from, to, f) => { for (let s = from; s <= to; s += TICK) a.tick(T0 + s * 1000, f(s)); };
const secs = (a) => Object.fromEntries(a.take(T0 + 600_000).map((e) => [e.sessionId, e.slots.length * TICK]));

test("counts 30 seconds after the last input and nothing after it, even when input returns", () => {
  const a = attention();
  run(a, 0, 170, () => ({ on, here: true, input: T0 }));
  run(a, 175, 180, () => ({ on, here: true, input: T0 + 175_000 }));
  assert.deepEqual(secs(a), { a: 45 });
});

test("time goes to what is open, and nothing while the page is away", () => {
  const a = attention();
  run(a, 0, 20, () => ({ on, here: true, input: T0 }));
  run(a, 25, 40, () => ({ on: other, here: true, input: T0 + 25_000 }));
  run(a, 45, 60, () => ({ on, here: false, input: T0 + 45_000 }));
  assert.deepEqual(secs(a), { a: 25, b: 20 });
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
