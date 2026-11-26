import test from "node:test";
import assert from "node:assert/strict";
import { age, clock, stamp, duration, at, day, date } from "./when.js";

const NOW = new Date(2026, 10, 26, 15, 0).getTime();
const ago = (s) => NOW - s * 1000;

test("age", () => {
  assert.deepEqual([12, 50, 260, 3 * 3600 + 3000, 50 * 3600, 13 * 86400, 14 * 86400, 36 * 86400, 400 * 86400, -60].map((s) => age(ago(s), NOW)),
    ["now", "1m", "4m", "3h", "2d", "13d", "2w", "5w", "57w", "now"]);
  assert.equal(age(0, NOW), "");
  assert.equal(age(new Date(NOW).toISOString(), NOW), "now");
});

test("clock is 24 hour", () => {
  assert.equal(clock(new Date(2026, 10, 26, 9, 7)), "09:07");
  assert.equal(clock(new Date(2026, 10, 26, 23, 58, 4), true), "23:58:04");
});

test("stamp: weekday inside a week, date this year, year before", () => {
  assert.equal(stamp(new Date(2026, 10, 26, 9, 7), NOW), "Thu 09:07");
  assert.equal(stamp(new Date(2026, 10, 24, 14, 5), NOW), "Tue 14:05");
  assert.equal(stamp(new Date(2026, 10, 3, 14, 5), NOW), "3 Nov 14:05");
  assert.equal(stamp(new Date(2025, 10, 3, 14, 5), NOW), "3 Nov 2025 14:05");
  assert.equal(stamp(new Date(2026, 10, 29, 9, 0), NOW), "Sun 09:00");
});

test("at is the clock today and a stamp otherwise", () => {
  assert.equal(at(new Date(2026, 10, 26, 0, 5), NOW), "00:05");
  assert.equal(at(new Date(2026, 10, 25, 23, 55), NOW), "Wed 23:55");
});

test("day and date", () => {
  assert.equal(day(new Date(2026, 10, 3), NOW), "Tue 3 Nov");
  assert.equal(date(new Date(2025, 0, 2), NOW), "2 Jan 2025");
});

test("duration", () => {
  assert.deepEqual([45, 245, 3 * 3600 + 300, 2 * 86400 + 4 * 3600 + 59, -3].map(duration), ["45s", "4m 05s", "3h 05m", "2d 4h", "0s"]);
  assert.deepEqual([1680, 3600, 1.499].map(duration), ["28m 00s", "1h 00m", "1s"]);
});
