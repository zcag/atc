import test from "node:test";
import assert from "node:assert/strict";
import { personOf, speakers, nextView, personLangs, langName, voiceName, roomName } from "./persons.js";

const doc = {
  persons: [
    { id: "a", name: "A", character: "woman", voices: { tr: "f" } },
    { id: "b", name: "B", character: "professor", voices: { tr: "m", en: "e" } },
    { id: "c", name: "C", character: "line", voices: { tr: "m" } },
  ],
  langs: { tr: "a", en: "b" },
};

test("the language decides the person", () => {
  assert.equal(personOf(doc, "tr").character, "woman");
  assert.equal(personOf(doc, "en").character, "professor");
  assert.equal(personOf(doc, "de"), null);
  assert.equal(personOf(null, "tr"), null);
});

test("only someone with a voice in the language can be picked for it", () => {
  assert.deepEqual(speakers(doc, "en").map((p) => p.id), ["b"]);
  assert.deepEqual(speakers(doc, "tr").map((p) => p.id), ["a", "b", "c"]);
});

test("the view goes round, and an unknown one starts over", () => {
  assert.equal(nextView("character"), "line");
  assert.equal(nextView("bars"), "character");
  assert.equal(nextView("gone"), "character");
});

test("languages come from voices and persons, Turkish first", () => {
  assert.deepEqual(personLangs({ en: {}, de: {} }, doc), ["tr", "de", "en"]);
  assert.deepEqual(personLangs(null, null), []);
});

test("names read as words", () => {
  assert.equal(langName("tr"), "Turkish");
  assert.equal(langName("de"), "de");
  assert.equal(voiceName("en_old_man"), "old man");
  assert.equal(roomName("my-big_room.webp"), "my big room");
});
