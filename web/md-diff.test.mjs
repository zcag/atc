import test from "node:test";
import assert from "node:assert/strict";
import { diffBlock } from "./md-diff.js";

const rowsOf = (html, c) => [...html.matchAll(new RegExp(`<div class="l ${c}">.*?<span class="c">(.*?)</span></div>`, "g"))].map((m) => m[1]);

test("only diff fences and git diffs become rows", () => {
  assert.equal(diffBlock("js", "- a\n+ b"), null);
  assert.equal(diffBlock("diff", "no changes here"), null);
  assert.ok(diffBlock("", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"));
  assert.ok(diffBlock("patch", "-a\n+b"));
});

test("a space after the marker is dropped when every line has it, and deeper indent stays", () => {
  const h = diffBlock("diff", "+ ## Server\n+\n+     systemctl start x\n- gone");
  assert.deepEqual(rowsOf(h, "add"), ["## Server", " ", "    systemctl start x"]);
  assert.deepEqual(rowsOf(h, "del"), ["gone"]);
  assert.deepEqual(rowsOf(diffBlock("diff", "+foo\n-bar"), "add"), ["foo"]);
});

test("the tally counts lines and a comment line becomes a label", () => {
  const h = diffBlock("diff", "# PR A\n- a one\n+ a two\n\n# PR B\n+ b");
  assert.match(h, /<span class="plus">\+2<\/span> <span class="minus">-1<\/span>/);
  assert.equal(h.match(/<div class="lab">/g).length, 2);
  assert.match(h, /<div class="lab">PR B<\/div>/);
  assert.doesNotMatch(h, /class="blank"/);
});

test("changed words are marked on similar lines, also when the runs differ in length", () => {
  const h = diffBlock("diff", "- the rate is 3.5% of my weekly limit\n+ a wholly different first line with nothing shared at all\n+ the rate is 5.1% of my weekly limit");
  assert.deepEqual(rowsOf(h, "del"), ["the rate is <mark>3.5</mark>% of my weekly limit"]);
  const [first, second] = rowsOf(h, "add");
  assert.doesNotMatch(first, /<mark>/);
  assert.equal(second, "the rate is <mark>5.1</mark>% of my weekly limit");
});

test("a git diff shows its path once and numbers lines from the hunk", () => {
  const h = diffBlock("diff", "diff --git a/src/x.go b/src/x.go\nindex 123abc..456def 100644\n--- a/src/x.go\n+++ b/src/x.go\n@@ -10,2 +10,2 @@ func x() {\n a := 1\n-b := 2\n+b := 3\n\\ No newline at end of file");
  assert.equal(h.match(/class="fh"/g).length, 1);
  assert.match(h, /<div class="fh">src\/x\.go<\/div>/);
  assert.match(h, /<div class="gap">func x\(\) \{<\/div>/);
  assert.match(h, /<pre class="mdiff num">/);
  assert.match(h, /<div class="l ctx"><span class="ln o">10<\/span><span class="ln">10<\/span>/);
  assert.match(h, /<div class="l del"><span class="ln o">11<\/span><span class="ln"><\/span>/);
  assert.match(h, /<div class="l add"><span class="ln o"><\/span><span class="ln">11<\/span>/);
  assert.doesNotMatch(h.replace(/data-src="[^"]*"/, ""), /No newline|index 123abc/);
});

test("a new file takes its path from the new side and a deleted one from the old", () => {
  assert.match(diffBlock("diff", "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+a"), /class="fh">new\.txt</);
  assert.match(diffBlock("diff", "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a"), /class="fh">old\.txt</);
});

test("content is escaped and copy keeps the source", () => {
  const src = '- <b>"x"</b>\n+ <i>&</i>';
  const h = diffBlock("diff", src);
  assert.doesNotMatch(h, /<b>|<i>/);
  assert.ok(h.includes(`data-src="- &lt;b&gt;&quot;x&quot;&lt;/b&gt;\n+ &lt;i&gt;&amp;&lt;/i&gt;"`));
});
