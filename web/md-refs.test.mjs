import test from "node:test";
import assert from "node:assert/strict";
import { Marked } from "./vendor/marked.esm.js";
import { ansiParts, fileRef, isSha, issueRefs, shortURL } from "./md-refs.js";

test("file references, with and without a line", () => {
  assert.deepEqual(fileRef("web/app.js:12"), { path: "web/app.js", line: 12, end: 0 });
  assert.deepEqual(fileRef("web/app.js:12-30"), { path: "web/app.js", line: 12, end: 30 });
  for (const p of ["README.md", "/abs/x.go", "~/proj/x.py", "./a.rb", "../b.ts", ".github/ci.yml", "src/Makefile", "Dockerfile"]) assert.equal(fileRef(p)?.path, p, p);
  for (const t of ["origin/main", "and/or", "http/2", "example.com", "npm run test", "x.go:12:3", "https://a.io/x.go", ""]) assert.equal(fileRef(t), null, t);
});

test("a sha needs a digit and a letter", () => {
  for (const s of ["ca90a0242e", "abc1234", "b17f21aa763ccdec5bb82d293cfbbf4cd36e9d58"]) assert.ok(isSha(s), s);
  for (const s of ["defaced", "1234567", "abc123", "ABC1234", "ca90a0242g"]) assert.ok(!isSha(s), s);
});

test("long URLs read as what they point at", () => {
  assert.equal(shortURL("https://github.com/o/r/pull/12"), "o/r#12");
  assert.equal(shortURL("https://github.com/o/r/issues/12"), "o/r#12");
  assert.equal(shortURL("https://github.com/o/r/pull/12/files"), "o/r#12/files");
  assert.equal(shortURL("https://github.com/o/r/commit/ca90a0242eabcdef"), "o/r@ca90a0242e");
  assert.equal(shortURL("https://github.com/o/r/actions/runs/1928/job/55"), "o/r run 1928");
  assert.equal(shortURL("https://github.com/o/r/blob/main/src/a.go"), "o/r/src/a.go");
  assert.equal(shortURL("https://github.com/o/r"), "o/r");
  assert.equal(shortURL("https://www.example.com/docs"), "example.com/docs");
  assert.equal(shortURL("http://marko:8799/x?a=1"), "marko:8799/x?a=1");
  const long = shortURL("https://docs.example.com/a/very/long/path/that/goes/on/and/on/for/a/while/final-page");
  assert.ok(long.length <= 52 && long.includes("…") && long.endsWith("final-page"), long);
  assert.equal(shortURL("not a url"), "not a url");
});

const md = (s) => new Marked({ gfm: true }).use({ extensions: [issueRefs] }).parse(s);

test("issue references become links only where they are references", () => {
  assert.match(md("fixes #4182 and (#90)."), /fixes <span class="ref" data-issue="4182">#4182<\/span> and \(<span class="ref" data-issue="90">#90<\/span>\)/);
  assert.match(md("see o/r#77"), /<a class="ref" href="https:\/\/github.com\/o\/r\/issues\/77" data-out>o\/r#77<\/a>/);
  for (const s of ["the #1 priority", "colour #112233", "a#12", "`#123`", "[#123](https://x.io)", "```\n#123\n```", "https://x.io/a#123", "it&#39;s"]) assert.doesNotMatch(md(s), /class="ref"/, s);
});

test("ansi colours become parts and other escapes vanish", () => {
  assert.deepEqual(ansiParts("plain"), [{ text: "plain", cls: "" }]);
  assert.deepEqual(ansiParts("\x1b[32mok\x1b[0m done"), [{ text: "ok", cls: "ansi-g" }, { text: " done", cls: "" }]);
  assert.deepEqual(ansiParts("\x1b[1;31mFAIL\x1b[m"), [{ text: "FAIL", cls: "ansi-r ansi-bold" }]);
  assert.deepEqual(ansiParts("a\x1b[2Kb"), [{ text: "a", cls: "" }, { text: "b", cls: "" }]);
});
