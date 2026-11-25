import test from "node:test";
import assert from "node:assert/strict";
import { timeCube, costs, againstSpend, dayKey } from "./time-cube.js";

const at = (h, m = 0) => Math.floor(new Date(2026, 10, 20, h, m).getTime() / 5000);
const S = [
  { sessionId: "a", bay: "shop", profile: "work", days: { "2026-11-19": 600, "2026-11-20": 1200 }, before: 60 },
  { sessionId: "b", bay: "app", profile: "home", days: { "2026-11-20": 300 }, before: 0 },
  { sessionId: "screen:board", bay: "outside sessions", screen: true, days: { "2026-11-20": 30 } },
];
const R = [
  { s: "a", d: "desk", t: at(10), n: 120 },
  { s: "screen:board", d: "desk", t: at(10, 10), n: 6 },
  { s: "b", d: "phone", t: at(10, 11), n: 60 },
  { s: "a", d: "desk", t: at(11, 55), n: 120 },
];

test("everything adds up, and a screen counts outside the accounts", () => {
  const c = timeCube(S, R);
  assert.equal(c.total, 2130);
  assert.equal(c.before, 60);
  assert.deepEqual(c.bays.map((b) => [b.name, b.cost]), [["shop", 1800], ["app", 300], ["outside sessions", 30]]);
  assert.deepEqual(c.buckets["2026-11-20"].models, { shop: 1200, app: 300, "outside sessions": 30 });
  assert.deepEqual(c.devices.map((d) => [d.name, d.cost]), [["desk", 1230], ["phone", 300]]);
});

test("an account leaves the rest out, a picked bay still lists every bay", () => {
  assert.equal(timeCube(S, R, { profile: "work" }).total, 1800);
  const c = timeCube(S, R, { bay: "app" });
  assert.equal(c.total, 300);
  assert.equal(c.bays.length, 3);
});

test("a picked day narrows everything but the bars", () => {
  const c = timeCube(S, R, { bucket: "2026-11-19" });
  assert.equal(c.total, 600);
  assert.equal(c.runs.length, 0);
  assert.equal(c.buckets["2026-11-20"].cost, 1530);
});

test("stretches break on five quiet minutes, switches skip screens", () => {
  const c = timeCube(S, R);
  assert.equal(c.stretches.length, 2);
  assert.equal(c.longest.secs, 930);
  assert.equal(c.switches, 1);
});

test("hours split a run that crosses one", () => {
  const h = timeCube(S, R).hours[dayKey(new Date(2026, 10, 20, 12).getTime())];
  assert.equal(h[10], 930);
  assert.equal(h[11], 300);
  assert.equal(h[12], 300);
});

test("spend of the sessions you opened, and of those you did not", () => {
  const rep = { sessions: [{ sessionId: "a", slices: { "2026-11-19": { m: [1, 2, 3, 4, 9, 9] } } }, { sessionId: "z", slices: { "2026-11-20": { m: [5, 0, 0, 0, 1, 1] } } }] };
  const spend = costs({ work: rep, home: null });
  const x = againstSpend(timeCube(S, R).rows, spend);
  assert.deepEqual([x.opened, x.rest, x.unopened], [10, 5, 1]);
  assert.equal(againstSpend([], spend, "2026-11-19").rest, 10);
  assert.deepEqual(costs({ work: rep }, "home"), {});
});
