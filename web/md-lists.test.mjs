import test from "node:test";
import assert from "node:assert/strict";
import { Marked } from "./vendor/marked.esm.js";
import { numberedLists } from "./md-lists.js";

const md = (src) => new Marked({ gfm: true, breaks: false }).use(numberedLists).parse(src);

test("a numbered list that continues after a heading line stays a list", () => {
  const out = md("**Me:**\n1. a\n2. b\n\n**You:**\n3. c\n4. d\n\n**Ship:**\n5. e\n");
  assert.equal(out.match(/<ol/g).length, 3);
  assert.equal(out.match(/<li>/g).length, 5);
  assert.match(out, /<p><strong>You:<\/strong><\/p>\n<ol start="3" style="counter-reset:n 2">\n<li>c<\/li>\n<li>d<\/li>/);
});

test("a list starting at 1 keeps its plain markup", () => {
  assert.match(md("**Me:**\n1. a\n"), /<ol>\n<li>a<\/li>/);
});

test("a list after a blank line keeps its number", () => {
  assert.match(md("text\n\n7. a\n"), /<ol start="7" style="counter-reset:n 6">/);
});

test("a wrapped year or a number inside a sentence stays prose", () => {
  assert.doesNotMatch(md("it happened in\n2024. Then it stopped\n"), /<ol/);
  assert.doesNotMatch(md("about 7,784 last\nonly 4 days\n"), /<ol/);
});

test("text around the list and inside fences is untouched", () => {
  assert.match(md("intro **bold**\n3. c\nlazy\n"), /<p>intro <strong>bold<\/strong><\/p>\n<ol start="3"[^>]*>\n<li>c\nlazy<\/li>/);
  assert.doesNotMatch(md("```\nx\n3. y\n```\n"), /<ol/);
});
