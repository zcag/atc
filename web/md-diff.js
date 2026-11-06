import { diffWords } from "./vendor/diff.mjs";

export const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function wordMarks(a, b, side) {
  const parts = diffWords(a, b), changed = parts.filter((p) => p.added || p.removed).reduce((n, p) => n + p.value.length, 0);
  if (changed > 0.6 * Math.max(a.length, b.length, 1)) return null;
  return parts.filter((p) => (side === "del" ? !p.added : !p.removed)).map((p) => (p.added || p.removed ? `<mark>${esc(p.value)}</mark>` : esc(p.value))).join("").replace(/<\/mark>([^\s<]{1,2})<mark>/g, "$1");
}

const GIT_META = /^(index [0-9a-f]+\.\.|new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (from|to) |copy (from|to) |Binary files )/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)/;
const MOST_PAIRED_LINES = 40;
const LONG_DIFF_ROWS = 40;

const headerPath = (l) => l.slice(4).split("\t")[0].replace(/^[ab]\//, "");

function parseDiff(code) {
  const lines = code.replace(/\n$/, "").split("\n"), rows = [];
  let o = 0, n = 0, numbered = false;
  const line = (c, l, marked = true) => rows.push({ c, l: l.replace(/\t/g, "  "), marked, o: numbered && c !== "add" ? o++ : "", n: numbered && c !== "del" ? n++ : "" });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (l.startsWith("diff --git ")) rows.push({ file: l.split(" b/").pop() });
    else if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const was = headerPath(l), now = headerPath(lines[++i]);
      if (!rows.at(-1)?.file) rows.push({ file: now === "/dev/null" ? was : now });
    } else if (GIT_META.test(l) || l.startsWith("\\")) continue;
    else if ((m = HUNK.exec(l))) {
      numbered = true;
      o = +m[1]; n = +m[2];
      if (m[3] || rows.at(-1)?.c) rows.push({ gap: m[3] || `line ${n}` });
    } else if (l.startsWith("#")) rows.push({ label: l.replace(/^#+\s*/, "") });
    else if (l[0] === "+") line("add", l.slice(1));
    else if (l[0] === "-") line("del", l.slice(1));
    else if (l[0] === " ") line("ctx", l.slice(1));
    else if (l || numbered) line("ctx", l, false);
    else rows.push({ blank: true });
  }
  return { rows: rows.filter((r, i) => !r.blank || (rows[i + 1] && !rows[i + 1].label && !rows[i + 1].file && !rows[i + 1].gap)), numbered };
}

function markPairs(rows) {
  for (let i = 0; i < rows.length; i++) {
    let d = i;
    while (rows[d]?.c === "del") d++;
    let a = d;
    while (rows[a]?.c === "add") a++;
    if (d === i || a === d || d - i > MOST_PAIRED_LINES || a - d > MOST_PAIRED_LINES) { i = Math.max(i, a - 1); continue; }
    let next = d;
    for (let j = i; j < d; j++) for (let k = next; k < a; k++) {
      const del = wordMarks(rows[j].t, rows[k].t, "del");
      if (!del) continue;
      rows[j].marks = del;
      rows[k].marks = wordMarks(rows[j].t, rows[k].t, "add");
      next = k + 1;
      break;
    }
    i = a - 1;
  }
}

export function diffBlock(lang, code) {
  if (!/^(diff|patch|udiff)$/.test(lang) && !code.startsWith("diff --git ")) return null;
  const { rows, numbered } = parseDiff(code);
  const count = (c) => rows.filter((r) => r.c === c).length, adds = count("add"), dels = count("del");
  if (!adds && !dels) return null;
  const indents = rows.filter((r) => r.c && r.marked && r.l.trim()).map((r) => r.l.match(/^ */)[0].length);
  const cut = new RegExp(`^ {0,${indents.length ? Math.min(...indents) : 0}}`);
  rows.forEach((r) => { if (r.c) r.t = r.l.replace(cut, ""); });
  markPairs(rows);
  const gutter = (r) => `${numbered ? `<span class="ln o">${r.o}</span><span class="ln">${r.n}</span>` : ""}<span class="s">${r.c === "add" ? "+" : r.c === "del" ? "-" : ""}</span>`;
  const row = (r) => r.file ? `<div class="fh">${esc(r.file)}</div>`
    : r.label ? `<div class="lab">${esc(r.label)}</div>`
    : r.gap ? `<div class="gap">${esc(r.gap)}</div>`
    : r.blank ? `<div class="blank"></div>`
    : `<div class="l ${r.c}">${gutter(r)}<span class="c">${r.marks || esc(r.t) || " "}</span></div>`;
  const tally = [adds && `<span class="plus">+${adds}</span>`, dels && `<span class="minus">-${dels}</span>`].filter(Boolean).join(" ");
  const long = rows.length > LONG_DIFF_ROWS;
  const cls = ["mdiff", numbered && "num", long && "long"].filter(Boolean).join(" ");
  return `<pre class="${cls}"><button class="copy" data-copy data-src="${esc(code)}">Copy</button><div class="dh">${tally}</div><div class="rows">${rows.map(row).join("")}</div>${long ? `<button class="cbmore" data-more>Show all ${rows.length} lines</button>` : ""}</pre>`;
}
