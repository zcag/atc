import test from "node:test";
import assert from "node:assert/strict";
import { clipPath, clipWords, langOf } from "./text.js";

test("paths drop whole folders from the start", () => {
  const p = "~/code/api/.claude/worktrees/migrate-uuid-keys";
  assert.equal(clipPath(p, 60), p);
  assert.equal(clipPath(p, 32), "…/worktrees/migrate-uuid-keys");
  assert.equal(clipPath(p, 20), "…/migrate-uuid-keys");
  assert.equal(clipPath("", 10), "");
  assert.equal(clipPath("worktree-checkout-ui-revamp--mocks", 22, "-"), "…-ui-revamp--mocks");
});

test("words clip at a word break with the ellipsis character", () => {
  assert.equal(clipWords("Rate limit retries", 40), "Rate limit retries");
  assert.equal(clipWords("Migrate sessions table to UUID keys", 20), "Migrate sessions…");
  assert.ok(!clipWords("a b c d e f g h i j k l m n", 10).includes("..."));
});

test("Turkish is detected from its letters", () => {
  assert.equal(langOf("Fatura PDF'inde Türkçe karakterler bozuk"), "tr");
  assert.equal(langOf("İstanbul şubesi"), "tr");
  assert.equal(langOf("Sözleşme taslağı"), "tr");
  assert.equal(langOf("Türkçe ve İngilizce"), "tr");
  assert.equal(langOf("Zoë read about Chloé's résumé"), null);
  assert.equal(langOf("Rate limit retries"), null);
  assert.equal(langOf("çok güzel bir gün"), "tr");
});
