import test from "node:test";
import assert from "node:assert/strict";
import { cube, niceMax } from "./usage-cube.js";

const o = "claude-opus-5-5", h = "claude-haiku-5-5";
const S = [
  { sessionId: "a", bay: "atc", host: "desktop", slices: { d1: { [o]: [1, 2, 3, 4, 10, 100], [h]: [1, 0, 0, 0, 1, 5] }, d2: { [o]: [0, 5, 0, 0, 2, 20] } } },
  { sessionId: "b", bay: "shop", host: "laptop", slices: { d2: { [h]: [0, 0, 0, 3, 4, 40] } } },
];

test("no selection adds up the whole range", () => {
  const c = cube(S);
  assert.equal(c.total, 19);
  assert.equal(c.range, 19);
  assert.deepEqual(c.kinds, [2, 7, 3, 7]);
  assert.equal(c.msgs, 17);
  assert.equal(c.tokens, 165);
  assert.deepEqual(c.rows.map((r) => [r.sessionId, r.cost, r.model]), [["a", 16, o], ["b", 3, h]]);
  assert.equal(c.buckets.d2.sessions, 2);
  assert.deepEqual(c.buckets.d1.models, { [o]: 10, [h]: 1 });
});

test("a picked day narrows everything but the bars", () => {
  const c = cube(S, { bucket: "d2" });
  assert.equal(c.total, 8);
  assert.equal(c.range, 19);
  assert.deepEqual(c.rows.map((r) => [r.sessionId, r.cost]), [["a", 5], ["b", 3]]);
  assert.equal(c.buckets.d1.cost, 11);
  assert.deepEqual(c.bays.map((b) => [b.name, b.cost, b.sessions]), [["atc", 5, 1], ["shop", 3, 1]]);
  assert.deepEqual(c.models.map((m) => [m.name, m.cost]), [[o, 5], [h, 3]]);
});

test("a picked bay narrows the rest but still lists the other bays", () => {
  const c = cube(S, { bay: "shop" });
  assert.equal(c.total, 3);
  assert.deepEqual(Object.keys(c.buckets), ["d2"]);
  assert.deepEqual(c.bays.map((b) => b.name), ["atc", "shop"]);
  assert.deepEqual(c.hosts.map((x) => x.name), ["laptop"]);
});

test("selections combine, and a row reports its biggest model inside the slice", () => {
  const c = cube(S, { bucket: "d1", model: h });
  assert.equal(c.total, 1);
  assert.deepEqual(c.rows.map((r) => [r.sessionId, r.cost, r.model, r.msgs]), [["a", 1, h, 1]]);
  assert.deepEqual(cube(S, { bucket: "d1", bay: "shop" }).rows, []);
});

test("niceMax rounds up to a readable axis top", () => {
  assert.equal(niceMax(468), 500);
  assert.equal(niceMax(120), 200);
  assert.equal(niceMax(0), 1);
});
