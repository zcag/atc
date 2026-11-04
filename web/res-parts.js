const SHELLS = /^(zsh|bash|sh|dash|fish)$/;
const RUNNERS = /^(node|nodejs|python\d*(\.\d+)?|ruby|bundle|uv|uvx|npm|npx|pnpm|yarn|bun|deno|java|go|cargo|make|nice|env|timeout)$/;
const VERBS = /^(exec|run|-m|-c|x|tool)$/;

const base = (w) => w.split("/").pop().replace(/:$/, "");

export function prettyName(p) {
  const words = (p.cmd || "").split(/\s+/).filter(Boolean);
  if (!words.length) return p.name;
  const first = base(words[0]);
  if (!RUNNERS.test(first)) return first || p.name;
  for (const w of words.slice(1)) {
    if (w.startsWith("-") ? !VERBS.test(w) : false) continue;
    if (!VERBS.test(w)) return base(w);
  }
  return first;
}

function label(procs, root) {
  if (procs.some((p) => /playwright/.test(p.cmd || ""))) return "Browser tool";
  const rootCmd = root.cmd || "";
  if (/(^|\/)atc browser mcp\b/.test(rootCmd)) return "Browser tool";
  if (/(^|\/)atc mcp\b/.test(rootCmd)) return "atc tools";
  const work = procs.filter((p) => !SHELLS.test(p.name));
  if (!work.length) return "Shell";
  return prettyName(work.reduce((a, b) => (b.mem > a.mem ? b : a)));
}

function details(procs) {
  const text = procs.map((p) => p.cmd || "").join("\n");
  return {
    port: text.match(/tcp:\/\/[^:\s]*:(\d+)/)?.[1] || text.match(/--port[= ](\d+)/)?.[1] || null,
    folder: text.match(/\[([^\]\s]+)\]/)?.[1] || null,
    age: Math.max(0, ...procs.map((p) => p.age || 0)),
  };
}

// What a session is spending on, by what it runs rather than process by process: Claude itself, then
// one line for each thing Claude started, named after whatever in it holds the most memory.
export function partsOf(procs) {
  const has = new Set(procs.map((p) => p.pid));
  const kids = new Map();
  for (const p of procs) {
    const up = has.has(p.ppid) ? p.ppid : 0;
    kids.set(up, [...(kids.get(up) || []), p]);
  }
  const subtree = (p) => [p, ...(kids.get(p.pid) || []).flatMap(subtree)];
  const groups = [];
  const claude = [];
  const walk = (p) => {
    if (p.name === "claude") {
      claude.push(p);
      (kids.get(p.pid) || []).forEach(walk);
    } else {
      const members = subtree(p);
      groups.push({ name: label(members, p), procs: members });
    }
  };
  (kids.get(0) || []).forEach(walk);
  if (claude.length) groups.push({ name: "Claude", procs: claude });
  const merged = new Map();
  for (const g of groups) {
    const m = merged.get(g.name) || { name: g.name, procs: [] };
    m.procs.push(...g.procs);
    merged.set(g.name, m);
  }
  return [...merged.values()]
    .map((g) => ({ ...g, mem: g.procs.reduce((a, p) => a + p.mem, 0), cpu: g.procs.reduce((a, p) => a + p.cpu, 0), ...details(g.procs) }))
    .sort((a, b) => b.mem - a.mem);
}
