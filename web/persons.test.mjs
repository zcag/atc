import test from "node:test";
import assert from "node:assert/strict";
import { personOf, speakers, nextPerson, personLangs } from "./persons.js";

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

test("next goes round the speakers, and nowhere when there is nobody else", () => {
  assert.equal(nextPerson(doc, "tr").id, "b");
  assert.equal(nextPerson({ ...doc, langs: { tr: "c" } }, "tr").id, "a");
  assert.equal(nextPerson(doc, "en"), null);
  assert.equal(nextPerson(doc, "de"), null);
  assert.equal(nextPerson({ persons: doc.persons, langs: {} }, "en").id, "b");
});

test("languages come from voices and persons, Turkish first", () => {
  assert.deepEqual(personLangs({ en: {}, de: {} }, doc), ["tr", "de", "en"]);
  assert.deepEqual(personLangs(null, null), []);
});
