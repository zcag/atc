import test from "node:test";
import assert from "node:assert/strict";
import { extended, logged, onLine } from "./call-log.js";

test("sentences in a row are one turn, with the speaker changing the turn", () => {
  let log = [];
  for (const o of [{ you: "hi" }, { said: "One." }, { said: "Two." }, { you: "more" }, { said: "Three." }]) log = logged(log, o, "assistant");
  assert.deepEqual(log.map((t) => [t.by, t.parts]), [["you", ["hi"]], ["it", ["One.", "Two."]], ["you", ["more"]], ["it", ["Three."]]]);
});

test("events carrying no words leave the log alone, so a moved line keeps what was said", () => {
  const log = logged([], { said: "One." }, "assistant");
  assert.equal(logged(log, { state: "thinking" }, "assistant"), log);
  assert.equal(logged(log, { said: "", you: "", line: "tracker" }, "tracker"), log);
});

test("a new agent on the line starts its own turn", () => {
  const log = logged(logged([], { said: "Moving you." }, "assistant"), { said: "Hello." }, "tracker");
  assert.deepEqual(log.map((t) => t.who), ["assistant", "tracker"]);
});

test("a long call keeps the latest turns and leaves the earlier log untouched", () => {
  const first = extended([], "you", "you", "first");
  let log = first;
  for (let i = 0; i < 300; i++) log = extended(log, i % 2 ? "you" : "it", i % 2 ? "you" : "assistant", String(i));
  assert.equal(log.length, 200);
  assert.equal(log.at(-1).parts[0], "299");
  assert.deepEqual(first[0].parts, ["first"]);
});

test("an agent's line goes by its title", () => {
  assert.equal(onLine({ line: "assistant", title: "x" }), "assistant");
  assert.equal(onLine({ line: "tracker", title: "Tracker" }), "Tracker");
  assert.equal(onLine({ line: "tracker", title: "" }), "tracker");
});
