import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KEY_GROUPS, key, tip, aria, matches } from "./keys.js";

const ids = new Set(KEY_GROUPS.flatMap(([, , rows]) => rows.map((r) => r[0])));

test("groups are the six places a key works", () => {
  assert.deepEqual(KEY_GROUPS.map((g) => g[0]), ["Everywhere", "Lists", "Session", "Transcript", "Call", "Dialogs"]);
  assert.equal(ids.size, KEY_GROUPS.reduce((n, g) => n + g[2].length, 0), "ids are unique");
});

test("hints read from the table", () => {
  assert.equal(key("term"), "`");
  assert.equal(key("state"), "\\");
  assert.equal(key("page"), "]");
  assert.equal(tip("write", "Resume"), "Resume (enter)");
  assert.equal(aria("hangup"), "Shift+E");
  assert.match(aria("palette"), /^\/ (Control|Meta)\+K$/);
});

test("every key id the app names is in the table", () => {
  const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const used = [...src.matchAll(/\b(?:tip|keyFor|ariaKeys)\("([^"]+)"/g)].map((m) => m[1]);
  const kb = [...src.matchAll(/\bkb\([^,]+, [^,]+?, "([a-z.]+)",/g)].map((m) => m[1]);
  assert.ok(used.length > 10);
  for (const id of [...used, ...kb]) assert.ok(ids.has(id), `unknown key id ${id}`);
});

test("the filter matches words in any order", () => {
  const row = KEY_GROUPS[3][2].find((r) => r[0] === "zen");
  assert.ok(matches("zen", KEY_GROUPS[3], row));
  assert.ok(matches("transcript leave", KEY_GROUPS[3], row));
  assert.ok(!matches("mute", KEY_GROUPS[3], row));
});
