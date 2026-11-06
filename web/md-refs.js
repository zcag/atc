const EXT = "go|mod|sum|js|mjs|cjs|ts|tsx|jsx|py|rb|rs|c|h|cc|cpp|hpp|java|kt|kts|swift|php|lua|md|mdx|json|jsonl|css|scss|html|xml|sh|bash|zsh|yml|yaml|toml|ini|conf|cfg|env|sql|txt|log|csv|tsv|service|plist|proto|tf|vue|svelte|ex|exs|erb|lock|png|jpe?g|gif|webp|svg|pdf";
const NAMED = "Makefile|Dockerfile|Gemfile|Rakefile|Caddyfile|Justfile|LICENSE";
const FILE_REF = new RegExp(`^((?:~/|/|\\.{1,2}/)?(?:[\\w.@+-]+/)*(?:[\\w.@+-]+\\.(?:${EXT})|${NAMED}))(?::(\\d+)(?:-(\\d+))?)?$`);

export function fileRef(text) {
  const m = FILE_REF.exec(text || "");
  return m ? { path: m[1], line: m[2] ? +m[2] : 0, end: m[3] ? +m[3] : 0 } : null;
}

export const isSha = (t) => /^[0-9a-f]{7,40}$/.test(t) && /\d/.test(t) && /[a-f]/.test(t);

const MOST_URL = 52;
export function shortURL(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "github.com") {
    const [o, r, kind, id, ...rest] = u.pathname.split("/").filter(Boolean);
    if (r && /^(pull|issues)$/.test(kind) && /^\d+$/.test(id)) return `${o}/${r}#${id}${rest.length ? "/" + rest.join("/") : ""}`;
    if (r && kind === "commit" && id) return `${o}/${r}@${id.slice(0, 10)}`;
    if (r && kind === "actions" && id === "runs" && rest[0]) return `${o}/${r} run ${rest[0]}`;
    if (r && /^(blob|tree)$/.test(kind) && rest.length) return `${o}/${r}/${rest.join("/")}`;
    if (o) return u.pathname.slice(1).replace(/\/$/, "");
  }
  const whole = host + (u.port ? `:${u.port}` : "") + (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
  if (whole.length <= MOST_URL) return whole;
  const head = whole.slice(0, MOST_URL - 14).replace(/[/?&=#-]+$/, ""), tail = whole.slice(-12).replace(/^[/?&=#-]+/, "");
  return `${head}…${tail}`;
}

const ISSUE_START = /(?<![\w/#&.-])(?:[\w.-]+\/[\w.-]+)?#\d{2,5}\b/;
const ISSUE = /^(?:([\w.-]+\/[\w.-]+))?#(\d{2,5})\b/;
export const issueRefs = {
  name: "issue",
  level: "inline",
  start: (src) => { const i = src.search(ISSUE_START); return i < 0 ? undefined : i; },
  tokenizer(src, tokens) {
    if (this.lexer.state.inLink || /[\w/#&.-]$/.test(tokens?.at(-1)?.raw || "")) return;
    const m = ISSUE.exec(src);
    if (m) return { type: "issue", raw: m[0], repo: m[1] || "", n: m[2] };
  },
  renderer: (t) => t.repo
    ? `<a class="ref" href="https://github.com/${t.repo}/issues/${t.n}" data-out data-iss="${t.repo}#${t.n}">${t.raw}</a>`
    : `<span class="ref" data-issue="${t.n}">${t.raw}</span>`,
};

const ANSI = /\x1b\[([0-9;?]*)([A-Za-z])/g;
const FG = { 30: "k", 31: "r", 32: "g", 33: "y", 34: "b", 35: "m", 36: "c", 37: "w", 90: "k", 91: "r", 92: "g", 93: "y", 94: "b", 95: "m", 96: "c", 97: "w" };
export function ansiParts(text) {
  if (!text.includes("\x1b")) return [{ text, cls: "" }];
  const out = [];
  let at = 0, fg = "", bold = false, m;
  const push = (t) => { if (t) out.push({ text: t, cls: [fg && `ansi-${fg}`, bold && "ansi-bold"].filter(Boolean).join(" ") }); };
  ANSI.lastIndex = 0;
  while ((m = ANSI.exec(text))) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] !== "m") continue;
    for (const c of (m[1] || "0").split(";").map(Number)) {
      if (c === 0) { fg = ""; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) fg = "";
      else if (FG[c]) fg = FG[c];
    }
  }
  push(text.slice(at));
  return out;
}

export function githubIssue(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : "";
}

export const slug = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

export const spotLink = (origin, sid, turn, heading) => `${origin}/#/s/${sid}/t/${turn}${heading ? `/h/${encodeURIComponent(slug(heading))}` : ""}`;

export function spotOf(hash) {
  const m = /^#\/s\/([^/]+)\/t\/(\d+)(?:\/h\/(.+))?$/.exec(hash);
  return m ? { sid: m[1], turn: +m[2], heading: m[3] ? decodeURIComponent(m[3]) : "" } : null;
}

export const stripAnsi = (t) => t.replace(ANSI, "");

// Which lines of a clipped output to show folded: the start usually, the end when it failed, since that is why.
export function clipView(lines, { n, bad }) {
  const kept = lines.length;
  if (kept <= n) return { shown: lines, before: 0, after: 0 };
  return bad ? { shown: lines.slice(-n), before: kept - n, after: 0 } : { shown: lines.slice(0, n), before: 0, after: kept - n };
}
