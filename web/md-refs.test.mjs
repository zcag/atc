import test from "node:test";
import assert from "node:assert/strict";
import { Marked } from "./vendor/marked.esm.js";
import { ansiParts, clipView, cutAt, fileRef, githubIssue, isSha, issueRefs, linkSessions, shortURL, slug, spotLink, spotOf, stripAnsi } from "./md-refs.js";

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
  assert.equal(shortURL("http://box:8799/x?a=1"), "box:8799/x?a=1");
  const long = shortURL("https://docs.example.com/a/very/long/path/that/goes/on/and/on/for/a/while/final-page");
  assert.ok(long.length <= 52 && long.includes("…") && long.endsWith("final-page"), long);
  assert.equal(shortURL("not a url"), "not a url");
});

const md = (s) => new Marked({ gfm: true }).use({ extensions: [issueRefs] }).parse(s);

test("issue references become links only where they are references", () => {
  assert.match(md("fixes #4182 and (#90)."), /fixes <span class="ref" data-issue="4182">#4182<\/span> and \(<span class="ref" data-issue="90">#90<\/span>\)/);
  assert.match(md("see o/r#77"), /<a class="ref" href="https:\/\/github.com\/o\/r\/issues\/77" data-out data-iss="o\/r#77">o\/r#77<\/a>/);
  for (const s of ["the #1 priority", "colour #112233", "a#12", "`#123`", "[#123](https://x.io)", "```\n#123\n```", "https://x.io/a#123", "it&#39;s"]) assert.doesNotMatch(md(s), /class="ref"/, s);
});

test("ansi colours become parts and other escapes vanish", () => {
  assert.deepEqual(ansiParts("plain"), [{ text: "plain", cls: "" }]);
  assert.deepEqual(ansiParts("\x1b[32mok\x1b[0m done"), [{ text: "ok", cls: "ansi-g" }, { text: " done", cls: "" }]);
  assert.deepEqual(ansiParts("\x1b[1;31mFAIL\x1b[m"), [{ text: "FAIL", cls: "ansi-r ansi-bold" }]);
  assert.deepEqual(ansiParts("a\x1b[2Kb"), [{ text: "a", cls: "" }, { text: "b", cls: "" }]);
});

test("a github URL says which issue it is", () => {
  assert.equal(githubIssue("https://github.com/o/r/pull/12"), "o/r#12");
  assert.equal(githubIssue("https://github.com/o/r/issues/12#issuecomment-5"), "o/r#12");
  assert.equal(githubIssue("https://github.com/o/r/pull/12/files"), "o/r#12");
  assert.equal(githubIssue("https://github.com/o/r/commit/abc"), "");
  assert.equal(githubIssue("https://github.com.evil.io/o/r/pull/12"), "");
});

test("a link to a spot round-trips", () => {
  const l = spotLink("https://x", "abc", 3, "A Draft: to send!");
  assert.equal(l, "https://x/#/s/abc/t/3/h/a-draft-to-send");
  assert.deepEqual(spotOf(new URL(l).hash), { sid: "abc", turn: 3, heading: "a-draft-to-send" });
  assert.deepEqual(spotOf("#/s/abc/t/3"), { sid: "abc", turn: 3, heading: "" });
  assert.equal(spotOf("#/s/abc"), null);
  assert.equal(spotOf("#/s/abc/p/page"), null);
  assert.equal(slug("Türkçe başlık 2"), "türkçe-başlık-2");
});

test("a failure folds to its end, anything else to its start", () => {
  const lines = Array.from({ length: 20 }, (_, i) => String(i + 1));
  assert.deepEqual(clipView(lines, { n: 3, bad: false }).shown, ["1", "2", "3"]);
  assert.equal(clipView(lines, { n: 3, bad: false }).after, 17);
  assert.deepEqual(clipView(lines, { n: 3, bad: true }).shown, ["18", "19", "20"]);
  assert.equal(clipView(lines, { n: 3, bad: true }).before, 17);
  assert.deepEqual(clipView(["a"], { n: 3, bad: true }), { shown: ["a"], before: 0, after: 0 });
});

test("stripping removes every terminal escape", () => {
  assert.equal(stripAnsi("\x1b[32mok\x1b[0m\x1b[2K!"), "ok!");
});

test("sessions named in a reply link to them, only by exact title in quotes or as @agent", () => {
  const sessions = [{ id: "a1", title: "billing retry check" }, { id: "b2", title: "fix" }, { id: "c3", title: "Sweeper", agent: "sweeper" }, { id: "d4", title: "A&B check" }];
  const link = (h) => linkSessions(h, sessions, (s) => s.id);
  for (const [h, want] of [
    ["<p>I started &quot;billing retry check&quot; to fix it.</p>", 'href="#/s/a1"'],
    ["<p>I started “billing retry check”, it reports back.</p>", 'href="#/s/a1"'],
    ["<p>ask @sweeper about it</p>", 'href="#/s/c3">@sweeper'],
    ["<p>&quot;A&amp;B check&quot; done</p>", 'href="#/s/d4"'],
  ]) assert.ok(link(h).includes(want), h);
  for (const h of ["<p>billing retry check without quotes</p>", "<p>a &quot;fix&quot; is too short to trust</p>", "<p>mail me@sweeper.com</p>", "<p><code>&quot;billing retry check&quot;</code></p>"]) assert.equal(link(h), h, h);
});

test("a reply the user cut off splits after the last words they heard", () => {
  const reply = "First this. Then the second part. And a third one nobody heard.";
  assert.equal(reply.slice(cutAt(reply, "First this. Then the second part.")).trim(), "And a third one nobody heard.");
  assert.equal(cutAt(reply, "something it never said"), -1);
});
