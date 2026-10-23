import { html, render, useState, useEffect, useRef, useMemo, useCallback } from "./vendor/preact-htm.js";

const BAYS = [
  ["needs-you", "Needs you"],
  ["your-turn", "Your turn"],
  ["working", "Working"],
  ["stopped", "Stopped"],
];
const WORD = { "needs-you": "needs you", "your-turn": "your turn", working: "working", stopped: "stopped", past: "earlier" };
const touch = matchMedia("(pointer: coarse)").matches;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && JSON.stringify(opts.body),
  });
  if (res.status === 401) throw Object.assign(new Error("Log in to continue."), { auth: true });
  if (!res.ok) throw Object.assign(new Error((await res.text()).trim() || res.statusText), { status: res.status });
  return res.json();
}

function ago(s) {
  const t = Math.max(Date.parse(s.updated || 0) || 0, Date.parse(s.startedAt || 0) || 0);
  if (!t) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 172800) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

let HOME = "", CLAUDE_THEME = "dark";
const tilde = (p) => {
  if (!p) return "";
  if (HOME && (p === HOME || p.startsWith(HOME + "/"))) return "~" + p.slice(HOME.length);
  const m = p.match(/^\/(home|Users)\/[^/]+(\/.*)?$/);
  return m ? "~" + (m[2] || "") : p;
};
let MULTI = false;
let VOICE = {};
let VOICE_OK = false;
const model = (m) => (m || "").replace(/^claude-/, "").replace(/-\d.*$/, "");
const keyOf = (s) => s.id || s.sessionId;
const go = (k) => (location.hash = k ? `#/s/${k}` : "#/");

function useRoute() {
  const read = () => (location.hash.match(/^#\/s\/(.+)$/) || [])[1] || null;
  const [r, set] = useState(read);
  useEffect(() => {
    const f = () => set(read());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return r;
}

function useNow(ms) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const APP = window.AtcApp || null;
const APP_VERSION = +((navigator.userAgent.match(/AtcApp\/(\d+)/) || [])[1] || 0);
let AUTO_VOICE = false;
let appSent = "";
const FEED_STATES = ["needs-you", "your-turn", "working"];

function App() {
  const [me, setMe] = useState(undefined);
  const [live, setLive] = useState(null);
  const [up, setUp] = useState(true);
  const [past, setPast] = useState({});
  const [creating, setCreating] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [quick, setQuick] = useState(null);
  QUICK = (s, rect) => setQuick({ s, rect });
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState(null);
  const [usage, setUsage] = useState(false);
  const [limits, setLimits] = useState(null);
  const route = useRoute();
  const [stale, setStale] = useState(null);
  const [starting, setStarting] = useState(false);
  useNow(30000);

  useEffect(() => {
    const load = () => api("/api/me").then(setMe, (e) => setMe((m) => (e.auth ? null : m || { host: "" })));
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!me) return;
    const es = new EventSource("/api/events");
    es.addEventListener("sessions", (e) => {
      setLive(JSON.parse(e.data) || []);
      setUp(true);
    });
    es.onerror = () => {
      setUp(false);
      api("/api/me").catch((e) => e.auth && setMe(null));
    };
    return () => es.close();
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const load = () => api("/api/usage/limits").then(setLimits, () => {});
    load();
    const t = setInterval(load, 120000);
    return () => clearInterval(t);
  }, [!!me]);

  useEffect(() => {
    if (!me || !APP_VERSION) return;
    fetch("/app/version.json").then((r) => (r.ok ? r.json() : null)).then((v) => v && v.versionCode > APP_VERSION && setStale(v.versionName), () => {});
  }, [me]);

  const [assisting, setAssisting] = useState(location.hash === "#/assist");
  const shareRoute = () => (location.hash.startsWith("#/share") ? location.hash : null);
  const [sharing, setSharing] = useState(shareRoute);
  useEffect(() => {
    const f = () => { setAssisting(location.hash === "#/assist"); setSharing(shareRoute()); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const talk = async (fresh) => {
    setStarting(true);
    try {
      const r = await api(`/api/assist${fresh ? "?new=1" : ""}`, { method: "POST" });
      AUTO_VOICE = true;
      go(r.id);
    } catch (e) {
      say(`Could not open the assistant: ${e.message}`);
      go(null);
    }
    setTimeout(() => setStarting(false), 15000);
  };

  const [notifAsk, setNotifAsk] = useState(() => {
    try { return !APP && !touch && typeof Notification !== "undefined" && Notification.permission === "default" && !localStorage.getItem("atc.notifask"); } catch { return false; }
  });
  const notifDone = (allow) => {
    try { localStorage.setItem("atc.notifask", "1"); } catch {}
    setNotifAsk(false);
    if (allow) Notification.requestPermission().then((p) => p === "granted" && say("Desktop notifications are on."));
  };
  const prevStates = useRef(null);
  useEffect(() => {
    if (!live) return;
    const prev = prevStates.current;
    prevStates.current = Object.fromEntries(live.map((x) => [x.sessionId, x.state]));
    if (!prev || APP || typeof Notification === "undefined" || Notification.permission !== "granted" || document.hasFocus()) return;
    for (const x of live) {
      const was = prev[x.sessionId];
      if (!was || was === x.state || x.parked || (x.state !== "needs-you" && x.state !== "your-turn")) continue;
      const n = new Notification(x.title || "atc", { body: x.state === "needs-you" ? `Needs you${x.activity ? ": " + x.activity : ""}` : (x.lastReply || "Finished its turn"), tag: x.sessionId, icon: "/icon.svg" });
      n.onclick = () => { window.focus(); go(keyOf(x)); n.close(); };
    }
  }, [live]);

  const warmed = useRef(false);
  useEffect(() => {
    if (!live || warmed.current) return;
    warmed.current = true;
    const likely = live.filter((x) => x.attachable && !x.parked && (x.state === "needs-you" || x.state === "your-turn")).slice(0, 2);
    setTimeout(() => likely.forEach(prewarm), 1200);
  }, [live]);

  useEffect(() => {
    if (!live) return;
    if (APP?.setSessions) {
      const rows = ordered.filter((s) => !s.parked && FEED_STATES.includes(s.state)).slice(0, 12).map((s) => ({
        id: s.attachable ? s.id : undefined, sid: s.sessionId, title: s.title, state: s.state, host: s.host || undefined, pinned: s.pinned || undefined,
        since: (s.state === "working" && s.promptAt) || s.updated || undefined,
      }));
      const key = JSON.stringify(rows.map(({ since, ...r }) => r));
      if (key !== appSent) { appSent = key; APP.setSessions(JSON.stringify({ type: "sessions", at: new Date().toISOString(), sessions: rows })); }
    } else if (APP?.setTargets) {
      const targets = JSON.stringify(live.filter((s) => s.attachable && !s.parked).slice(0, 8).map((s) => ({ id: s.sessionId, title: s.title })));
      if (targets !== appSent) APP.setTargets((appSent = targets));
    }
  }, [live]);

  useEffect(() => {
    const n = (live || []).filter((s) => s.state === "needs-you" && !s.parked).length;
    document.title = n ? `(${n}) atc` : "atc";
  }, [live]);

  const say = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  const bay = (st) => (live || []).filter((x) => !x.pinned && !x.parked && x.state === st);
  const ordered = (live || []).filter((x) => x.pinned && !x.parked)
    .concat(["needs-you", "your-turn", "working"].flatMap(bay))
    .concat((live || []).filter((x) => x.parked))
    .concat(bay("stopped"));
  const keys = useRef({});
  keys.current = { ordered, route, cursor, creating };
  useEffect(() => {
    const step = (from, d) => {
      const list = keys.current.ordered;
      if (!list.length) return null;
      const i = list.findIndex((x) => keyOf(x) === from || x.sessionId === from);
      return list[Math.max(0, Math.min(list.length - 1, i < 0 ? (d > 0 ? 0 : list.length - 1) : i + d))];
    };
    const onKey = (e) => {
      const k = keys.current;
      if (k.creating) return;
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const next = step(k.route, e.key === "ArrowUp" ? -1 : 1);
        if (next) { e.preventDefault(); e.stopPropagation(); go(keyOf(next)); }
        return;
      }
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const move = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
      if (move) {
        const next = step(k.cursor || k.route, move);
        if (next) { e.preventDefault(); setCursor(next.sessionId); document.querySelector(`[data-sid="${next.sessionId}"]`)?.scrollIntoView({ block: "nearest" }); }
      } else if (e.key === "Enter" && k.cursor) {
        e.preventDefault();
        const x = k.ordered.find((x) => x.sessionId === k.cursor);
        if (x) go(keyOf(x));
      } else if (e.key === "t" && VOICE_OK) {
        e.preventDefault(); location.hash = "#/assist";
      } else if (e.key === "n") {
        e.preventDefault(); setCreating(true);
      } else if (e.key === "u") {
        e.preventDefault(); setUsage((u) => !u);
      } else if (e.key === "/") {
        e.preventDefault(); document.querySelector('.search input')?.focus();
      } else if (e.key === "?") {
        setHelp((h) => !h);
      } else if (e.key === "Escape") {
        setHelp(false); setCursor(null); setUsage(false);
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  if (me === undefined) return null;
  if (me === null) return html`<${Login} onDone=${setMe} />`;
  HOME = me.home || HOME;
  CLAUDE_THEME = me.claudeTheme || CLAUDE_THEME;
  MULTI = (me.hosts || []).length > 1;
  VOICE = me.voice || {};
  VOICE_OK = !!VOICE.stt;
  const down = (me.peers || []).filter((p) => p.error);

  const all = live || [];
  const sel = route && (all.find((s) => s.id === route || s.sessionId === route) || past[route]);
  const remember = (list) => setPast((p) => Object.fromEntries([...Object.entries(p), ...list.map((s) => [s.sessionId, s])]));

  return html`
    <div class="shell ${route ? "open" : ""}">
      <aside class="side">
        <header class="top">
          <span class="mark">atc</span>
          <span class="host">${me.host ? `on ${(me.hosts || [me.host]).join(" + ")}` : ""}</span>
          <span class="conn ${up ? "" : "down"}" title=${up ? "Live" : "Reconnecting"}></span>
          ${down.length > 0 && html`<span class="tag" title=${down.map((p) => `${p.name}: ${p.error}`).join("\n")}>${down.map((p) => p.name).join(", ")} unreachable</span>`}
          <span class="grow"></span>
          ${VOICE_OK && html`<button class="btn talk" onClick=${() => (location.hash = "#/assist")} title="Talk to Claude (t)"><span class="mi">${MIC}</span><span class="lb">Talk</span></button>`}
          <button class="btn primary" onClick=${() => setCreating(true)}>New session</button>
        </header>
        <${Board} live=${live} sel=${sel} cursor=${cursor} onPast=${remember} />
        <${UsageFoot} limits=${limits} onOpen=${() => setUsage(true)} />
      </aside>
      <main class="main">
        ${sel
          ? html`<${Session} key=${sel.sessionId} s=${sel} say=${say} live=${all} />`
          : html`<div class="blank">${starting || (route && !live) ? "Opening…" : route ? "This session is gone. Pick another from the list." : "Pick a session, or start a new one."}</div>`}
      </main>
    </div>
    ${creating && html`<${NewSession} onClose=${() => setCreating(false)} say=${say} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} home=${me.host} />`}
    ${sharing && html`<${Share} key=${sharing} live=${live} say=${say} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} home=${me.host} />`}
    ${assisting && html`<${Assist} live=${live} busy=${starting} onTalk=${talk} onOpen=${() => go(null)} />`}
    ${usage && html`<${UsageSheet} limits=${limits} multi=${MULTI} onClose=${() => setUsage(false)} />`}
    ${quick && html`<${QuickMenu} quick=${quick} say=${say} onClose=${() => setQuick(null)} />`}
    ${toast && html`<div class="toast" role="status">${toast}</div>`}
    ${notifAsk && me && html`<div class="appbar" role="status">
      <span>Get a desktop notification when a session finishes or needs you, while this tab is in the background?</span>
      <button class="btn primary" onClick=${() => notifDone(true)}>Turn on</button>
      <button class="btn" onClick=${() => notifDone(false)}>Not now</button>
    </div>`}
    ${stale && html`<div class="appbar" role="status">
      <span>A newer atc app is available (${stale}).</span>
      <button class="btn primary" onClick=${() => APP?.checkUpdate()}>Update</button>
      <button class="icon" aria-label="Dismiss" onClick=${() => setStale(null)}>✕</button>
    </div>`}
    ${help && html`
      <div class="veil" onPointerDown=${() => setHelp(false)}>
        <div class="sheet keyhelp">
          <h3>Keyboard</h3>
          <dl>
            <dt>j / k, ↓ / ↑</dt><dd>Move through sessions</dd>
            <dt>Enter</dt><dd>Open the highlighted session</dd>
            <dt>Alt + ↑ / ↓</dt><dd>Previous or next session, even from inside a terminal</dd>
            <dt>n</dt><dd>New session</dd>
            <dt>t</dt><dd>Talk: a voice session with Claude</dd>
            <dt>/</dt><dd>Search earlier sessions</dd>
            <dt>u</dt><dd>Usage: plan limits and tokens by day</dd>
            <dt>Ctrl + Z</dt><dd>In a terminal: detach. The session keeps running.</dd>
            <dt>?</dt><dd>Show or hide this</dd>
          </dl>
        </div>
      </div>`}
  `;
}

function Assist({ live, busy, onTalk, onOpen }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onOpen(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  const open = (live || []).filter((s) => !s.parked);
  const count = (st) => open.filter((s) => s.state === st).length;
  const summary = [["needs-you", "needs you"], ["your-turn", "your turn"], ["working", "working"]]
    .map(([st, word]) => count(st) && `${count(st)} ${word}`).filter(Boolean).join(" · ") || "Nothing open";
  const top = open.filter((s) => s.state !== "stopped").slice(0, 3);
  const last = open.find((s) => s.name === "assistant" || s.title === "assistant");
  return html`
    <div class="assist">
      ${!APP && html`<button class="icon close" onClick=${onOpen} aria-label="Close">✕</button>`}
      <button class="choice talk" disabled=${busy} onClick=${() => onTalk(true)}>
        <span class="big">${MIC}</span>
        <span class="what">${busy ? "Starting…" : "New voice session"}</span>
        <span class="sub">Talk to Claude in a fresh session</span>
      </button>
      ${last && html`<button class="link" disabled=${busy} onClick=${() => onTalk(false)}>Continue the last voice session</button>`}
      <button class="choice" onClick=${onOpen}>
        <span class="what">Open atc</span>
        <span class="sub">${live ? summary : "Loading…"}</span>
        ${top.map((s) => html`<span class="row"><i class=${s.state}></i>${s.title}</span>`)}
      </button>
    </div>
  `;
}

function Login({ onDone }) {
  const [tok, setTok] = useState("");
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      onDone(await api("/api/login", { method: "POST", body: { token: tok } }));
    } catch (e) {
      setErr(e.message);
    }
  };
  return html`
    <div class="login">
      <form onSubmit=${submit}>
        <span class="mark">atc</span>
        <p>Paste the token for this server. Run <code>atc token</code> on it to print one.</p>
        <label class="field"><span>Token</span><input type="password" autocomplete="current-password" value=${tok} onInput=${(e) => setTok(e.target.value)} autofocus /></label>
        ${err && html`<p class="err">${err}</p>`}
        <div class="actions"><button class="btn primary" disabled=${!tok}>Log in</button></div>
      </form>
    </div>
  `;
}

function Board({ live: all, sel, cursor, onPast }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState(null);
  PICK_PROJECT = (name) => setOnly((o) => (o === name ? null : name));
  const mine = (s) => !only || project(s.cwd).name === only;
  const live = all && all.filter(mine);
  const [hist, setHist] = useState(null);
  const [limit, setLimit] = useState(30);

  useEffect(() => {
    const t = setTimeout(() => {
      api(`/api/history?limit=${limit}&q=${encodeURIComponent(q)}`).then((list) => {
        setHist(list || []);
        onPast(list || []);
      }, () => setHist([]));
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, limit]);

  if (!live) return html`<div class="board"><p class="empty">Loading sessions…</p></div>`;
  const liveIDs = new Set(live.map((s) => s.sessionId));
  const earlier = (hist || []).filter((s) => !liveIDs.has(s.sessionId) && mine(s));
  const pinned = live.filter((s) => s.pinned && !s.parked);
  const rest = live.filter((s) => !s.pinned && !s.parked);
  const parked = live.filter((s) => s.parked);

  return html`
    <div class="board">
      ${only && html`<div class="onlybar">Only <span class="proj" style=${`--ph: ${hueOf(only)}`}>${only}</span><button class="icon" aria-label="Show all projects" onClick=${() => setOnly(null)}>✕</button></div>`}
      ${live.length === 0 && html`<p class="empty">${only ? `Nothing running in ${only}.` : "Nothing is running. Start a session, or pick up an earlier one below."}</p>`}
      ${pinned.length > 0 && html`<${Bay} title="Pinned" list=${pinned} sel=${sel} cursor=${cursor} />`}
      ${BAYS.filter(([st]) => st !== "stopped").map(([st, title]) => html`<${Bay} title=${title} list=${rest.filter((s) => s.state === st)} sel=${sel} cursor=${cursor} />`)}
      <${Bay} title="Parked" list=${parked} sel=${sel} cursor=${cursor} dim />
      <${Bay} title="Stopped" list=${rest.filter((s) => s.state === "stopped")} sel=${sel} cursor=${cursor} />
      <section class="bay">
        <h2>Earlier</h2>
        <div class="search">
          <input type="search" placeholder="Search titles, prompts and folders" value=${q} onInput=${(e) => setQ(e.target.value)} />
        </div>
        <div class="rack">${earlier.map((s) => html`<${Strip} s=${s} sel=${sel} />`)}</div>
        ${hist && hist.length >= limit && html`<button class="btn more" onClick=${() => setLimit(limit + 30)}>Show more</button>`}
        ${hist && earlier.length === 0 && html`<p class="empty">${q ? "No earlier sessions match." : "No earlier sessions."}</p>`}
      </section>
    </div>
  `;
}

function Bay({ title, list, sel, cursor, dim }) {
  if (!list.length) return null;
  return html`
    <section class="bay ${dim ? "parked" : ""}">
      <h2>${title} <span class="n">${list.length}</span></h2>
      <div class="rack">${list.map((s) => html`<${Strip} s=${s} sel=${sel} cursor=${cursor} />`)}</div>
    </section>
  `;
}

function Strip({ s, sel, cursor }) {
  const on = sel && sel.sessionId === s.sessionId;
  const press = useRef({ t: 0, fired: false, x: 0, y: 0 });
  const menu = (e) => { e?.preventDefault(); e?.stopPropagation(); QUICK(s, e?.currentTarget?.getBoundingClientRect()); };
  const hover = useRef(0);
  const down = (e) => {
    prewarm(s);
    if (e.pointerType !== "touch") return;
    const p = press.current;
    p.fired = false; p.x = e.clientX; p.y = e.clientY;
    const el = e.currentTarget;
    p.t = setTimeout(() => { p.fired = true; navigator.vibrate?.(15); QUICK(s, el.getBoundingClientRect()); }, 450);
  };
  const move = (e) => { const p = press.current; if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) clearTimeout(p.t); };
  const up = () => clearTimeout(press.current.t);
  return html`
    <button class="strip ${s.state} ${on ? "sel" : ""} ${cursor === s.sessionId ? "kb" : ""}" data-sid=${s.sessionId}
      onClick=${(e) => { if (press.current.fired) { press.current.fired = false; return e.preventDefault(); } go(keyOf(s)); }}
      onContextMenu=${menu} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}
      onPointerEnter=${(e) => { if (e.pointerType === "mouse") hover.current = setTimeout(() => prewarm(s), 150); }}
      onPointerLeave=${() => clearTimeout(hover.current)}
      aria-current=${on ? "true" : null}>
      <span class="qbtn" role="button" aria-label="Actions" onClick=${menu}>⋯</span>
      <div class="l1">
        <span class="title">${s.title || "Untitled"}</span>
        <span class="when">${s.state === "working" ? html`<${Elapsed} s=${s} />` : ago(s)}</span>
      </div>
      <div class="l2">
        <span class="word">${WORD[s.state] || s.state}</span>
        ${s.id && html`<span class="call">${s.id}</span>`}
        ${MULTI && s.host && html`<span class="tag">${s.host}</span>`}
        <${ProjectTag} path=${s.cwd} full />
        ${s.branch && s.branch !== "HEAD" && html`<span>${s.branch}</span>`}
        ${s.model && html`<span>${model(s.model)}</span>`}
        ${s.kind === "interactive" && html`<span class="tag">in a terminal</span>`}
        ${(s.servers || []).slice(0, 2).map((p) => html`<span class="srv" role="link" title=${`Open ${serverURL(s, p)}`} onClick=${(e) => { e.stopPropagation(); openOut(serverURL(s, p)); }}>:${p}</span>`)}
      </div>
      ${s.state === "working" && s.activity
        ? html`<div class="said doing">${s.activity}</div>`
        : s.lastPrompt && html`<div class="said">${s.lastPrompt.replace(/\s+/g, " ")}</div>`}
    </button>
  `;
}

function Elapsed({ s }) {
  useNow(1000);
  const t = Date.parse(s.promptAt || s.updated || s.startedAt);
  const d = Math.max(0, Math.floor((Date.now() - t) / 1000));
  return d < 3600 ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}` : ago(s);
}

let QUICK = () => {};
let PICK_PROJECT = () => {};
const CONTAINERS = new Set(["proj", "projects", "src", "code", "dev", "work", "repos", "git", "Developer"]);
function project(path) {
  const parts = tilde(path || "").replace(/\/\.claude\/worktrees\/[^/]+/, "").split("/");
  if (parts[0] === "~") {
    if (parts.length === 1 || !parts[1]) return { name: "~", rest: "" };
    const i = CONTAINERS.has(parts[1]) && parts.length > 2 ? 2 : 1;
    return { name: parts[i], rest: parts.slice(i + 1).join("/") };
  }
  const segs = parts.filter(Boolean);
  return { name: segs.at(-1) || "/", rest: "" };
}
const HUES = [175, 285, 330, 90, 200, 20, 250];
const hueOf = (name) => {
  let h = (2166136261 ^ 108) >>> 0;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return HUES[(h >>> 7) % HUES.length];
};
function ProjectTag({ path, full }) {
  const p = project(path);
  return html`<span class="projtag"><span class="proj" style=${`--ph: ${hueOf(p.name)}`} role="button" title=${`${tilde(path)}\nClick to show only ${p.name}`}
    onClick=${(e) => { e.stopPropagation(); PICK_PROJECT(p.name); }}>${p.name}</span>${full && p.rest && html`<span class="rest">${p.rest}</span>`}</span>`;
}

function sessionActions(s, say, { rename, open, after } = {}) {
  const run = (fn, done) => async () => {
    try {
      const r = await fn();
      done && done(r);
    } catch (e) {
      say(e.message);
    }
    after && after();
  };
  const patch = (body) => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body });
  const items = [];
  if (open) items.push({ label: "Open", run: () => go(keyOf(s)) });
  items.push({ label: "Rename", run: rename || run(() => { const n = prompt("Rename session", s.title); return n === null ? null : patch({ name: n }); }) });
  items.push({ label: s.pinned ? "Unpin" : "Pin to top", run: run(() => patch({ pinned: !s.pinned })) });
  items.push({ label: s.parked ? "Unpark" : "Park", run: run(() => patch({ parked: !s.parked })) });
  if (s.attachable) items.push({ label: "Stop", run: run(() => api(`/api/sessions/${s.id}/stop`, { method: "POST" }), () => say("Stopped. Resume it any time.")) });
  if (!s.attachable && s.kind !== "interactive")
    items.push({ label: "Resume", run: run(() => api(`/api/sessions/${s.sessionId}/resume`, { method: "POST" }), (r) => go(r.id)) });
  if (s.id)
    items.push({ label: "Delete", danger: true, run: run(() => confirm(`Delete "${s.title}"? Its conversation stays in history.`) ? api(`/api/sessions/${s.id}`, { method: "DELETE" }) : null) });
  return items;
}

function QuickMenu({ quick, say, onClose }) {
  useEffect(() => {
    const f = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
  const { s, rect } = quick;
  const items = sessionActions(s, say, { open: true });
  const style = touch || !rect ? "" : `position: fixed; left: ${Math.min(rect.left, innerWidth - 220)}px; top: ${Math.min(rect.bottom + 4, innerHeight - 320)}px`;
  return html`
    <div class="veil quick ${touch ? "sheetish" : ""}" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet qmenu" style=${style}>
        <div class="qtitle">${s.title || "Untitled"}</div>
        ${items.map((it) => html`<button class="btn ${it.danger ? "danger" : ""}" onClick=${() => { onClose(); it.run(); }}>${it.label}</button>`)}
      </div>
    </div>
  `;
}

function Session({ s, say, live }) {
  const canAttach = s.attachable;
  const [mode, setMode] = useState(canAttach || s.state === "stopped" ? "term" : "chat");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [voice, setVoice] = useState(() => { const v = AUTO_VOICE && canAttach; if (v) AUTO_VOICE = false; return v; });
  useEffect(() => {
    if (canAttach) setMode("term");
  }, [canAttach]);

  const act = async (fn, done) => {
    setBusy(true);
    try {
      const r = await fn();
      done && done(r);
    } catch (e) {
      say(e.message);
    }
    setBusy(false);
  };
  const resume = () =>
    act(() => api(`/api/sessions/${s.sessionId}/resume`, { method: "POST" }), (r) => {
      setMode("term");
      go(r.id);
    });
  const patch = (body) => act(() => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body }));
  const outs = useOutputs(s, mode === "out" ? 10000 : 60000);
  const [showUse, setShowUse] = useState(false);
  const use = useSessionUsage(s, showUse || s.state === "working" ? 15000 : 90000);
  const outCount = outs ? outs.servers.length + outs.files.filter((f) => f.kind !== "text").length + outs.links.length : 0;

  return html`
    <div class="head">
      <button class="icon back" onClick=${() => go(null)} aria-label="Back to sessions">‹ Back</button>
      <div class="who">
        <div class="t">
          ${renaming
            ? html`<input autofocus value=${s.title} onKeyDown=${(e) => {
                if (e.key === "Enter") { patch({ name: e.target.value }); setRenaming(false); }
                if (e.key === "Escape") setRenaming(false);
              }} onBlur=${() => setRenaming(false)} />`
            : html`<span onDblClick=${() => setRenaming(true)}>${s.title || "Untitled"}</span>`}
        </div>
        <div class="meta">
          <span class="word" style=${`--edge: var(--${{ "needs-you": "needs", "your-turn": "turn", working: "work" }[s.state] || "stop"})`}>${WORD[s.state] || s.state}</span>
          <${ProjectTag} path=${s.cwd} full />
          ${s.branch && s.branch !== "HEAD" && html`<span class="wide">${s.branch}</span>`}
          ${s.model && html`<span class="wide">${model(s.model)}</span>`}
          ${(s.context > 0 || use?.total > 0) && html`
            <span class="wide usehover" tabindex="0" role="button" onClick=${() => setShowUse(true)} onKeyDown=${(e) => e.key === "Enter" && setShowUse(true)}>
              ${s.context > 0 ? `${Math.round(s.context / 1000)}k context` : "usage"}
              ${use?.total > 0 && html`<span class="usecard" role="tooltip">
                ${weekShare(use, use.week) != null && html`<b>≈${pct(weekShare(use, use.week))} of your weekly limit</b>
                  <span>The week is at ${Math.round(use.week.percent)}%, resets ${resetDay(use.week.resetsAt)}</span>`}
                <span>${tokens(use.total)} tokens · ~${dollars(use.cost)} at API prices</span>
                <span class="hint">Click for details</span>
              </span>`}
            </span>`}
          ${s.permissionMode === "bypassPermissions" && html`<span class="wide" title="Claude runs tools in this session without asking first">no permission prompts</span>`}
        </div>
      </div>
      ${VOICE.stt && html`<button class="btn voice-btn ${voice ? "on" : ""} ${canAttach ? "" : "off"}" aria-pressed=${voice}
        onClick=${() => canAttach ? (setVoice(!voice), setMode("term"))
          : say(s.kind === "interactive" ? "Voice needs a session atc can type into. This one runs in a terminal window; start one from atc, or resume this one after it ends." : "Resume this session first, then turn on voice.")}>Voice</button>`}
      <div class="seg" role="tablist">
        <button class=${mode === "term" ? "on" : ""} onClick=${() => setMode("term")}>Terminal</button>
        <button class=${mode === "chat" ? "on" : ""} onClick=${() => setMode("chat")}>Transcript</button>
        <button class=${mode === "out" ? "on" : ""} onClick=${() => setMode("out")}>Outputs${outCount > 0 && html`<span class="count ${outs.servers.length ? "live" : ""}">${outCount}</span>`}</button>
      </div>
      <${Menu} busy=${busy} items=${[...sessionActions(s, say, { rename: () => setRenaming(true), after: () => setBusy(false) }), { label: "Usage", run: () => setShowUse(true) }]} />
    </div>
    ${mode === "term"
      ? canAttach
        ? html`<${Term} key=${s.id} s=${s} say=${say} voice=${voice} onVoiceOff=${() => setVoice(false)} />`
        : html`<div class="stage"><div class="cover">${Unattachable(s, resume, busy, setMode)}</div></div>`
      : mode === "out" ? html`<${Outputs} s=${s} data=${outs} />` : html`<${Transcript} s=${s} />`}
    ${showUse && html`<${SessionUsage} s=${s} use=${use} onClose=${() => setShowUse(false)} />`}
  `;
}

function Unattachable(s, resume, busy, setMode) {
  if (s.kind === "interactive")
    return html`<div><p class="h">Open in a terminal</p><p>This session runs in a terminal window on the server, so it can't be shown here. You can read along in the transcript.</p><div class="row"><button class="btn" onClick=${() => setMode("chat")}>Read transcript</button></div></div>`;
  return html`<div><p class="h">${s.state === "stopped" ? "Stopped" : "Not running"}</p><p>Resume it to pick up where it left off. The whole conversation comes back.</p><div class="row"><button class="btn primary" disabled=${busy} onClick=${resume}>${busy ? "Resuming…" : "Resume"}</button></div></div>`;
}

function Menu({ busy, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const f = (e) => !ref.current?.contains(e.target) && setOpen(false);
    addEventListener("pointerdown", f);
    return () => removeEventListener("pointerdown", f);
  }, [open]);
  return html`
    <div ref=${ref} style="position: relative">
      <button class="icon" aria-label="More actions" aria-expanded=${open} onClick=${() => setOpen(!open)}>•••</button>
      ${open && html`
        <div class="sheet" style="position: absolute; right: 0; top: 36px; width: 190px; padding: 8px; display: flex; flex-direction: column; gap: 6px; z-index: 10">
          ${items.map((it) => html`<button class="btn ${it.danger ? "danger" : ""}" disabled=${busy} onClick=${() => { setOpen(false); it.run(); }}>${it.label}</button>`)}
        </div>`}
    </div>
  `;
}

const PALETTE = {
  dark: {
    background: "#1a222e", foreground: "#e6e9ef", cursor: "#e6e9ef", cursorAccent: "#1a222e", selectionBackground: "#3a4a63",
    black: "#2c3748", red: "#f2545b", green: "#5cc98a", yellow: "#f0b429", blue: "#4aa3ff", magenta: "#c792ea", cyan: "#4fd1d9", white: "#c9d1dd",
    brightBlack: "#6b7689", brightRed: "#ff7b80", brightGreen: "#7ee0a6", brightYellow: "#ffd166", brightBlue: "#7cbcff", brightMagenta: "#dcaaf5", brightCyan: "#7fe5ea", brightWhite: "#ffffff",
  },
  light: {
    background: "#fbfaf5", foreground: "#1d2533", cursor: "#1d2533", cursorAccent: "#fbfaf5", selectionBackground: "#c7d7ee",
    black: "#1d2533", red: "#c2333b", green: "#1f8a4c", yellow: "#a36a00", blue: "#1f63b5", magenta: "#8a3fb8", cyan: "#137c86", white: "#8a93a3",
    brightBlack: "#5d6778", brightRed: "#d63b44", brightGreen: "#27a05b", brightYellow: "#b7791f", brightBlue: "#2477d1", brightMagenta: "#a052d1", brightCyan: "#1a929d", brightWhite: "#ffffff",
  },
};

const KEYS = [
  ["esc", "\x1b"], ["tab", "\t"], ["⇧tab", "\x1b[Z"], ["ctrl", null],
  ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["/", "/"], ["^C", "\x03"],
];

function useKeyboard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!touch) return;
    let tallest = 0;
    const check = () => {
      const h = window.visualViewport?.height || innerHeight;
      tallest = Math.max(tallest, h);
      setOpen(h < tallest - 150);
    };
    const reset = () => { tallest = 0; setTimeout(check, 300); };
    check();
    window.visualViewport?.addEventListener("resize", check);
    addEventListener("resize", check);
    addEventListener("orientationchange", reset);
    return () => {
      window.visualViewport?.removeEventListener("resize", check);
      removeEventListener("resize", check);
      removeEventListener("orientationchange", reset);
    };
  }, []);
  return open;
}

const DEVICE = APP ? "app" : (() => {
  const u = navigator.userAgent;
  const b = /Firefox\//.test(u) ? "Firefox" : /Edg\//.test(u) ? "Edge" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "browser";
  const o = /Android/.test(u) ? "Android" : /iPhone|iPad/.test(u) ? "iOS" : /Mac OS/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "";
  return o && !/Mac|Linux|Windows/.test(o) ? `${b} on ${o}` : b;
})();

let lastInput = Date.now(), lastBeat = 0;
const beat = () => {
  if (document.visibilityState !== "visible" || !document.hasFocus() || Date.now() - lastInput > 120000 || Date.now() - lastBeat < 20000) return;
  lastBeat = Date.now();
  fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: DEVICE }) }).catch(() => {});
};
for (const ev of ["keydown", "pointerdown", "wheel", "touchstart"]) addEventListener(ev, () => { lastInput = Date.now(); beat(); }, { passive: true, capture: true });
addEventListener("focus", beat);
setInterval(beat, 30000);

const DOCK = new Map();
const DOCK_KEEP = 4;
let dockShelf = null;

function shelf() {
  if (!dockShelf) {
    dockShelf = document.createElement("div");
    dockShelf.className = "dockshelf";
    document.body.append(dockShelf);
  }
  return dockShelf;
}

function prewarm(s) {
  if (s?.attachable && s.id && !DOCK.has(s.id)) dock(s);
}

function dock(s) {
  let d = DOCK.get(s.id);
  if (!d) {
    d = makeDock(s.id);
    DOCK.set(s.id, d);
  }
  d.used = Date.now();
  const spare = [...DOCK.values()].filter((x) => !x.box && x !== d).sort((p, q) => p.used - q.used);
  while (DOCK.size > DOCK_KEEP && spare.length) spare.shift().dispose();
  return d;
}

function makeDock(id) {
  const el = document.createElement("div");
  el.className = "termhost";
  shelf().append(el);
  const term = new Terminal({
    fontFamily: '"Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono", "Noto Sans Symbols 2", "Noto Sans Symbols", monospace',
    fontSize: touch ? 12.5 : 14,
    lineHeight: 1.1,
    theme: PALETTE[CLAUDE_THEME],
    allowProposedApi: true,
    scrollback: 2000,
    macOptionIsMeta: true,
    cursorStyle: "bar",
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new ClipboardAddon.ClipboardAddon());
  term.open(el);
  fit.fit();

  const enc = new TextEncoder();
  const d = { id, el, term, box: null, used: Date.now(), state: { cover: null, foreign: null, retrying: false }, ui: null, hooks: {} };
  let ws = null, exited = false, owner = false, tries = 0, timer = null, dead = false;
  const emit = (patch) => { Object.assign(d.state, patch); d.ui?.({ ...d.state }); };
  const ctl = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
  d.send = (data) => ws?.readyState === 1 && ws.send(enc.encode(data));
  d.claim = () => ctl({ type: "claim" });
  d.focus = () => term.focus();

  const scale = (on) => {
    const x = el.querySelector(".xterm");
    if (!x) return;
    if (!on) { x.style.transform = ""; el.classList.remove("scaled"); return; }
    const cw = term._core._renderService.dimensions.css.cell.width * term.cols;
    const ch = term._core._renderService.dimensions.css.cell.height * term.rows;
    const k = Math.min(1, (el.clientWidth - 8) / cw, (el.clientHeight - 6) / ch);
    x.style.transformOrigin = "top center";
    x.style.transform = `scale(${k})`;
    el.classList.add("scaled");
  };
  const relayout = () => {
    if (!d.box) return;
    const p = fit.proposeDimensions();
    if (!p?.cols) return;
    ctl({ type: "resize", cols: p.cols, rows: p.rows });
    if (owner) fit.fit(); else scale(true);
  };
  d.relayout = relayout;

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = `cols=${term.cols}&rows=${term.rows}&device=${encodeURIComponent(DEVICE)}${d.box && !document.hidden ? "" : "&hidden=1"}${tries > 0 ? "&reconnect=1" : ""}`;
    ws = new WebSocket(`${proto}//${location.host}/api/sessions/${id}/attach?${q}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return term.write(new Uint8Array(e.data));
      const c = JSON.parse(e.data);
      if (c.type === "size") {
        owner = !!c.owner;
        if (owner) {
          scale(false);
          if (d.box) fit.fit(); else term.resize(c.cols, c.rows);
          emit({ foreign: null });
        } else {
          term.resize(c.cols, c.rows);
          if (d.box) requestAnimationFrame(() => scale(true));
          emit({ foreign: d.box ? c.holder || "another screen" : null });
        }
      } else if (c.type === "exit") {
        exited = true;
        emit({ cover: "detached" });
      }
    };
    ws.onopen = () => {
      tries = 0;
      emit({ retrying: false });
      if (d.box && !document.hidden) { ctl({ type: "visible" }); requestAnimationFrame(relayout); }
    };
    ws.onclose = () => {
      if (exited || dead) return;
      if (tries >= 20) return emit({ cover: "lost" });
      emit({ retrying: true });
      timer = setTimeout(connect, Math.min(1000 * 2 ** tries++, 8000));
    };
    ws.onerror = () => {};
  };
  connect();

  term.onData((data) => d.send(d.hooks.data ? d.hooks.data(data) : data));
  term.onBinary((data) => ws?.readyState === 1 && ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0))));

  const ro = new ResizeObserver(() => requestAnimationFrame(relayout));
  ro.observe(el);

  let ty = null, acc = 0;
  el.addEventListener("touchstart", (e) => { ty = e.touches[0].clientY; acc = 0; }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (ty === null) return;
    const y = e.touches[0].clientY;
    acc += ty - y;
    ty = y;
    while (Math.abs(acc) >= 18) {
      const dy = Math.sign(acc) * 18;
      acc -= dy;
      el.querySelector(".xterm-screen")?.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true, clientX: e.touches[0].clientX, clientY: y }));
    }
    e.preventDefault();
  }, { passive: false });
  el.addEventListener("touchend", () => (ty = null));
  el.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || !d.hooks.upload) return;
    e.preventDefault();
    e.stopPropagation();
    d.hooks.upload(files);
  }, true);

  d.page = (visible) => ctl({ type: visible ? "visible" : "hidden" });
  d.show = (box) => {
    d.box = box;
    box.append(el);
    shelf().style.cssText = `width:${box.clientWidth}px;height:${box.clientHeight}px`;
    ctl({ type: "visible" });
    requestAnimationFrame(relayout);
  };
  d.hide = () => {
    if (dead) return;
    d.box = null;
    d.ui = null;
    d.hooks = {};
    d.used = Date.now();
    ctl({ type: "hidden" });
    shelf().append(el);
    if (exited || d.state.cover) d.dispose();
  };
  d.dispose = () => {
    dead = true;
    clearTimeout(timer);
    ro.disconnect();
    ws?.close();
    term.dispose();
    el.remove();
    if (DOCK.get(id) === d) DOCK.delete(id);
  };
  return d;
}

document.addEventListener("visibilitychange", () => {
  for (const d of DOCK.values()) if (d.box) d.page(!document.hidden);
});

function Term({ s, say, voice, onVoiceOff }) {
  const keyboard = useKeyboard();
  const box = useRef();
  const api_ = useRef({});
  const picker = useRef();
  const [dropping, setDropping] = useState(false);
  const upload = useRef();
  upload.current = async (files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f, f.name || "pasted.png");
      try {
        const res = await fetch(`/api/sessions/${s.sessionId}/upload`, { method: "POST", body: fd });
        if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
        const { path } = await res.json();
        api_.current.send?.((/\s/.test(path) ? `"${path}"` : path) + " ");
      } catch (e) {
        say(`Upload failed: ${e.message}`);
      }
    }
    api_.current.focus?.();
  };
  const [gen, setGen] = useState(0);
  const [st, setSt] = useState({ cover: null, foreign: null, retrying: false });
  const { cover, foreign, retrying } = st;
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  useEffect(() => {
    const d = dock(s);
    d.ui = setSt;
    setSt({ ...d.state });
    d.hooks = {
      upload: (files) => upload.current(files),
      data: (data) => {
        if (ctrlRef.current && data.length === 1) {
          const c = data.toUpperCase().charCodeAt(0);
          if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
          setCtrl(false);
        }
        return data;
      },
    };
    d.show(box.current);
    api_.current = { send: d.send, focus: d.focus, claim: d.claim };
    if (!touch) d.focus();
    return () => d.hide();
  }, [s.id, gen]);

  const key = (k, seq) => {
    if (seq === null) return setCtrl(!ctrl);
    api_.current.send?.(seq);
    if (!touch) api_.current.focus?.();
  };

  const drop = {
    onDragOver: (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDropping(true); } },
    onDragLeave: () => setDropping(false),
    onDrop: (e) => { e.preventDefault(); setDropping(false); upload.current([...e.dataTransfer.files]); },
  };
  return html`
    <div class="stage ${dropping ? "dropping" : ""}" style=${`--term-bg: ${PALETTE[CLAUDE_THEME].background}`} ...${drop}>
      <input type="file" multiple hidden ref=${picker} onChange=${(e) => { upload.current([...e.target.files]); e.target.value = ""; }} />
      <button class="attach" title="Attach a file (or paste or drop one)" aria-label="Attach a file" onClick=${() => picker.current.click()}>Attach</button>
      <div class="term" ref=${box}></div>
      ${retrying && !cover && html`<div class="notice"><span>Reconnecting…</span></div>`}
      ${foreign && !cover && !retrying && html`
        <div class="notice">
          <span>Sized for ${foreign}</span>
          <button class="btn" onClick=${() => api_.current.claim?.()}>Fit to this one</button>
        </div>`}
      ${cover && html`
        <div class="cover">
          <div>
            <p class="h">${cover === "detached" ? "Detached" : "Connection lost"}</p>
            <p>${cover === "detached" ? "The terminal closed. The session keeps running." : "The link to the server dropped. The session keeps running."}</p>
            <div class="row">
              <button class="btn primary" onClick=${() => { DOCK.get(s.id)?.dispose(); setGen(gen + 1); }}>Reopen</button>
              <button class="btn" onClick=${() => go(null)}>Back to list</button>
            </div>
          </div>
        </div>`}
      ${voice && !cover && html`<${VoiceBar} s=${s} say=${say} send=${(d) => api_.current.send?.(d)} onClose=${onVoiceOff} />`}
      <div class="keys ${keyboard ? "show" : ""}" onPointerDown=${(e) => e.preventDefault()}>
        ${KEYS.map(([label, seq]) => html`<button class=${label === "ctrl" && ctrl ? "on" : ""} onClick=${() => key(label, seq)}>${label}</button>`)}
        <button onClick=${() => picker.current.click()}>file</button>
      </div>
    </div>
  `;
}

const loadScript = (src) =>
  new Promise((ok, no) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const el = Object.assign(document.createElement("script"), { src, onload: ok, onerror: () => no(new Error(`Could not load ${src}`)) });
    document.head.appendChild(el);
  });

const speakable = (t) =>
  (t || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\*\*|__|[*#>|]/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
const sentences = (t) => (t.match(/[^.!?…]+[.!?…]+["')]?(\s|$)|[^.!?…]+$/g) || [t]).map((x) => x.trim()).filter(Boolean);
const turkish = (t) => /[çğıöşüÇĞİÖŞÜ]/.test(t);
const PHANTOM = /^(thank you|thanks for watching|you|bye|altyazı.*|abone olmayı unutmayın.*|\.+)[.!]?$/i;
const PHASE = { starting: "Starting the microphone…", listening: "Listening", hearing: "Hearing you…", thinking: "Transcribing…", waiting: "Claude is working", speaking: "Speaking · tap to stop", muted: "Muted · tap to talk", error: "Voice is not available" };
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const MIC = html`<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>`;
const MIC_OFF = html`<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2l20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8M5 10a7 7 0 0 0 11.9 5M19 10a7 7 0 0 1-.6 2.9M12 17v5"/></svg>`;
const STOP = html`<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;

function turnsOf(msgs) {
  const turns = [];
  for (const m of msgs) {
    if (m.role === "user") turns.push([]);
    else if (m.role === "assistant" && turns.length) turns[turns.length - 1].push(m.text);
  }
  return turns.map((t) => t.join("\n\n")).filter((t) => t.trim());
}

function VoiceBar({ s, say, send, onClose }) {
  const [phase, setPhase] = useState("starting");
  const [heard, setHeard] = useState("");
  const [spoken, setSpoken] = useState("");
  const [muted, setMuted] = useState(false);
  const [source, setSource] = useState(() => pref("atc.voicesrc", VOICE.tts ? "mine" : "device"));
  const [bargeIn, setBargeIn] = useState(() => pref("atc.bargein", "off") === "on");
  const st = useRef({ awaiting: false, sentAt: 0, permission: false, speaking: false, audio: null, vad: null, turns: [], at: -1 });
  const live = useRef({});
  live.current = { s, source, muted, bargeIn };

  const listen = (on) => { const v = st.current.vad; if (!v) return; on ? v.start() : v.pause(); };
  const rest = () => {
    if (!live.current.muted) listen(true);
    setPhase(live.current.muted ? "muted" : st.current.awaiting ? "waiting" : "listening");
  };
  const stopSpeaking = () => {
    st.current.speaking = false;
    if (APP) APP.stopSpeaking();
    else if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    st.current.audio?.pause();
  };
  const play = (url) => new Promise((done) => {
    const a = new Audio(url);
    st.current.audio = a;
    a.onended = a.onpause = a.onerror = () => done();
    a.play().catch(() => done());
  });
  const finished = () => { if (st.current.speaking) { st.current.speaking = false; rest(); } };
  const speak = async (text) => {
    if (!text) return;
    stopSpeaking();
    await new Promise((r) => setTimeout(r, 60));
    setSpoken(text);
    st.current.speaking = true;
    if (!live.current.bargeIn) listen(false);
    setPhase("speaking");
    if (live.current.source === "mine" && VOICE.tts) {
      let chain = Promise.resolve();
      const clips = sentences(text).map((t) => (chain = chain.then(() =>
        fetch("/api/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) })
          .then((r) => (r.ok ? r.blob() : null)).catch(() => null))));
      for (const clip of clips) {
        const blob = await clip;
        if (!st.current.speaking) break;
        if (blob) await play(URL.createObjectURL(blob));
      }
      return finished();
    }
    const lang = turkish(text) ? "tr-TR" : "en-US";
    if (APP) {
      window.atcSpeechDone = finished;
      APP.speak(text, lang);
      return;
    }
    const parts = sentences(text);
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-").startsWith(lang.slice(0, 2)));
    const voice = voices.find((v) => /premium|enhanced|natural|siri/i.test(v.name)) || voices.find((v) => v.localService) || voices[0] || null;
    parts.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = lang;
      u.voice = voice;
      if (i === parts.length - 1) u.onend = finished;
      u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") finished(); };
      speechSynthesis.speak(u);
    });
  };

  const opening = (full) => {
    const all = sentences(speakable(full));
    return all.length > 6 ? all.slice(0, 6).join(" ") + " There's more in the transcript." : all.join(" ");
  };
  const condensed = (full) =>
    api("/api/voice/condense", { method: "POST", body: { text: full } }).then((r) => speakable(r.text), () => opening(full));
  const loadTurns = async () => {
    const p = await api(`/api/sessions/${live.current.s.sessionId}/transcript`).catch(() => ({ messages: [] }));
    st.current.turns = turnsOf(p.messages || []);
    return st.current.turns;
  };
  const readTurn = async (i, how) => {
    const turns = st.current.turns.length ? st.current.turns : await loadTurns();
    if (i < 0 || i >= turns.length) return speak(i < 0 ? "That was the first reply." : "Nothing newer.");
    st.current.at = i;
    speak(how === "full" ? speakable(turns[i]) : how === "short" ? await condensed(turns[i]) : opening(turns[i]));
  };
  const current = () => (st.current.at >= 0 ? st.current.at : st.current.turns.length - 1);
  const replay = () => (spoken ? speak(spoken) : readLatest());
  const readLatest = async () => { await loadTurns(); readTurn(st.current.turns.length - 1); };
  const earlier = () => readTurn((st.current.at >= 0 ? st.current.at : st.current.turns.length) - 1);
  const full = () => readTurn(current(), "full");
  const short = () => readTurn(current(), "short");

  const answer = async (state) => {
    const turns = await loadTurns();
    st.current.at = turns.length - 1;
    const body = turns.length ? opening(turns[turns.length - 1]) : "";
    st.current.permission = state === "needs-you";
    const ask = state === "needs-you" ? `It needs you${live.current.s.activity ? `, to run ${live.current.s.activity}` : ""}. Say yes to allow it.` : "";
    speak([body, ask].filter(Boolean).join(" ") || "Done.");
  };

  const heardSpeech = async (audio) => {
    if (st.current.speaking && !live.current.bargeIn) return;
    setPhase("thinking");
    let text = "";
    try {
      const res = await fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: vad.utils.encodeWAV(audio) });
      if (!res.ok) throw new Error((await res.text()).trim());
      text = (await res.json()).text.trim();
    } catch (e) {
      say(`Could not transcribe: ${e.message}`);
    }
    if (!text || PHANTOM.test(text)) return rest();
    setHeard(text);
    const bare = text.toLowerCase().replace(/[.!?,]/g, "").trim();
    if (/^(stop|cancel|dur|durdur|iptal|bekle)$/.test(bare)) { send("\x1b"); st.current.awaiting = false; return rest(); }
    if (/^(repeat|again|say (that|it) again|tekrar|tekrarla|bir daha)$/.test(bare)) return replay();
    if (/^(read (it )?all|read the whole (thing|reply)|full|hepsini oku|tamamını oku|tamamı)$/.test(bare)) return full();
    if (/^(previous|earlier|go back|önceki|öncekini oku|geri)$/.test(bare)) return earlier();
    if (st.current.permission && /^(yes|yeah|yep|evet|tamam|olur|okay|ok)\b/.test(bare)) { st.current.permission = false; send("\r"); st.current.awaiting = true; st.current.sentAt = Date.now(); return rest(); }
    send(text);
    setTimeout(() => send("\r"), 150);
    st.current.awaiting = true;
    st.current.sentAt = Date.now();
    setPhase("waiting");
  };

  useEffect(() => {
    if (!st.current.awaiting || s.state === "working") return;
    if (Date.parse(s.promptAt || 0) < st.current.sentAt - 5000) return;
    st.current.awaiting = false;
    answer(s.state);
  }, [s.state, s.promptAt, s.updated]);

  useEffect(() => {
    let dead = false, lock = null;
    if (!APP) speechSynthesis.getVoices();
    (async () => {
      try {
        await loadScript("vendor/vad/ort.wasm.min.js");
        await loadScript("vendor/vad/vad.bundle.min.js");
        const v = await vad.MicVAD.new({
          baseAssetPath: new URL("vendor/vad/", location.href).href,
          onnxWASMBasePath: new URL("vendor/vad/", location.href).href,
          ortConfig: (ort) => { ort.env.wasm.numThreads = 1; ort.env.logLevel = "error"; },
          positiveSpeechThreshold: 0.6,
          negativeSpeechThreshold: 0.4,
          redemptionMs: 1300,
          minSpeechMs: 300,
          getStream: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
          onSpeechStart: () => {
            if (st.current.speaking) { if (!live.current.bargeIn) return; stopSpeaking(); }
            setPhase("hearing");
          },
          onVADMisfire: () => { if (!st.current.speaking) rest(); },
          onSpeechEnd: heardSpeech,
        });
        if (dead) return v.destroy();
        st.current.vad = v;
        v.start();
        setPhase("listening");
        if (APP) APP.keepScreenOn(true);
        else lock = await navigator.wakeLock?.request("screen").catch(() => null);
      } catch (e) {
        setPhase("error");
        say(e.name === "NotAllowedError" ? "Allow the microphone to use voice." : `Voice failed to start: ${e.message}`);
      }
    })();
    return () => { dead = true; st.current.vad?.destroy(); stopSpeaking(); lock?.release?.(); APP?.keepScreenOn(false); };
  }, []);

  const tapMic = () => {
    if (phase === "speaking") { stopSpeaking(); return rest(); }
    const m = !muted;
    setMuted(m);
    live.current.muted = m;
    listen(!m);
    setPhase(m ? "muted" : st.current.awaiting ? "waiting" : "listening");
  };
  const pick = (v) => { setSource(v); setPref("atc.voicesrc", v); };
  const toggleBarge = () => { setBargeIn(!bargeIn); setPref("atc.bargein", bargeIn ? "off" : "on"); };

  return html`
    <div class="voicebar" role="region" aria-label="Voice">
      <div class="vtext" aria-live="polite">
        ${heard && html`<div class="vline"><b>You</b> ${heard}</div>`}
        ${spoken && html`<div class="vline said"><b>Claude</b> ${spoken}</div>`}
        ${!heard && !spoken && html`<div class="vline">Say what you want Claude to do. It answers out loud when it is done.</div>`}
      </div>
      <div class="vrow">
        <div class="vside">
          <button class="vbtn" onClick=${replay} title="Read the last reply again (or say “repeat”)">Replay</button>
          <button class="vbtn" onClick=${earlier} title="Read the reply before (or say “previous”)">Earlier</button>
          <button class="vbtn" onClick=${full} title="Read the whole reply (or say “read it all”)">Full</button>
          ${VOICE.condense && html`<button class="vbtn" onClick=${short} title="A one or two sentence summary of the reply, written by the server's model">Short</button>`}
        </div>
        <div class="vmain">
          <button class="mic ${phase} ${muted ? "off" : ""}" onClick=${tapMic} aria-pressed=${!muted}
            aria-label=${phase === "speaking" ? "Stop speaking" : muted ? "Unmute microphone" : "Mute microphone"}>
            ${phase === "speaking" ? STOP : muted ? MIC_OFF : MIC}
          </button>
          <div class="vphase">${PHASE[phase]}</div>
        </div>
        <div class="vside right">
          ${phase === "waiting" && html`<button class="vbtn" onClick=${() => send("\x1b")} title="Send Esc to Claude (or say “stop”)">Stop Claude</button>`}
          ${VOICE.tts && html`<div class="seg">
            <button class=${source === "device" ? "on" : ""} onClick=${() => pick("device")} title="This device's built-in voice: instant">Device</button>
            <button class=${source === "mine" ? "on" : ""} onClick=${() => pick("mine")} title="The server's voice: slower">Server</button>
          </div>`}
          <button class="vbtn ${bargeIn ? "on" : ""}" onClick=${toggleBarge} aria-pressed=${bargeIn}
            title="Talking over a reply stops it. Use with headphones: through a speaker, its own sound cuts it off.">Talk over replies</button>
          <button class="icon" onClick=${onClose} aria-label="Turn voice off">✕</button>
        </div>
      </div>
    </div>
  `;
}

const tokens = (n) => {
  n = n || 0;
  for (const [d, u] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) if (n >= d) return `${(n / d).toFixed(n >= d * 10 ? 0 : 1)}${u}`;
  return String(n);
};
const dollars = (c) => (c > 0 && c < 0.01 ? "<$0.01" : c >= 100 ? `$${Math.round(c).toLocaleString("en-US")}` : `$${(c || 0).toFixed(2)}`);
const span = (sec) => {
  const m = Math.round(sec / 60), h = Math.floor(m / 60);
  return sec < 60 ? `${Math.max(0, Math.round(sec))}s` : m < 60 ? `${m}m` : h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const resetText = (at) => {
  const t = Date.parse(at);
  if (!t) return "";
  const d = (t - Date.now()) / 1000;
  const when = new Date(t).toLocaleString([], d < 20 * 3600 ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d <= 0 ? "Resetting now" : `Resets in ${span(d)}, ${when}`;
};
const level = (p) => (p >= 90 ? "high" : p >= 75 ? "warn" : "");
const Meter = ({ p }) => html`<span class="meter ${level(p)}"><i style=${`width: ${Math.min(100, Math.max(0, p))}%`}></i></span>`;
const SHORT = { session: "Session", weekly_all: "Week" };
const modelName = (m) => {
  const n = m.replace(/^claude-/, "").replace(/-(\d+)-(\d{1,2})(-\d{8})?$/, " $1.$2").replace(/-(\d+)(-\d{8})?$/, " $1");
  return n[0].toUpperCase() + n.slice(1);
};

let WEEK = null, weekAt = 0, weekLoading = null;
function loadWeek() {
  if (Date.now() - weekAt < 120000) return Promise.resolve(WEEK);
  return (weekLoading ||= api("/api/usage/week").then((w) => { WEEK = w; weekAt = Date.now(); return w; }, () => WEEK).finally(() => (weekLoading = null)));
}
const weekShare = (use, week) => (week?.total > 0 && use?.weekCost != null ? (use.weekCost / week.total) * week.percent : null);
const pct = (x) => (x < 0.1 ? "<0.1%" : x < 10 ? `${x.toFixed(1)}%` : `${Math.round(x)}%`);
const resetDay = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

function useSessionUsage(s, every) {
  const [data, setData] = useState(null);
  useEffect(() => setData(null), [s.sessionId]);
  useEffect(() => {
    let live = true;
    const load = () => loadWeek().then((w) => api(`/api/sessions/${s.sessionId}/usage${w?.from ? `?from=${Math.floor(Date.parse(w.from) / 1000)}` : ""}`))
      .then((d) => live && setData({ ...d, week: WEEK }), () => live && setData((d) => d || { failed: true }));
    load();
    const t = setInterval(load, every);
    return () => { live = false; clearInterval(t); };
  }, [s.sessionId, every]);
  return data;
}

function UsageFoot({ limits, onOpen }) {
  useNow(60000);
  const ws = (limits?.windows || []).filter((w) => SHORT[w.key]);
  const sess = ws.find((w) => w.key === "session");
  return html`
    <button class="usefoot" onClick=${onOpen} title="Usage and limits (u)">
      ${ws.length
        ? ws.map((w) => html`<span class="mini"><span class="k">${SHORT[w.key]}</span><${Meter} p=${w.percent} /><span class="v">${Math.round(w.percent)}%</span></span>`)
        : html`<span class="k">Usage</span>`}
      <span class="grow"></span>
      ${sess && Date.parse(sess.resetsAt) > Date.now() && html`<span class="r">resets in ${span((Date.parse(sess.resetsAt) - Date.now()) / 1000)}</span>`}
    </button>`;
}

function Sheet({ cls, title, sub, onClose, children }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return html`
    <div class="veil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet ${cls}" role="dialog" aria-label=${title}>
        <header class="uhead">
          <div class="who"><h3>${title}</h3>${sub && html`<div class="sub">${sub}</div>`}</div>
          <button class="icon" onClick=${onClose} aria-label="Close">✕</button>
        </header>
        ${children}
      </div>
    </div>`;
}

const ESTIMATE = (asOf) => `Estimated from the transcripts at Claude API list prices${asOf ? ` (${asOf})` : ""}. A Claude subscription is not billed per token; this shows what the same work would cost on the API.`;

function UsageSheet({ limits, multi, onClose }) {
  const [days, setDays] = useState(null);
  const [at, setAt] = useState(null);
  useEffect(() => { api("/api/usage/days?days=14").then(setDays, () => setDays([])); }, []);
  const ws = limits?.windows || [];
  const src = !limits ? "Checking…"
    : limits.source === "live" ? `Checked ${agoLong(limits.fetchedAt)} with your Claude account.`
    : limits.source === "cached" ? `Not current: from Claude Code's last check, ${agoLong(limits.fetchedAt)}.` : "";
  const top = Math.max(...(days || []).map((d) => d.cost), 0.01);
  const pick = days && days[at ?? days.length - 1];
  const sum = (days || []).reduce((a, d) => ({ total: a.total + d.total, cost: a.cost + d.cost }), { total: 0, cost: 0 });
  return html`
    <${Sheet} cls="usage" title="Usage" sub=${limits?.plan && `${limits.plan} plan`} onClose=${onClose}>
      <section>
        <h4>Plan limits</h4>
        ${ws.map((w) => html`
          <div class="win">
            <div class="wl"><span>${w.label}</span><span class="pct">${Math.round(w.percent)}%</span></div>
            <${Meter} p=${w.percent} />
            <div class="wr">${resetText(w.resetsAt)}</div>
          </div>`)}
        ${limits && !ws.length && html`<p class="note">Limits are not available here${limits.error ? `: ${limits.error}` : "."}</p>`}
        <p class="note">${src}${ws.length && limits?.error ? ` ${limits.error}.` : ""}</p>
      </section>
      <section>
        <h4>By day${multi ? ", all machines" : ""}</h4>
        ${!days ? html`<p class="note">Adding up transcripts…</p>` : html`
          <div class="readout">
            ${pick && html`<b>${new Date(pick.day + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</b>
              <span>${pick.total ? `${tokens(pick.total)} tokens · ~${dollars(pick.cost)} · ${pick.sessions} session${pick.sessions === 1 ? "" : "s"}` : "No usage"}</span>`}
          </div>
          <div class="bars" onPointerLeave=${() => setAt(null)}>
            ${days.map((d, i) => html`
              <button class="bar ${i === (at ?? days.length - 1) ? "on" : ""}" onPointerEnter=${() => setAt(i)} onFocus=${() => setAt(i)} onClick=${() => setAt(i)}
                aria-label=${`${d.day}: ${tokens(d.total)} tokens, about ${dollars(d.cost)}`}>
                <i style=${`height: ${d.cost > 0 ? Math.max(3, (d.cost / top) * 100) : 0}%`}></i>
                <span>${+d.day.slice(8)}</span>
              </button>`)}
          </div>
          <p class="total">Last ${days.length} days: <b>${tokens(sum.total)} tokens</b> · <b>~${dollars(sum.cost)}</b></p>
          <p class="note">${ESTIMATE()}</p>`}
      </section>
    <//>`;
}

function SessionUsage({ s, use, onClose }) {
  const sub = use?.subagents;
  const rows = use && !use.failed && [
    ["Input", tokens(use.input)], ["Output", tokens(use.output)], ["Cache reads", tokens(use.cacheRead)], ["Cache writes", tokens(use.cacheWrite)],
    ["Turns", use.turns], ["Tool calls", use.toolCalls],
    ["Subagents", sub.count ? `${sub.count} · ${tokens(sub.total)} tokens · ~${dollars(sub.cost)}` : "none"],
    ["Wall time", use.start ? `${span(use.wallSeconds)}, since ${new Date(use.start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "n/a"],
  ];
  return html`
    <${Sheet} cls="usage" title="Usage" sub=${s.title} onClose=${onClose}>
      ${!use ? html`<p class="note">Reading the transcript…</p>` : use.failed ? html`<p class="note">Couldn't read this session's usage.</p>` : html`
        <div class="tiles">
          ${weekShare(use, use.week) != null && html`<div><span class="n">≈${pct(weekShare(use, use.week))}</span><span class="l">of this week's limit</span></div>`}
          <div><span class="n">${tokens(use.total)}</span><span class="l">tokens</span></div>
          <div><span class="n">${span(use.activeSeconds)}</span><span class="l">Claude working</span></div>
        </div>
        <p class="quiet">~${dollars(use.cost)} at API prices${use.week?.percent != null ? ` · the week is at ${Math.round(use.week.percent)}%, resets ${resetDay(use.week.resetsAt)}` : ""}</p>
        <dl class="facts">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        ${use.models?.length > 0 && html`
          <h4>Models</h4>
          <dl class="facts">${use.models.map((m) => html`<dt>${modelName(m.model)}</dt><dd>${tokens(m.total)} tokens · ~${dollars(m.cost)} · ${m.messages} replies</dd>`)}</dl>`}
        <p class="note">The share of your weekly limit is an estimate: this session's part of everything you used since the week started, applied to the week's current percentage. ${ESTIMATE(use.pricesAsOf)}${use.unpriced?.length ? ` No price known for ${use.unpriced.join(", ")}, so it counts as $0.` : ""} Working time adds up the gaps between messages in each turn, at most 10 minutes per gap.</p>`}
    <//>`;
}

const serverURL = (s, port) => `http://${s.host || location.hostname}:${port}/`;

function openOut(url) {
  const abs = new URL(url, location.href).href;
  if (APP?.openExternal) return APP.openExternal(abs);
  if (APP && new URL(abs).host !== location.host) return void (location.href = abs);
  window.open(abs, "_blank", "noopener");
}

function useOutputs(s, every) {
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
  }, [s.sessionId]);
  useEffect(() => {
    let live = true;
    const load = () => api(`/api/sessions/${s.sessionId}/outputs`).then(
      (d) => live && setData({ servers: d.servers || [], links: d.links || [], files: d.files || [] }),
      () => live && setData((d) => d || { servers: [], links: [], files: [], failed: true }));
    load();
    const t = setInterval(load, every);
    return () => { live = false; clearInterval(t); };
  }, [s.sessionId, every]);
  return data;
}

const agoLong = (at) => { const a = ago({ updated: at }); return a === "now" ? "just now" : a ? `${a} ago` : ""; };
const KIND_LABEL = { table: "Table", image: "Image", html: "Page", markdown: "Notes", pdf: "PDF", video: "Video", audio: "Audio", text: "File" };
const baseName = (p) => p.split("/").pop();
const dirName = (p) => tilde(p.slice(0, p.lastIndexOf("/")) || "/");

function Outputs({ s, data }) {
  const [open, setOpen] = useState(null);
  if (!data) return html`<div class="outputs"><p class="empty">Looking through this session…</p></div>`;
  const made = data.files.filter((f) => f.kind !== "text");
  const code = data.files.filter((f) => f.kind === "text");
  const viewable = [...made, ...code];
  const nothing = !data.servers.length && !data.links.length && !data.files.length;
  return html`
    <div class="outputs">
      <div class="inner">
        ${nothing && html`<div class="none">
          <p>${data.failed ? "Couldn't read this session's outputs." : "Nothing here yet."}</p>
          <p class="sub">Files this session writes, pages it publishes and servers it starts show up here as it works.</p>
        </div>`}
        ${data.servers.length > 0 && html`
          <section>
            <h4>Running</h4>
            ${data.servers.map((v) => html`
              <button class="srvrow" onClick=${() => openOut(v.url)}>
                <i class="dot"></i>
                <span class="u">${v.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
                <span class="note">${v.localOnly ? `Listens on localhost only, so it opens on ${s.host || "that machine"} itself, not here.` : "Started by this session"}</span>
              </button>`)}
          </section>`}
        ${made.length > 0 && html`
          <section>
            <h4>Files</h4>
            <div class="cards">
              ${made.map((f) => html`<${OutCard} f=${f} onOpen=${() => setOpen(viewable.indexOf(f))} />`)}
            </div>
          </section>`}
        ${data.links.length > 0 && html`
          <section>
            <h4>Links</h4>
            ${data.links.map((l) => {
              const u = new URL(l.url);
              return html`<button class="linkrow" onClick=${() => openOut(l.url)}>
                <span class="h">${u.host}</span><span class="p">${(u.pathname + u.search).replace(/^\/$/, "")}</span>
                <span class="when">${ago({ updated: l.at })}</span>
              </button>`;
            })}
          </section>`}
        ${code.length > 0 && html`
          <section>
            <h4>Code it touched</h4>
            ${code.map((f) => html`<button class="coderow" onClick=${() => setOpen(viewable.indexOf(f))}>
              <span class="n">${baseName(f.path)}</span><span class="d">${dirName(f.path)}</span>
              <span class="op">${f.op} ${agoLong(f.at)}</span>
            </button>`)}
          </section>`}
      </div>
    </div>
    ${open !== null && viewable[open] && html`<${Viewer} list=${viewable} at=${open} setAt=${setOpen} onClose=${() => setOpen(null)} />`}
  `;
}

function OutCard({ f, onOpen }) {
  const ext = (baseName(f.path).split(".").pop() || "").slice(0, 4);
  return html`
    <button class="card ${f.kind}" onClick=${onOpen} title=${tilde(f.path)}>
      <div class="pv">
        ${f.kind === "image" ? html`<img loading="lazy" src=${f.url} alt="" />`
          : f.kind === "html" ? html`<iframe src=${f.url} sandbox="allow-scripts" loading="lazy" tabindex="-1" aria-hidden="true"></iframe>`
          : f.kind === "video" ? html`<video src=${f.url} preload="metadata" muted></video>`
          : html`<span class="ext">${ext}</span>`}
      </div>
      <div class="cap">
        <span class="n">${baseName(f.path)}</span>
        <span class="m">${KIND_LABEL[f.kind]}${f.size ? ` · ${fileSize(f.size)}` : ""} · ${f.op} ${agoLong(f.at)}</span>
      </div>
    </button>`;
}

function Viewer({ list, at, setAt, onClose }) {
  const f = list[at];
  const [text, setText] = useState(null);
  useEffect(() => {
    setText(null);
    if (f.kind !== "markdown" && f.kind !== "text" && f.kind !== "table") return;
    if (f.size > 2 << 20) return setText({ big: true });
    fetch(f.url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status === 410 ? "This link expired. Close and reopen." : r.statusText))))
      .then((t) => setText({ t }), (e) => setText({ err: e.message }));
  }, [f.url]);
  useEffect(() => {
    const k = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && at < list.length - 1) setAt(at + 1);
      else if (e.key === "ArrowLeft" && at > 0) setAt(at - 1);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, [at, list.length]);
  const pdfInline = f.kind === "pdf" && !APP;
  return html`
    <div class="viewer" role="dialog" aria-label=${baseName(f.path)}>
      <header>
        <button class="icon" onClick=${onClose} aria-label="Close">✕</button>
        <div class="who"><div class="n">${baseName(f.path)}</div><div class="d">${dirName(f.path)}</div></div>
        <button class="icon" disabled=${at === 0} onClick=${() => setAt(at - 1)} aria-label="Previous">‹</button>
        <button class="icon" disabled=${at === list.length - 1} onClick=${() => setAt(at + 1)} aria-label="Next">›</button>
        <button class="btn" onClick=${() => openOut(f.url)}>${APP ? "Open outside" : "New tab"}</button>
      </header>
      <div class="body ${f.kind}">
        ${f.kind === "image" ? html`<img src=${f.url} alt=${baseName(f.path)} />`
          : f.kind === "html" ? html`<iframe src=${f.url} sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>`
          : f.kind === "video" ? html`<video src=${f.url} controls autoplay playsinline></video>`
          : f.kind === "audio" ? html`<audio src=${f.url} controls autoplay></audio>`
          : pdfInline ? html`<iframe src=${f.url}></iframe>`
          : f.kind === "pdf" ? html`<div class="none"><p>PDFs open in your browser.</p><button class="btn primary" onClick=${() => openOut(f.url)}>Open PDF</button></div>`
          : !text ? html`<p class="empty">Loading…</p>`
          : text.big ? html`<div class="none"><p>Too large to show here.</p><button class="btn" onClick=${() => openOut(f.url)}>Open it</button></div>`
          : text.err ? html`<p class="empty">${text.err}</p>`
          : f.kind === "markdown" ? html`<article class="md">${md(text.t)}</article>`
          : f.kind === "table" ? html`<${Table} text=${text.t} tsv=${f.path.endsWith(".tsv")} />`
          : html`<pre class="code">${text.t}</pre>`}
      </div>
    </div>`;
}

function parseRows(text, sep) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length && rows.length < 1001; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function Table({ text, tsv }) {
  const rows = useMemo(() => parseRows(text, tsv ? "\t" : ","), [text]);
  const [head, ...body] = rows;
  const num = (head || []).map((_, j) => body.slice(0, 50).every((r) => r[j] === undefined || r[j] === "" || !isNaN(+r[j])));
  return html`
    <div class="tablewrap">
      <table class="data">
        <thead><tr>${(head || []).map((h) => html`<th>${h}</th>`)}</tr></thead>
        <tbody>${body.slice(0, 1000).map((r) => html`<tr>${r.map((c, j) => html`<td class=${num[j] ? "n" : ""}>${c}</td>`)}</tr>`)}</tbody>
      </table>
      ${rows.length > 1000 && html`<p class="empty">Showing the first 1,000 rows.</p>`}
    </div>`;
}

function Transcript({ s }) {
  const [msgs, setMsgs] = useState(null);
  const [start, setStart] = useState(0);
  const [err, setErr] = useState(null);
  const ref = useRef();
  const atEnd = useRef(true);

  const load = async (before) => {
    try {
      const p = await api(`/api/sessions/${s.sessionId}/transcript${before ? `?before=${before}` : ""}`);
      setStart(p.start);
      setMsgs((m) => (before ? [...(p.messages || []), ...(m || [])] : p.messages || []));
    } catch (e) {
      setErr(e.message);
    }
  };
  useEffect(() => { load(0); }, [s.sessionId, s.updated]);
  useEffect(() => {
    const el = ref.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  return html`
    <div class="chat" ref=${ref} onScroll=${(e) => { const el = e.target; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div class="inner">
        ${err && html`<p class="err">${err}</p>`}
        ${start > 0 && html`<button class="btn more" onClick=${() => { atEnd.current = false; load(start); }}>Load earlier messages</button>`}
        ${msgs && msgs.length === 0 && html`<p class="empty">No messages yet.</p>`}
        ${grouped(msgs || []).map((m) =>
          m.role === "tools"
            ? html`<${Steps} steps=${m.steps} />`
            : m.role === "user"
              ? html`<div class="msg user">${m.text}</div>`
              : html`<div class="msg assistant" dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div>`
        )}
      </div>
    </div>
  `;
}

const grouped = (msgs) =>
  msgs.reduce((out, m) => {
    const last = out[out.length - 1];
    if (m.role !== "tool") out.push(m);
    else if (last?.role === "tools") last.steps.push(m);
    else out.push({ role: "tools", steps: [m] });
    return out;
  }, []);

const STEP = [
  [/^Bash$/, "ran", "command", "commands"],
  [/^Read$/, "read", "file", "files"],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, "edited", "file", "files"],
  [/^(Grep|Glob)$/, "searched", "time", "times"],
  [/^(WebFetch|WebSearch)$/, "looked up", "page", "pages"],
  [/^(Agent|Task)$/, "ran", "agent", "agents"],
];

function stepSummary(steps) {
  const counts = new Map();
  for (const st of steps) {
    const kind = STEP.find(([re]) => re.test(st.tool));
    const key = kind ? `${kind[1]}|${kind[2]}|${kind[3]}` : `used|${st.tool}|${st.tool}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const parts = [...counts].map(([key, n]) => {
    const [verb, one, many] = key.split("|");
    return verb === "used" ? `used ${one}${n > 1 ? ` ×${n}` : ""}` : `${verb} ${n} ${n === 1 ? one : many}`;
  });
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}

function Steps({ steps }) {
  const [open, setOpen] = useState(false);
  return html`
    <div class="steps ${open ? "open" : ""}">
      <button class="steps-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <span class="caret">${open ? "▾" : "▸"}</span>${stepSummary(steps)}
      </button>
      ${open && steps.map((st) => html`<div class="tool"><b>${st.tool}</b><span>${st.detail}</span></div>`)}
    </div>
  `;
}

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function md(src) {
  const out = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(l)) {
      const n = Math.min(3, l.match(/^#+/)[0].length);
      out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ""))}</h${n}>`);
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>`);
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (/^\|.*\|\s*$/.test(l)) {
      const rows = [];
      for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) if (!/^\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i]);
      out.push(`<table>${rows.map((r, k) => `<tr>${r.slice(1, -1).split("|").map((c) => `<${k ? "td" : "th"}>${inline(c.trim())}</${k ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`);
    } else if (!l.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s|\|)/.test(lines[i]); i++) para.push(lines[i]);
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
  }
  return out.join("");
}

function useDirs(host, home) {
  const [dirs, setDirs] = useState([]);
  useEffect(() => { api(`/api/dirs${hostQ(host, home)}`).then((d) => setDirs(d || []), () => setDirs([])); }, [host]);
  return dirs;
}

const hostQ = (host, home) => (host && host !== home ? `?host=${encodeURIComponent(host)}` : "");

function FolderField({ dirs, dir, setDir, note, autofocus }) {
  const shown = useMemo(() => {
    const q = dir.toLowerCase();
    return dirs.filter((d) => !q || tilde(d.path).toLowerCase().includes(q.replace(/^~/, "")) || d.path.toLowerCase().includes(q)).slice(0, 40);
  }, [dir, dirs]);
  return html`
    <label class="field">
      <span>Folder${note && html` <em class="note">${note}</em>`}</span>
      <input value=${dir} onInput=${(e) => setDir(e.target.value, true)} placeholder="~/projects/app" autofocus=${autofocus} autocapitalize="off" autocomplete="off" spellcheck="false" />
      <div class="dirs">
        ${shown.map((d) => html`<button type="button" class=${tilde(d.path) === dir ? "on" : ""} onClick=${() => setDir(tilde(d.path), true)}>${tilde(d.path)}${d.recent && html`<span class="r">recent</span>`}</button>`)}
        ${shown.length === 0 && html`<p class="empty" style="padding: 10px">No match. A full path works too.</p>`}
      </div>
    </label>`;
}

function WorktreeField({ dirs, dir, on, setOn }) {
  const d = dirs.find((d) => tilde(d.path) === dir.trim() || d.path === dir.trim());
  if (!d?.git) return null;
  return html`
    <label class="check">
      <input type="checkbox" checked=${on} onChange=${(e) => setOn(e.target.checked)} />
      <span>Work in its own git worktree<small>A separate checkout on a new branch, so it can't clash with other sessions in this repo.</small></span>
    </label>`;
}

function HostField({ hosts, host, setHost }) {
  if (hosts.length < 2) return null;
  return html`
    <div class="field"><span>Machine</span>
      <div class="seg">${hosts.map((h) => html`<button type="button" class=${h === host ? "on" : ""} onClick=${() => setHost(h)}>${h}</button>`)}</div>
    </div>`;
}

const untrusted = "Claude Code hasn't been trusted in this folder yet. Open Claude there once and accept the prompt, then try again.";

function NewSession({ onClose, say, hosts, home }) {
  const [host, setHost] = useState(home);
  const dirs = useDirs(host, home);
  const [dir, setDir] = useState("~");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [presets, setPresets] = useState([]);
  const [preset, setPreset] = useState(null);
  useEffect(() => { api("/api/presets").then((p) => setPresets(p || []), () => {}); }, []);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const f = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);

  const start = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = preset
        ? await api(`/api/sessions${hostQ(preset.host, home)}`, { method: "POST", body: { preset: preset.name, name: name.trim(), prompt } })
        : await api(`/api/sessions${hostQ(host, home)}`, { method: "POST", body: { dir: dir.trim(), name: name.trim(), prompt, worktree } });
      onClose();
      say("Session started.");
      go(r.id);
    } catch (e) {
      setErr(e.status === 409 ? untrusted : e.message);
    }
    setBusy(false);
  };

  return html`
    <div class="veil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <form class="sheet" onSubmit=${start}>
        <h3>New session</h3>
        ${presets.length > 0 && html`
          <div class="field"><span>Presets</span>
            <div class="presets">
              ${presets.map((p) => html`<button type="button" class=${preset === p ? "on" : ""} onClick=${() => setPreset(preset === p ? null : p)}>
                <span class="proj" style=${`--ph: ${hueOf(p.name)}`}>${p.name}</span>
                <small>${MULTI && p.host ? `${p.host} · ` : ""}${tilde(p.dir)}</small>
              </button>`)}
            </div>
          </div>`}
        ${preset ? html`
          <p class="presetnote">Starts in <b>${tilde(preset.dir)}</b>${MULTI && preset.host ? html` on <b>${preset.host}</b>` : ""}${preset.brief ? html`, with the instructions in <b>${preset.brief}</b>` : ""}.</p>
        ` : html`
          <${HostField} hosts=${hosts} host=${host} setHost=${(h) => { setHost(h); setDir("~"); }} />
          <${FolderField} dirs=${dirs} dir=${dir} setDir=${setDir} autofocus />
          <${WorktreeField} dirs=${dirs} dir=${dir} on=${worktree} setOn=${setWorktree} />`}
        <label class="field"><span>Name</span><input value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${preset ? preset.name : "Optional"} />${!preset && html`<small>Without one, Claude titles the session from what you ask.</small>`}</label>
        <label class="field"><span>First message</span><textarea rows="3" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder="Optional. You can also type it in the terminal."></textarea></label>
        ${err && html`<p class="err">${err}</p>`}
        <div class="actions">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn primary" disabled=${(!preset && !dir.trim()) || busy}>${busy ? "Starting…" : "Start session"}</button>
        </div>
      </form>
    </div>
  `;
}

function readShared() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  let got = null;
  try { got = APP?.shared && JSON.parse(APP.shared() || "null"); } catch {}
  return { text: [q.get("title"), q.get("text"), q.get("url")].filter(Boolean).join("\n"), files: [], ...got, to: q.get("to") };
}

const fileSize = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Share({ live, hosts, home, say }) {
  const shared = useMemo(readShared, []);
  const [text, setText] = useState(() => {
    const t = (shared.text || "").trim(), sub = (shared.subject || "").trim();
    return sub && !t.includes(sub) ? `${sub}\n${t}`.trim() : t;
  });
  const [files, setFiles] = useState(shared.files || []);
  const [ask, setAsk] = useState("");
  const running = (live || []).filter((s) => s.attachable && !s.parked);
  const [to, setTo] = useState(shared.to ? "running" : "new");
  const [target, setTarget] = useState(null);
  useEffect(() => {
    if (shared.to && !target) setTarget(running.find((s) => s.sessionId === shared.to) || null);
  }, [live]);
  const [host, setHost] = useState(home);
  const dirs = useDirs(host, home);
  const [dir, setDirRaw] = useState("~");
  const [picked, setPicked] = useState(false);
  const [note, setNote] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const setDir = (d, byHand) => { setDirRaw(d); if (byHand) { setPicked(true); setNote(""); } };

  const about = [ask, text, ...files.map((f) => f.name)].join("\n");
  useEffect(() => {
    if (picked || to !== "new") return;
    const t = setTimeout(() => {
      api(`/api/guess${hostQ(host, home)}`, { method: "POST", body: { text: about } }).then((r) => {
        if (picked) return;
        if (r.dir) { setDirRaw(tilde(r.dir)); setNote("suggested"); }
        else { setDirRaw("~"); setNote(""); }
      }, () => {});
    }, ask ? 900 : 0);
    return () => clearTimeout(t);
  }, [about, host, picked, to]);

  const close = (id) => { APP?.clearShared?.(); id ? go(id) : go(null); };
  const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const paths = [];
      for (const f of files) {
        const blob = await (await fetch(f.url)).blob();
        const fd = new FormData();
        fd.append("file", blob, f.name);
        const res = await fetch(to === "new" ? `/api/uploads${hostQ(host, home)}` : `/api/sessions/${target.sessionId}/upload`, { method: "POST", body: fd });
        if (!res.ok) throw new Error(`Uploading ${f.name} failed: ${(await res.text()).trim() || res.statusText}`);
        paths.push((await res.json()).path);
      }
      const prompt = [ask.trim(), text.trim(), paths.map(quote).join("\n")].filter(Boolean).join("\n\n");
      if (to === "new") {
        const r = await api(`/api/sessions${hostQ(host, home)}`, { method: "POST", body: { dir: dir.trim(), prompt, worktree } });
        say("Session started.");
        close(r.id);
      } else {
        await api(`/api/sessions/${target.id}/send`, { method: "POST", body: { text: prompt } });
        say(`Sent to ${target.title}.`);
        close(target.id);
      }
    } catch (e) {
      setErr(e.status === 409 ? untrusted : e.message);
    }
    setBusy(false);
  };

  const ready = !busy && (ask.trim() || text.trim() || files.length) && (to === "new" ? dir.trim() : target);
  return html`
    <div class="share">
      <form class="sheet" onSubmit=${send}>
        <h3>Send to Claude</h3>
        ${(text || !files.length) && html`<label class="field"><span>Shared</span><textarea class="shared" rows=${Math.min(6, Math.max(2, text.split("\n").length))} value=${text} onInput=${(e) => setText(e.target.value)} placeholder="Paste or type what this is about"></textarea></label>`}
        ${files.length > 0 && html`
          <div class="files">
            ${files.map((f, i) => html`
              <div class="file">
                ${f.type?.startsWith("image/") ? html`<img src=${f.url} alt="" />` : html`<span class="ext">${(f.name.split(".").pop() || "file").slice(0, 4)}</span>`}
                <span class="nm">${f.name}<small>${fileSize(f.size || 0)}</small></span>
                <button type="button" class="icon" aria-label=${`Remove ${f.name}`} onClick=${() => setFiles(files.filter((_, j) => j !== i))}>✕</button>
              </div>`)}
          </div>`}
        <label class="field"><span>What should Claude do?</span>
          <textarea rows="2" value=${ask} onInput=${(e) => setAsk(e.target.value)} placeholder="Look into this" autofocus></textarea>
        </label>
        <div class="field"><span>Where</span>
          <div class="seg wide">
            <button type="button" class=${to === "new" ? "on" : ""} onClick=${() => setTo("new")}>New session</button>
            <button type="button" class=${to === "running" ? "on" : ""} disabled=${!running.length} onClick=${() => setTo("running")}>Running session</button>
          </div>
        </div>
        ${to === "new" ? html`
          <${HostField} hosts=${hosts} host=${host} setHost=${(h) => { setHost(h); setDirRaw("~"); setPicked(false); }} />
          <${FolderField} dirs=${dirs} dir=${dir} setDir=${setDir} note=${note} />
          <${WorktreeField} dirs=${dirs} dir=${dir} on=${worktree} setOn=${setWorktree} />
        ` : html`
          <div class="targets">
            ${running.map((s) => html`
              <button type="button" class=${target?.sessionId === s.sessionId ? "on" : ""} onClick=${() => setTarget(s)}>
                <i class=${s.state}></i>
                <span class="t">${s.title}<small>${MULTI ? `${s.host} · ` : ""}${tilde(s.cwd)} · ${WORD[s.state] || s.state}</small></span>
              </button>`)}
          </div>`}
        ${err && html`<p class="err">${err}</p>`}
        <div class="actions">
          <button type="button" class="btn" onClick=${() => close()}>Cancel</button>
          <button class="btn primary" disabled=${!ready}>${busy ? "Sending…" : to === "new" ? "Start session" : "Send"}</button>
        </div>
      </form>
    </div>
  `;
}

navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()), () => {});
render(html`<${App} />`, document.getElementById("app"));
