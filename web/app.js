import { html, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "./vendor/preact-htm.js";
import { marked as Marked } from "./vendor/marked.esm.js";
import hljs from "./vendor/highlight.min.js";
import { diffLines } from "./vendor/diff.mjs";

const BAYS = [
  ["needs-you", "Needs you"],
  ["your-turn", "Your turn"],
  ["working", "Working"],
  ["stopped", "Stopped"],
];
const WORD = { "needs-you": "needs you", "your-turn": "your turn", working: "working", stopped: "stopped", past: "earlier" };
const touch = matchMedia("(pointer: coarse)").matches;
const zoomed = () => (window.visualViewport?.scale || 1) > 1.01;
window.visualViewport?.addEventListener("resize", () => document.documentElement.classList.toggle("zoomed", zoomed()));

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
let MULTI = false, HERE = "";
let VOICE = {};
let VOICE_OK = false;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
let PALETTE_OPEN = () => {};
let SESSION_API = null;
let TABS = { only: null, tabs: [], set: () => {} };
const focusOnMount = (el) => { if (el && !el.dataset.focused) { el.dataset.focused = "1"; requestAnimationFrame(() => el.focus({ preventScroll: true })); } };
const local = (m) => !!m && !m.startsWith("claude-") && m !== "<synthetic>";
const model = (m) => (local(m) ? m.split("/").pop().split(":")[0] : (m || "").replace(/^claude-/, "").replace(/-\d.*$/, ""));
const engineTag = (s) => s.harness
  ? html`<span class="eng" title=${`Runs in ${s.harness}${s.model ? ` on ${s.model}` : ""}, not Claude Code`}>${s.engine || s.harness}</span>`
  : (s.engine || local(s.model)) && html`<span class="eng" title=${`Runs on ${s.engine || s.model}, not Claude`}>${s.engine || model(s.model)}</span>`;
const keyOf = (s) => s.id || s.sessionId;
const go = (k) => (location.hash = k ? `#/s/${k}` : "#/");
const USAGE = "#/usage";
let usageBack = false;
const openUsage = () => { if (location.hash !== USAGE) { usageBack = true; location.hash = USAGE; } };
const closeUsage = () => {
  if (location.hash !== USAGE) return;
  usageBack ? history.back() : location.replace("#/");
  usageBack = false;
};

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
let AUTO_VOICE = false, AUTO_PANE = null;
let appSent = "";
const FEED_STATES = ["needs-you", "your-turn", "working"];

function App() {
  const [me, setMe] = useState(undefined);
  const [live, setLive] = useState(null);
  const [up, setUp] = useState(true);
  const [past, setPast] = useState({});
  const [creating, setCreating] = useState(false);
  const [palette, setPalette] = useState(false);
  PALETTE_OPEN = () => setPalette(true);
  const [cursor, setCursor] = useState(null);
  const [quick, setQuick] = useState(null);
  QUICK = (s, rect) => setQuick({ s, rect });
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState(null);
  const [limits, setLimits] = useState(null);
  const route = useRoute();
  const [stale, setStale] = useState(null);
  const [starting, setStarting] = useState(false);
  const [view, setViewRaw] = useState(() => ({ list: "triage", rail: false, ...stored(VIEW, {}) }));
  const setView = (v) => { setViewRaw(v); store(VIEW, v); };
  const wide = useWide();
  const railed = view.rail && !!route && wide;
  const [fly, setFly] = useState(false);
  const flyT = useRef(0);
  const flyIn = (ms) => { clearTimeout(flyT.current); flyT.current = setTimeout(() => setFly(true), ms); };
  const flyOut = (ms) => { clearTimeout(flyT.current); flyT.current = setTimeout(() => setFly(false), ms); };
  useEffect(() => setFly(false), [route]);
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
  const [usage, setUsage] = useState(location.hash === USAGE);
  const shareRoute = () => (location.hash.startsWith("#/share") ? location.hash : null);
  const [sharing, setSharing] = useState(shareRoute);
  useEffect(() => {
    const f = () => { setAssisting(location.hash === "#/assist"); setUsage(location.hash === USAGE); setSharing(shareRoute()); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const talk = async (fresh, voice = true) => {
    setStarting(true);
    try {
      const r = await api(`/api/assist${fresh ? "?new=1" : ""}`, { method: "POST" });
      AUTO_VOICE = voice;
      AUTO_PANE = "chat";
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
      const n = new Notification(x.title || "atc", { body: x.state === "needs-you" ? `Needs you${x.activity ? ": " + x.activity : ""}` : (x.summary?.status || x.lastReply || "Finished its turn"), tag: x.sessionId, icon: "/icon.svg" });
      n.onclick = () => { window.focus(); go(keyOf(x)); n.close(); };
    }
  }, [live]);

  useEffect(() => {
    if (!live) return;
    const x = route && live.find((v) => v.id === route || v.sessionId === route);
    if (!seenMap() || x) markSeen(live, x?.sessionId);
  }, [live, route]);

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
  keys.current = { ordered, route, cursor, creating, list: view.list, fly, setFly };
  useEffect(() => {
    const step = (from, d) => {
      const k = keys.current;
      const shown = [...document.querySelectorAll(".board [data-sid]:not(.row)")].map((el) => k.ordered.find((x) => x.sessionId === el.dataset.sid)).filter(Boolean);
      const list = k.list === "classic" ? k.ordered : [...new Set(shown)];
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
      if (e.key.toLowerCase() === "k" && (MAC ? e.metaKey : e.ctrlKey && !t.closest?.(".xterm")) && !e.altKey && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation(); setPalette((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const move = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
      if (move) {
        const next = step(k.cursor || k.route, move);
        if (next) { e.preventDefault(); setCursor(next.sessionId); document.querySelector(`[data-sid="${next.sessionId}"]`)?.scrollIntoView({ block: "nearest" }); }
      } else if (e.key === "Enter" && k.cursor) {
        e.preventDefault();
        const x = k.ordered.find((x) => x.sessionId === k.cursor);
        if (x) go(keyOf(x));
      } else if (e.key === "a") {
        e.preventDefault(); talk(false, false);
      } else if (e.key === "t" && VOICE_OK) {
        e.preventDefault(); location.hash = "#/assist";
      } else if (e.key === "n") {
        e.preventDefault(); setCreating(true);
      } else if (e.key === "u") {
        e.preventDefault(); location.hash === USAGE ? closeUsage() : openUsage();
      } else if (e.key === "/") {
        e.preventDefault(); document.querySelector('.search input')?.focus();
      } else if (e.key === "?") {
        setHelp((h) => !h);
      } else if (e.key === "Escape") {
        setHelp(false); setCursor(null); closeUsage(); k.setFly(false);
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
  HERE = me.host || "";
  VOICE = me.voice || {};
  VOICE_OK = !!VOICE.stt;
  const down = (me.peers || []).filter((p) => p.error);

  const all = live || [];
  const sel = route && (all.find((s) => s.id === route || s.sessionId === route) || past[route]);
  const remember = (list) => setPast((p) => Object.fromEntries([...Object.entries(p), ...list.map((s) => [s.sessionId, s])]));
  const openFromUsage = async (x) => {
    if (!all.some((s) => s.sessionId === x.sessionId) && !past[x.sessionId])
      remember((await api(`/api/history?q=${encodeURIComponent(x.title)}&limit=50`).catch(() => [])).filter((s) => s.sessionId === x.sessionId));
    go(x.sessionId);
  };

  return html`
    <div class="shell ${route ? "open" : ""} ${railed ? "railed" : ""} ${railed && fly ? "fly" : ""}">
      <aside class="side" onPointerEnter=${railed ? () => fly && clearTimeout(flyT.current) : null} onPointerLeave=${railed ? () => flyOut(350) : null}>
        ${railed && html`<${Rail} live=${all} sel=${sel} onHover=${() => flyIn(180)} onPick=${(name) => { TABS.set(name); clearTimeout(flyT.current); setFly(true); }} />`}
        <div class="sidebody">
        <header class="top">
          <span class="mark">atc</span>
          <span class="host">${me.host ? `on ${(me.hosts || [me.host]).join(" + ")}` : ""}</span>
          <span class="conn ${up ? "" : "down"}" title=${up ? "Live" : "Reconnecting"}></span>
          ${down.length > 0 && html`<span class="tag" title=${down.map((p) => `${p.name}: ${p.error}`).join("\n")}>${down.map((p) => p.name).join(", ")} unreachable</span>`}
          <span class="grow"></span>
          <${Menu} cls="btn talk" aria="List style" width=${230} label=${html`<span class="mi">${ICON.layout}</span>`} items=${[
            ...LISTS.map(([k, label, hint]) => ({ cls: `viewitem ${view.list === k ? "on" : ""}`, title: hint, run: () => setView({ ...view, list: k }), label: html`<span>${label}</span>${view.list === k && "✓"}` })),
            { cls: `viewitem ${view.rail ? "on" : ""}`, title: "While a session is open on a wide screen, the list folds into a strip of projects; hover or click it to bring the list back",
              run: () => setView({ ...view, rail: !view.rail }), label: html`<span>Fold into a rail while reading</span>${view.rail && "✓"}` },
          ]} />
          <button class="btn talk" onClick=${() => setPalette(true)} title=${`Search and commands (${MAC ? "⌘" : "Ctrl+"}K)`} aria-label="Search and commands"><span class="mi">${ICON.search}</span></button>
          <button class="btn talk" onClick=${() => talk(false, false)} title="Assistant: ask about or drive your sessions (a)" aria-label="Assistant"><span class="mi">${ICON.chat}</span></button>
          <button class="btn talk" onClick=${() => setCreating(true)} title="New session (n)" aria-label="New session"><span class="mi">${ICON.plus}</span></button>
        </header>
        <${Board} live=${live} sel=${sel} cursor=${cursor} onPast=${remember} mode=${view.list} />
        <${UsageFoot} limits=${limits} onOpen=${openUsage} />
        </div>
      </aside>
      <main class="main">
        ${sel
          ? html`<${Session} key=${sel.sessionId} s=${sel} say=${say} live=${all} />`
          : html`<div class="blank">${starting || (route && !live) ? "Opening…" : route ? "This session is gone. Pick another from the list." : "Pick a session, or start a new one."}</div>`}
      </main>
    </div>
    ${creating && html`<${NewSession} onClose=${() => setCreating(false)} say=${say} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} home=${me.host} start=${creating} />`}
    ${palette && html`<${Palette} live=${live || []} sel=${sel} say=${say} home=${me.host} onClose=${() => setPalette(false)}
      actions=${{ create: (start) => setCreating(start || true), usage: openUsage, help: () => setHelp(true), talk: () => (location.hash = "#/assist"), ask: () => talk(false, false) }} />`}
    ${sharing && html`<${Share} key=${sharing} live=${live} say=${say} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} home=${me.host} />`}
    ${assisting && html`<${Assist} live=${live} busy=${starting} onTalk=${talk} onOpen=${() => go(null)} />`}
    ${usage && html`<${UsagePage} limits=${limits} multi=${MULTI} onClose=${closeUsage} onOpen=${openFromUsage} />`}
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
            <dt>${MAC ? "⌘" : "Ctrl"} K</dt><dd>Command palette: jump to anything, run any action</dd>
            <dt>n</dt><dd>New session</dd>
            <dt>a</dt><dd>Assistant: ask about or drive your sessions</dd>
            <dt>t</dt><dd>Talk: a voice session with Claude</dd>
            <dt>/</dt><dd>Search earlier sessions</dd>
            <dt>u</dt><dd>Usage: limits, spend by day, projects and sessions</dd>
            <dt>[ / ]</dt><dd>Previous or next project tab</dd>
            <dt>Ctrl + Z</dt><dd>In a terminal: detach. The session keeps running.</dd>
            <dt>1 / 2 / 3</dt><dd>In a transcript: outline, story or everything</dd>
            <dt>r</dt><dd>In a transcript: write to the session</dd>
            <dt>f</dt><dd>In a transcript: find in the session</dd>
            <dt>?</dt><dd>Show or hide this</dd>
          </dl>
        </div>
      </div>`}
  `;
}

const VIEW = "atc.view";
const LISTS = [
  ["triage", "Triage", "What waits on you first, as cards you can answer from; the rest as one-line rows"],
  ["lanes", "Project lanes", "Grouped by project, with each project's recent sessions and a day of activity"],
  ["classic", "Classic", "Cards grouped by state"],
];

function monograms(names) {
  const out = new Map(), used = new Set();
  for (const n of [...names].sort((a, b) => a.length - b.length)) {
    let m = n === "~" ? "~" : n.slice(0, 2);
    if (used.has(m)) m = n[0] + n.at(-1);
    used.add(m);
    out.set(n, m);
  }
  return out;
}

function Rail({ live, sel, onHover, onPick }) {
  const cur = sel && project(sel.cwd).name;
  const tabs = projectTabs(live, cur);
  const mono = monograms(tabs.map((t) => t.name));
  return html`
    <nav class="rail" aria-label="Projects">
      <button class="rmark" title="Every project" onPointerEnter=${onHover} onClick=${() => onPick(null)}>atc</button>
      ${tabs.map((t) => {
        const wait = t.pips.filter((p) => p !== "working");
        return html`
          <button class="av ${t.name === cur ? "on" : ""}" style=${`--ph: ${hueOf(t.name)}`} title=${`${t.name}${t.summary ? `: ${t.summary}` : ""}`}
            onPointerEnter=${onHover} onClick=${() => onPick(t.name)}>
            ${mono.get(t.name)}
            ${t.pips.includes("working") && html`<i class="busy"></i>`}
            ${wait.length > 0 && html`<span class="badge ${wait[0]}">${wait.length}</span>`}
          </button>`;
      })}
      <span class="grow"></span>
      <button class="icon" title="Search and commands" aria-label="Search and commands" onClick=${() => PALETTE_OPEN()}>${ICON.search}</button>
    </nav>`;
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
        <label class="field"><span>Token</span><input type="password" autocomplete="current-password" value=${tok} onInput=${(e) => setTok(e.target.value)} ref=${focusOnMount} /></label>
        ${err && html`<p class="err">${err}</p>`}
        <div class="actions"><button class="btn primary" disabled=${!tok}>Log in</button></div>
      </form>
    </div>
  `;
}

function Board({ live: all, sel, cursor, onPast, mode = "classic" }) {
  const [q, setQ] = useState("");
  const [only, setOnlyRaw] = useState(() => { try { return localStorage.getItem("atc.project") || null; } catch { return null; } });
  const setOnly = (v) => setOnlyRaw((o) => {
    const n = typeof v === "function" ? v(o) : v;
    try { n ? localStorage.setItem("atc.project", n) : localStorage.removeItem("atc.project"); } catch {}
    return n;
  });
  PICK_PROJECT = (name) => setOnly((o) => (o === name ? null : name));
  const tabs = useMemo(() => projectTabs(all || [], only), [all, only]);
  TABS = { only, tabs, set: setOnly };
  useEffect(() => {
    const k = (e) => {
      if ((e.key !== "[" && e.key !== "]") || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const names = [null, ...tabs.map((t) => t.name)];
      const i = Math.max(0, names.indexOf(only));
      setOnly(names[(i + (e.key === "]" ? 1 : names.length - 1)) % names.length]);
      e.preventDefault();
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [tabs, only]);
  const mine = (s) => !only || project(s.cwd).name === only;
  const live = all && all.filter(mine);
  const [hist, setHist] = useState(null);
  const [limit, setLimit] = useState(30);

  useEffect(() => {
    const t = setTimeout(() => {
      api(`/api/history?limit=${mode === "lanes" ? limit + 30 : limit}&q=${encodeURIComponent(q)}`).then((list) => {
        setHist(list || []);
        onPast(list || []);
      }, () => setHist([]));
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, limit, mode === "lanes"]);

  const boardRef = useRef();
  useFlip(boardRef, all);
  if (!live) return html`<div class="board"><div class="skeleton"><i></i><i></i><i></i></div></div>`;
  const liveIDs = new Set(live.map((s) => s.sessionId));
  const earlier = (hist || []).filter((s) => !liveIDs.has(s.sessionId) && mine(s));
  const pinned = live.filter((s) => s.pinned && !s.parked);
  const rest = live.filter((s) => !s.pinned && !s.parked);
  const parked = live.filter((s) => s.parked);
  const active = live.filter((s) => !s.parked && ["needs-you", "your-turn", "working"].includes(s.state));
  const waiting = active.filter((s) => s.state !== "working").length;
  const working = active.length - waiting;

  const search = html`
    <div class="search">
      <input type="search" placeholder="Search titles, prompts and folders  /" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>`;
  const past = html`
    ${dayGroups(earlier).map(([label, list]) => html`
      <h3>${label}</h3>
      <div class="rack rows">${list.map((s) => html`<${Strip} key=${s.sessionId} s=${s} sel=${sel} size="row" />`)}</div>`)}
    ${hist && hist.length >= limit && html`<button class="btn more" onClick=${() => setLimit(limit + 30)}>Show more</button>`}
    ${hist && earlier.length === 0 && html`<p class="calm">${q ? "No earlier sessions match." : only ? `No earlier sessions in ${only} yet.` : "No earlier sessions."}</p>`}`;
  const earlierBay = html`<section class="bay earlier"><h2>Earlier</h2>${search}${past}</section>`;
  const classic = html`
    ${live.length === 0
      ? html`<p class="calm">${only ? `Nothing running in ${only}.` : "Nothing is running. Start a session, or pick up an earlier one below."}</p>`
      : !waiting && html`<p class="calm">${working ? `Nothing needs you. ${working} working.` : "All quiet."}</p>`}
    ${pinned.length > 0 && html`<${Bay} title="Pinned" list=${pinned} sel=${sel} cursor=${cursor} />`}
    ${BAYS.filter(([st]) => st !== "stopped").map(([st, title]) => html`<${Bay} title=${title} list=${rest.filter((s) => s.state === st)} sel=${sel} cursor=${cursor} />`)}
    <${Bay} title="Parked" list=${parked} sel=${sel} cursor=${cursor} size="slim" dim />
    <${Bay} title="Stopped" list=${rest.filter((s) => s.state === "stopped")} sel=${sel} cursor=${cursor} size="slim" />
    ${earlierBay}`;

  return html`
    <div class="board ${mode === "classic" ? "" : "v2"}" ref=${boardRef} style=${tabs.length > 1 ? "--stick: 40px" : "--stick: 0px"}>
      ${tabs.length > 1 && html`
        <nav class="projtabs" aria-label="Projects">
          <button class=${only ? "" : "on"} onClick=${() => setOnly(null)}>All</button>
          ${tabs.map((t) => html`
            <button class=${only === t.name ? "on" : ""} style=${`--ph: ${hueOf(t.name)}`} onClick=${() => setOnly(only === t.name ? null : t.name)}
              title=${`${t.name}: ${t.summary || "nothing active"}`}>
              <span class="nm">${t.name}</span>
              ${t.pips.length > 0 && html`<span class="pips">${t.pips.slice(0, 5).map((st) => html`<i class=${st}></i>`)}${t.pips.length > 5 && html`<em>+${t.pips.length - 5}</em>`}</span>`}
            </button>`)}
        </nav>`}
      ${mode === "triage" ? html`<${Triage} live=${live} only=${only} sel=${sel} cursor=${cursor} />${earlierBay}`
        : mode === "lanes" ? html`${search}${q ? past : html`<${Lanes} live=${live} earlier=${earlier} only=${only} setOnly=${setOnly} sel=${sel} cursor=${cursor}
            more=${hist && hist.length >= limit + 30 && (() => setLimit(limit + 30))} />`}`
        : classic}
    </div>
  `;
}

const byRecent = (a, b) => (Date.parse(b.updated || 0) || 0) - (Date.parse(a.updated || 0) || 0);

function Triage({ live, only, sel, cursor }) {
  const wait = live.filter((s) => !s.parked && (s.state === "needs-you" || s.state === "your-turn"))
    .sort((a, b) => (a.state === "needs-you" ? 0 : 1) - (b.state === "needs-you" ? 0 : 1));
  const work = live.filter((s) => s.state === "working");
  const rest = live.filter((s) => !wait.includes(s) && !work.includes(s)).sort((a, b) => !!b.pinned - !!a.pinned);
  const name = (s) => html`<b>${s.title || "Untitled"}</b>`;
  const busy = work.length ? ` ${work.length} working.` : "";
  const brief = wait.length > 1 ? html`${name(wait[0])} and ${wait.length - 1} more are waiting on you.${busy}`
    : wait.length ? html`${name(wait[0])} is waiting on you.${busy}`
    : work.length ? `Nothing needs you.${busy}`
    : live.length ? "All quiet."
    : only ? `Nothing running in ${only}.` : "Nothing is running. Start a session, or pick up an earlier one below.";
  return html`
    <p class="brief">${brief}</p>
    <${Bay} title="Your turn" list=${wait} sel=${sel} cursor=${cursor} size="tcard" />
    <${Bay} title="Working" list=${work} sel=${sel} cursor=${cursor} size="work" />
    <${Bay} title="Parked" list=${rest.filter((s) => s.parked)} sel=${sel} cursor=${cursor} size="lrow" />
    <${Bay} title="Stopped" list=${rest.filter((s) => !s.parked)} sel=${sel} cursor=${cursor} size="line" />`;
}

function lanesOf(live, earlier) {
  const by = new Map();
  const add = (s, k) => {
    const n = project(s.cwd).name;
    if (!by.has(n)) by.set(n, { name: n, live: [], past: [] });
    by.get(n)[k].push(s);
  };
  live.forEach((s) => add(s, "live"));
  earlier.forEach((s) => add(s, "past"));
  return [...by.values()].map((l) => ({ ...l,
    rank: Math.min(9, ...l.live.filter((s) => !s.parked).map((s) => RANK[s.state] ?? 9)),
    recent: Math.max(0, ...[...l.live, ...l.past].map((s) => Date.parse(s.updated || 0) || 0)),
  })).sort((a, b) => a.rank - b.rank || b.recent - a.recent);
}

function Ribbon({ list }) {
  const n = 48, now = Date.now(), span = 864e5, t0 = now - span, slots = Array(n).fill(0);
  const at = (t) => Math.floor(((t - t0) / span) * n);
  for (const s of list) {
    const b = s.state === "working" ? now : Date.parse(s.updated || 0) || 0;
    const a = Math.min(b, Date.parse(s.promptAt || 0) || b);
    if (b < t0) continue;
    for (let i = Math.max(0, at(a)); i <= Math.min(n - 1, at(b)); i++) slots[i]++;
  }
  const max = Math.max(1, ...slots);
  return html`<span class="ribbon" title="Activity over the last 24 hours" aria-hidden="true">${slots.map((v) => html`<i class=${v ? "on" : ""} style=${`height: ${v ? 4 + (8 * v) / max : 2}px`}></i>`)}</span>`;
}

function Lanes({ live, earlier, only, setOnly, sel, cursor, more }) {
  const [opened, setOpened] = useState({});
  const lanes = lanesOf(live, earlier);
  if (!lanes.length) return html`<p class="calm">${only ? `Nothing in ${only} yet.` : "No sessions yet."}</p>`;
  const recent = Date.now() - 6 * 3600e3;
  return lanes.map((l) => {
    const all = [...l.live, ...l.past];
    const warm = only === l.name || opened[l.name] || l.live.some((s) => !s.parked && s.state !== "stopped") || l.recent > recent;
    if (!warm) return html`
      <button class="lane cold" style=${`--ph: ${hueOf(l.name)}`} onClick=${() => setOpened({ ...opened, [l.name]: true })}>
        <span class="nm">${l.name}</span><span class="sum">${all.length} · ${ago([...all].sort(byRecent)[0])}</span>
      </button>`;
    const count = (f) => l.live.filter((s) => !s.parked && f(s)).length;
    const sum = [[count((s) => s.state === "needs-you" || s.state === "your-turn"), "your turn"], [count((s) => s.state === "working"), "working"]]
      .filter(([k]) => k).map(([k, w]) => `${k} ${w}`).join(" · ") || `${all.length} session${all.length > 1 ? "s" : ""}`;
    const past = only === l.name ? l.past : l.past.slice(0, l.live.length ? 2 : 3);
    const hidden = l.past.length - past.length;
    return html`
      <section class="lane" style=${`--ph: ${hueOf(l.name)}`}>
        <button class="lh" title=${only === l.name ? "Show every project" : `Show only ${l.name}`} onClick=${() => setOnly(only === l.name ? null : l.name)}>
          <span class="nm">${l.name}</span><span class="sum">${sum}</span><${Ribbon} list=${all} />
        </button>
        ${[...l.live, ...past].map((s) => html`<${Strip} key=${s.sessionId} s=${s} sel=${sel} cursor=${cursor} size="lrow" />`)}
        ${hidden > 0 && html`<button class="lmore" onClick=${() => setOnly(l.name)}>${hidden} earlier</button>`}
        ${only === l.name && more && html`<button class="lmore" onClick=${more}>Show more</button>`}
      </section>`;
  });
}

function Bay({ title, list, sel, cursor, dim, size = "full" }) {
  if (!list.length) return null;
  return html`
    <section class="bay ${dim ? "parked" : ""}">
      <h2>${title} <span class="n">${list.length}</span></h2>
      <div class="rack r-${size}">${list.map((s) => html`<${Strip} key=${s.sessionId} s=${s} sel=${sel} cursor=${cursor} size=${size} />`)}</div>
    </section>
  `;
}

function dayGroups(list) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86400000, t0 = start.getTime();
  const label = (s) => {
    const t = Date.parse(s.updated || s.startedAt || 0);
    return t >= t0 ? "Today" : t >= t0 - day ? "Yesterday" : t >= t0 - 6 * day ? "This week" : "Older";
  };
  const out = [];
  for (const s of list) {
    const l = label(s);
    if (out.at(-1)?.[0] !== l) out.push([l, []]);
    out.at(-1)[1].push(s);
  }
  return out;
}

function useFlip(ref, list) {
  const rects = useRef(new Map());
  const states = useRef(new Map());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map(), moved = [];
    for (const el of root.querySelectorAll("[data-sid]:not(.row)")) {
      const sid = el.dataset.sid, r = el.getBoundingClientRect(), prev = rects.current.get(sid);
      const t = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const at = { left: r.left - t.m41, top: r.top - t.m42 };
      next.set(sid, at);
      const st = el.dataset.state, was = states.current.get(sid);
      if (was && was !== st && st !== "working") { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
      states.current.set(sid, st);
      if (!prev || reduce) continue;
      const dx = prev.left - at.left, dy = prev.top - at.top;
      if (Math.abs(dy) < 2 && Math.abs(dx) < 2) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx + t.m41}px, ${dy + t.m42}px)`;
      moved.push(el);
    }
    rects.current = next;
    if (!moved.length) return;
    void root.offsetWidth;
    for (const el of moved) { el.style.transition = "transform .38s cubic-bezier(.2,.7,.2,1)"; el.style.transform = ""; }
  });
}

let SEEN = null;
function seenMap() {
  if (SEEN) return SEEN;
  try { SEEN = JSON.parse(localStorage.getItem("atc.seen") || "null"); } catch {}
  return SEEN;
}
function markSeen(list, sid) {
  const m = seenMap() || {};
  const now = new Date().toISOString();
  if (!seenMap()) for (const x of list) m[x.sessionId] = now;
  if (sid) m[sid] = now;
  SEEN = m;
  try { localStorage.setItem("atc.seen", JSON.stringify(m)); } catch {}
}
const unread = (s) => (s.state === "your-turn" || s.state === "needs-you") && !s.parked && !!SEEN && Date.parse(s.updated || 0) > Date.parse(SEEN[s.sessionId] || 0);
const oneLine = (t) => (t || "").replace(/\*\*|__|`+|^#+\s*|^>\s*/gm, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();

const ICON = {
  chat: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  plus: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  search: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  pin: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1.5l5 5-2 .5-2.5 2.5.5 3-1.5 1.5L6 10l-3.5 3.5M6 10L2.5 6.5 4 5l3 .5L9.5 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  park: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  play: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>`,
  layout: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 2.5v11M8.5 6h3M8.5 9h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  more: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>`,
};

function HoverActions({ s, menu }) {
  const patch = (body) => (e) => { e.stopPropagation(); api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body }).catch(() => {}); };
  const resume = (e) => { e.stopPropagation(); api(`/api/sessions/${s.sessionId}/resume`, { method: "POST" }).then((r) => go(r.id), () => {}); };
  return html`
    <span class="acts" onPointerDown=${(e) => e.stopPropagation()}>
      ${!s.attachable && s.kind !== "interactive" && html`<span role="button" title="Resume" onClick=${resume}>${ICON.play}</span>`}
      <span role="button" class=${s.pinned ? "on" : ""} title=${s.pinned ? "Unpin" : "Pin to top"} onClick=${patch({ pinned: !s.pinned })}>${ICON.pin}</span>
      <span role="button" class=${s.parked ? "on" : ""} title=${s.parked ? "Unpark" : "Park: out of the way, no notifications"} onClick=${patch({ parked: !s.parked })}>${ICON.park}</span>
      <span role="button" title="More" onClick=${menu}>${ICON.more}</span>
    </span>`;
}

const cmdName = (c) => {
  const seg = c.split(/&&|\|\||;|\|/).map((x) => x.trim()).find((x) => x && !/^(cd|export|set|[A-Z_]+=\S*)(\s|$)/.test(x)) || c;
  return seg.replace(/^((sudo|env|time|nohup|timeout\s+\S+)\s+)+/, "").split(/\s+/)[0].split("/").pop();
};

function doing(s) {
  const a = oneLine(s.activity), m = a.match(/^(\w+)\s+(.+)$/);
  if (!m) return a || "Working…";
  const [, tool, rest] = m, file = rest.split("/").filter(Boolean).pop();
  if (tool === "Bash") return /[&|;$<>`]|^(cd|cat|sed|grep|ls|find|curl|git|ssh|python3?|node|go|make|npm|uv)\s/.test(rest) ? `Running ${cmdName(rest)}` : rest;
  return { Read: `Reading ${file}`, Edit: `Editing ${file}`, MultiEdit: `Editing ${file}`, Write: `Writing ${file}`, Grep: `Searching for ${rest}`,
    Glob: `Looking for ${rest}`, WebFetch: `Reading ${rest}`, WebSearch: `Searching the web for ${rest}`, Agent: `Agent: ${rest}`, Task: `Agent: ${rest}` }[tool]
    || `${toolName(tool)}: ${rest}`;
}

const headline = (s) => {
  if (s.state === "needs-you" && s.activity) return `Waiting on you: ${oneLine(s.activity)}`;
  const t = s.summary?.status?.replace(/^[A-Z][a-z]+:\s+/, "") || oneLine(s.lastReply) || oneLine(s.lastPrompt);
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};
const replyable = (s) => s.attachable && s.state === "your-turn" && !s.asks?.length && s.summary?.replies?.length > 0;
const elsewhere = (s) => MULTI && s.host && s.host !== HERE && html`<span class="host">${s.host}</span>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const Steps = ({ s }) => s.steps > 0 && html`<span class="steps">${plural(s.steps, "step")}${s.files > 0 && ` · ${plural(s.files, "file")}`}${s.failed > 0 && html` · <b>${s.failed} failed</b>`}</span>`;

function Meta({ s, quiet }) {
  return html`
    <div class="l3">
      <${ProjectTag} path=${s.cwd} full />
      ${s.branch && !["HEAD", "main", "master"].includes(s.branch) && html`<span class="br">${s.branch}</span>`}
      ${MULTI && s.host && !(quiet && s.host === HERE) && html`<span class="host">${s.host}</span>`}
      ${engineTag(s)}
      ${s.kind === "interactive" && html`<span class="interm" title="Open in a terminal window: readable here, not attachable">terminal</span>`}
      ${(s.servers || []).slice(0, 2).map((p) => html`<span class="srv" role="link" title=${`Open ${serverURL(s, p)}`} onClick=${(e) => { e.stopPropagation(); openOut(serverURL(s, p)); }}>:${p}</span>`)}
      ${s.pages?.length > 0 && html`<span class="pg" role="link" title=${s.pages.map((l) => `${pageLabel(l)}  ${l.url}`).join("\n")}
        onClick=${(e) => { e.stopPropagation(); openOut(s.pages[0].url); }}><span>${pageLabel(s.pages[0])}</span>${s.pages.length > 1 ? ` +${s.pages.length - 1}` : ""} ↗</span>`}
    </div>`;
}

function CardReplies({ s }) {
  const [busy, setBusy] = useState(false);
  const pick = (e, text) => {
    e.stopPropagation();
    setBusy(true);
    api(`/api/sessions/${s.id}/send`, { method: "POST", body: { text, suggested: true } }).catch(() => setBusy(false));
  };
  return html`<div class="chips" role="group" aria-label="Quick replies" onPointerDown=${(e) => e.stopPropagation()}>
    ${s.summary.replies.map((t) => html`<button disabled=${busy} title=${`Send “${t}”`} onClick=${(e) => pick(e, t)}>${t}</button>`)}
  </div>`;
}

function said(s, human) {
  if (s.state === "working") return html`<div class="said doing" key=${s.activity}>${human ? doing(s) : oneLine(s.activity) || "Working…"}</div>`;
  if (s.state === "needs-you" && s.activity) return html`<div class="said ask">Waiting on you: ${oneLine(s.activity)}</div>`;
  if ((human || s.state === "your-turn" || s.state === "needs-you") && s.summary) return html`<div class="said reply">${human ? headline(s) : s.summary.status}</div>`;
  if ((s.state === "your-turn" || s.state === "needs-you") && s.lastReply) return html`<div class="said reply">${oneLine(s.lastReply)}</div>`;
  return s.lastPrompt ? html`<div class="said">${oneLine(s.lastPrompt)}</div>` : null;
}

function Strip({ s, sel, cursor, size = "full" }) {
  const on = sel && sel.sessionId === s.sessionId;
  const press = useRef({ t: 0, fired: false, x: 0, y: 0 });
  const menu = (e) => { e?.preventDefault(); e?.stopPropagation(); QUICK(s, e?.currentTarget?.getBoundingClientRect()); };
  const hover = useRef(0);
  const swipe = useRef(null);
  const swipes = ["tcard", "work", "line", "lrow"].includes(size) && s.state !== "past";
  const swipeAct = (dx) => dx > 0
    ? { label: s.parked ? "Unpark" : "Park", run: () => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { parked: !s.parked } }) }
    : replyable(s) && { label: `Send “${s.summary.replies[0]}”`, run: () => api(`/api/sessions/${s.id}/send`, { method: "POST", body: { text: s.summary.replies[0], suggested: true } }) };
  const down = (e) => {
    prewarm(s);
    if (e.pointerType !== "touch") return;
    const p = press.current;
    p.fired = false; p.x = e.clientX; p.y = e.clientY;
    const el = e.currentTarget;
    p.t = setTimeout(() => { p.fired = true; navigator.vibrate?.(15); QUICK(s, el.getBoundingClientRect()); }, 450);
    if (swipes && !zoomed()) swipe.current = { x: e.clientX, y: e.clientY, on: false, armed: false };
  };
  const move = (e) => {
    const p = press.current, w = swipe.current, el = e.currentTarget;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) clearTimeout(p.t);
    if (!w) return;
    const dx = e.clientX - w.x, dy = e.clientY - w.y;
    if (!w.on && Math.abs(dx) > 12 && Math.abs(dx) > 1.5 * Math.abs(dy)) { w.on = true; el.setPointerCapture?.(e.pointerId); el.classList.add("swiping"); }
    if (!w.on) return;
    const act = swipeAct(dx), armed = !!act && Math.abs(dx) > 90;
    el.style.transform = `translateX(${act ? dx : dx / 4}px)`;
    el.dataset.swipe = act ? act.label : "";
    el.dataset.dir = dx > 0 ? "r" : "l";
    if (armed !== w.armed) { w.armed = armed; el.classList.toggle("armed", armed); if (armed) navigator.vibrate?.(10); }
  };
  const up = (e) => {
    clearTimeout(press.current.t);
    const w = swipe.current, el = e.currentTarget;
    swipe.current = null;
    if (!w?.on) return;
    const act = w.armed && e.type === "pointerup" && swipeAct(e.clientX - w.x);
    press.current.fired = true;
    setTimeout(() => (press.current.fired = false), 400);
    el.classList.remove("swiping", "armed");
    el.style.transition = "transform .2s ease-out";
    el.style.transform = "";
    setTimeout(() => (el.style.transition = ""), 220);
    if (act) act.run().catch(() => {});
  };
  const events = {
    onClick: (e) => { if (press.current.fired) { press.current.fired = false; return e.preventDefault(); } go(keyOf(s)); },
    onContextMenu: menu, onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up,
    onPointerEnter: (e) => { if (e.pointerType === "mouse") hover.current = setTimeout(() => prewarm(s), 150); },
    onPointerLeave: () => clearTimeout(hover.current),
  };
  const tip = [s.title, [WORD[s.state] || s.state, s.id || s.sessionId.slice(0, 8), model(s.model)].filter(Boolean).join(" · ")].join("\n");
  const cls = `strip ${size} ${s.state} ${on ? "sel" : ""} ${cursor === s.sessionId ? "kb" : ""}`;
  if (["tcard", "work", "line", "lrow"].includes(size)) {
    const c = `it ${size} ${s.state} ${s.parked ? "parked" : ""} ${on ? "sel" : ""} ${cursor === s.sessionId ? "kb" : ""}`;
    const attrs = { class: c, style: `--ph: ${hueOf(project(s.cwd).name)}`, "data-sid": s.sessionId, "data-state": s.state, title: tip, "aria-current": on ? "true" : null, ...events };
    const glyph = html`<i class="g ${s.parked && s.state !== "working" ? "parked" : s.state} ${unread(s) ? "unread" : ""}" aria-hidden="true"></i>`;
    const acts = s.state !== "past" && html`<${HoverActions} s=${s} menu=${menu} />`;
    const when = html`<span class="when" title=${new Date(s.updated || 0).toLocaleString()}>${s.state === "working" ? html`<${Elapsed} s=${s} />` : ago(s)}</span>`;
    if (size === "tcard") return html`
      <div ...${attrs} role="button" tabindex="0" onKeyDown=${(e) => e.key === "Enter" && e.target === e.currentTarget && go(keyOf(s))}>
        ${acts}
        <div class="c1">${glyph}<span class="title">${s.title || "Untitled"}</span>${when}</div>
        <div class="hl">${headline(s)}</div>
        ${s.summary?.gist?.length > 0 && html`<ul class="gist">${s.summary.gist.slice(0, 2).map((g) => html`<li>${g}</li>`)}</ul>`}
        <${Meta} s=${s} quiet />
        ${replyable(s) && html`<${CardReplies} s=${s} />`}
      </div>`;
    if (size === "work") return html`
      <button ...${attrs}>
        ${acts}
        <span class="ring"><${Elapsed} s=${s} /></span>
        <span class="title">${s.title || "Untitled"}</span>
        <${Steps} s=${s} />
        <span class="doing" key=${s.activity}>${doing(s)}</span>
        <${Meta} s=${s} quiet />
      </button>`;
    return html`
      <button ...${attrs}>
        ${acts}
        ${glyph}<span class="title">${s.title || "Untitled"}</span>
        ${size === "line" && html`<${ProjectTag} path=${s.cwd} full />`}${size === "line" && elsewhere(s)}${when}
        ${size === "lrow" && said(s, true)}
        ${size === "lrow" && s.state !== "past" && html`<${Meta} s=${s} quiet />`}
      </button>`;
  }
  if (size === "row") return html`
    <button class=${cls} data-sid=${s.sessionId} data-state=${s.state} title=${tip} aria-current=${on ? "true" : null} ...${events}>
      <span class="title">${s.title || "Untitled"}</span>
      <${ProjectTag} path=${s.cwd} />
      <span class="when" title=${new Date(s.updated || 0).toLocaleString()}>${ago(s)}</span>
    </button>`;
  return html`
    <button class=${cls} data-sid=${s.sessionId} data-state=${s.state} title=${tip} aria-current=${on ? "true" : null} ...${events}>
      <${HoverActions} s=${s} menu=${menu} />
      <div class="l1">
        ${unread(s) && html`<i class="new" aria-label="New"></i>`}
        <span class="title">${s.title || "Untitled"}</span>
        <span class="when" title=${new Date(s.updated || 0).toLocaleString()}>${s.state === "working" ? html`<i class="pulse"></i><${Elapsed} s=${s} />` : ago(s)}</span>
      </div>
      ${said(s)}
      <${Meta} s=${s} />
    </button>
  `;
}

const pageName = (url) => {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, "")) || u.host;
};

const pageLabel = (l) => l.title || pageName(l.url);

const pageMeta = (l) => `${l.title ? `${pageName(l.url)} · ` : ""}${agoLong(l.at)}`;

function Pic({ src, alt = "", fallback }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  return !src || bad ? fallback : html`<img loading="lazy" src=${src} alt=${alt} onError=${() => setBad(true)} />`;
}

function Shot({ l }) {
  return html`<span class="shot"><${Pic} src=${l.image} fallback=${html`<i>↗</i>`} /></span>`;
}

function Published({ links, inline }) {
  const cls = inline ? "pub inline" : "btn pub";
  const one = links[0];
  return html`<span class="pubwrap ${inline ? "inline" : ""}">${links.length === 1
    ? html`<button class=${cls} onClick=${() => openOut(one.url)}><span>${pageLabel(one)}</span><i>↗</i></button>
        ${!inline && html`<span class="pubcard" role="tooltip"><${Shot} l=${one} /><b>${pageLabel(one)}</b><small>${one.url.replace(/^https?:\/\//, "")} · ${agoLong(one.at)}</small></span>`}`
    : html`<${Menu} cls=${cls} left=${inline} aria="Published pages" width=${inline ? "min(320px, calc(100vw - 80px))" : 320} label=${html`<span>${links.length} pages</span><i>▾</i>`}
        items=${links.map((l) => ({ cls: "pubitem", title: l.url, run: () => openOut(l.url),
          label: html`<${Shot} l=${l} /><span class="tx"><b>${pageLabel(l)}</b><small>${pageMeta(l)}</small></span>` }))} />`}</span>`;
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
const RANK = { "needs-you": 0, "your-turn": 1, working: 2 };
function projectTabs(live, keep) {
  const by = new Map();
  for (const x of live) {
    if (x.state === "past") continue;
    const n = project(x.cwd).name;
    if (!by.has(n)) by.set(n, { name: n, pips: [] });
    if (!x.parked && RANK[x.state] !== undefined) by.get(n).pips.push(x.state);
  }
  if (keep && !by.has(keep)) by.set(keep, { name: keep, pips: [] });
  const tabs = [...by.values()];
  for (const t of tabs) {
    t.pips.sort((a, b) => RANK[a] - RANK[b]);
    t.summary = Object.entries(t.pips.reduce((c, st) => ({ ...c, [st]: (c[st] || 0) + 1 }), {})).map(([st, n]) => `${n} ${WORD[st]}`).join(", ");
  }
  const key = (t) => (t.pips.length ? RANK[t.pips[0]] : 9);
  return tabs.sort((a, b) => key(a) - key(b) || b.pips.length - a.pips.length || a.name.localeCompare(b.name));
}

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

const PANE = "atc.pane";
function paneFor(s) {
  let p = null;
  try { p = localStorage.getItem(PANE); } catch {}
  if (p === "chat" || p === "out") return p;
  return s.attachable || s.state === "stopped" ? "term" : "chat";
}

function Session({ s, say, live }) {
  const canAttach = s.attachable;
  const auto = useRef(AUTO_PANE);
  const [mode, setMode] = useState(() => { AUTO_PANE = null; return auto.current || paneFor(s); });
  const [slot, setSlot] = useState(null);
  const choose = (m) => { setMode(m); try { localStorage.setItem(PANE, m); } catch {} };
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const voiceKey = `atc.voice.${s.sessionId}`;
  const [voice, setVoice] = useState(() => { const v = AUTO_VOICE && canAttach; if (v) AUTO_VOICE = false; return v || (canAttach && pref(voiceKey, "") === "on"); });
  useEffect(() => setPref(voiceKey, voice ? "on" : ""), [voice]);
  useEffect(() => {
    if (canAttach && !auto.current && paneFor(s) === "term" && !voice) setMode("term");
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
  const resume = (pane = "term") =>
    act(() => api(`/api/sessions/${s.sessionId}/resume`, { method: "POST" }), (r) => {
      setMode(pane);
      go(r.id);
    });
  const patch = (body) => act(() => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body }));
  const outs = useOutputs(s, mode === "out" ? 10000 : 60000);
  const [showUse, setShowUse] = useState(false);
  useEffect(() => {
    SESSION_API = { s, canAttach, mode: choose, voice: () => canAttach && setVoice((v) => (v || setMode("chat"), !v)), usage: () => setShowUse(true), rename: () => setRenaming(true) };
    return () => { SESSION_API = null; };
  });
  const use = useSessionUsage(s, showUse || s.state === "working" ? 15000 : 90000);
  const pages = s.pages?.length ? s.pages : outs?.featured || [];
  const outCount = outs ? outs.servers.length + outs.featured.length + outs.files.filter((f) => f.kind !== "text").length + outs.links.length : 0;

  return html`
    <div class="head">
      <button class="icon back" onClick=${() => go(null)} aria-label="Back to sessions">‹ Back</button>
      <div class="who">
        <div class="t">
          ${renaming
            ? html`<input ref=${focusOnMount} value=${s.title} onKeyDown=${(e) => {
                if (e.key === "Enter") { patch({ name: e.target.value }); setRenaming(false); }
                if (e.key === "Escape") setRenaming(false);
              }} onBlur=${() => setRenaming(false)} />`
            : html`<span onDblClick=${() => setRenaming(true)}>${s.title || "Untitled"}</span>`}
        </div>
        <div class="meta">
          <span class="word" style=${`--edge: var(--${{ "needs-you": "needs", "your-turn": "turn", working: "work" }[s.state] || "stop"})`}>${WORD[s.state] || s.state}</span>
          <${ProjectTag} path=${s.cwd} full />
          ${s.branch && s.branch !== "HEAD" && html`<span class="wide">${s.branch}</span>`}
          ${engineTag(s) || (s.model && html`<span class="wide">${model(s.model)}</span>`)}
          ${(s.context > 0 || use?.total > 0) && html`
            <span class="wide usehover" tabindex="0" role="button" onClick=${() => setShowUse(true)} onKeyDown=${(e) => e.key === "Enter" && setShowUse(true)}>
              ${s.context > 0 ? `${Math.round(s.context / 1000)}k context` : "usage"}
              ${use?.total > 0 && html`<span class="usecard" role="tooltip">
                ${shares(use).map((x, i) => i === 0 ? html`<b>${x.p != null ? `${approx(x.p)} of your weekly limit · ` : ""}${usd(x.cost)} this week</b>`
                  : html`<span>${x.p != null ? `${approx(x.p)} of the 5-hour window · ` : ""}${usd(x.cost)} in it</span>`)}
                <span>Whole session: ${usd(use.cost)} · ${tokens(use.total)} tokens</span>
                <span class="hint">Click for details</span>
              </span>`}
            </span>`}
          ${s.permissionMode === "bypassPermissions" && html`<span class="wide" title="Claude runs tools in this session without asking first, except where a permission rule says to ask">no permission prompts</span>`}
          ${pages.length > 0 && html`<${Published} links=${pages} inline />`}
        </div>
      </div>
      ${pages.length > 0 && html`<${Published} links=${pages} />`}
      ${VOICE.stt && html`<button class="btn voice-btn ${voice ? "on" : ""} ${canAttach ? "" : "off"}" aria-pressed=${voice}
        onClick=${() => canAttach ? (voice || setMode("chat"), setVoice(!voice))
          : say(s.kind === "interactive" ? "Voice needs a session atc can type into. This one runs in a terminal window; start one from atc, or resume this one after it ends." : "Resume this session first, then turn on voice.")}>Voice</button>`}
      ${mode === "chat" && html`<div class="tx-slot" ref=${setSlot}></div>`}
      <div class="seg" role="tablist">
        <button class=${mode === "term" ? "on" : ""} onClick=${() => choose("term")}>Terminal</button>
        <button class=${mode === "chat" ? "on" : ""} onClick=${() => choose("chat")}>Transcript</button>
        <button class=${mode === "out" ? "on" : ""} onClick=${() => choose("out")}>Outputs${outCount > 0 && html`<span class="count">${outCount}</span>`}</button>
      </div>
      <${Menu} busy=${busy} items=${[...sessionActions(s, say, { rename: () => setRenaming(true), after: () => setBusy(false) }), { label: "Usage", run: () => setShowUse(true) }]} />
    </div>
    ${mode !== "chat" && html`<${AskBar} s=${s} say=${say} />`}
    ${mode !== "chat" && html`<${SummaryBar} s=${s} say=${say} onFull=${() => setMode("chat")} />`}
    ${mode === "term"
      ? canAttach
        ? html`<${Term} key=${s.id} s=${s} say=${say} voice=${voice} onVoiceOff=${() => setVoice(false)} />`
        : html`<div class="stage"><div class="cover">${Unattachable(s, () => resume(), busy, setMode)}</div></div>`
      : mode === "out" ? html`<${Outputs} s=${s} data=${outs} />` : html`<${Transcript} s=${s} say=${say} slot=${slot} resume=${() => resume("chat")} busy=${busy} voice=${voice && canAttach} onVoiceOff=${() => setVoice(false)} />`}
    ${showUse && html`<${SessionUsage} s=${s} use=${use} onClose=${() => setShowUse(false)} />`}
  `;
}

const SUM_OPEN = "atc.summary.open", SUM_HIDDEN = "atc.summary.hidden";
const stored = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const PHONE = matchMedia("(max-width: 899px)");

function usePhone() {
  const [on, setOn] = useState(PHONE.matches);
  useEffect(() => {
    const f = () => setOn(PHONE.matches);
    PHONE.addEventListener("change", f);
    return () => PHONE.removeEventListener("change", f);
  }, []);
  return on;
}

function SummaryBar({ s, say, onFull }) {
  const phone = usePhone();
  const [open, setOpen] = useState(() => stored(SUM_OPEN, false));
  const [sheet, setSheet] = useState(false);
  const [hidden, setHidden] = useState(() => stored(SUM_HIDDEN, []));
  const [sending, setSending] = useState(false);
  const x = s.summary;
  const done = s.state !== "working";
  if (!done || (x ? hidden.includes(x.reply) : !s.summarizing)) return null;
  if (!x) return html`<div class="sumbar pending" aria-live="polite"><span class="sumtext">Summarizing the reply…</span></div>`;

  const more = x.gist?.length > 0 || x.overview?.length > 0;
  const toggle = () => (phone ? setSheet(true) : (setOpen(!open), store(SUM_OPEN, !open)));
  const hide = (e) => {
    e.stopPropagation();
    const next = [x.reply, ...hidden].slice(0, 50);
    setHidden(next);
    store(SUM_HIDDEN, next);
  };
  const again = () => api(`/api/sessions/${s.sessionId}/summary`, { method: "POST" }).then(() => say("Summarizing again…"), (e) => say(e.message));
  const full = () => { setSheet(false); onFull(); };
  const chips = replyable(s);
  const pick = (text) => {
    setSending(true);
    api(`/api/sessions/${s.id}/send`, { method: "POST", body: { text, suggested: true } }).catch((e) => say(e.message)).finally(() => setSending(false));
  };
  return html`
    <div class="sumbar ${open && !phone ? "open" : ""}">
      <div class="sumrow" role=${more ? "button" : null} tabindex=${more ? 0 : null} aria-expanded=${more ? (phone ? sheet : open) : null}
        onClick=${more ? toggle : null} onKeyDown=${(e) => more && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
        <span class="sumtext">${x.status}</span>
        ${more && html`<span class="summore">${phone ? "More" : open ? "Less" : "More"}<i class="caret ${open && !phone ? "up" : ""}"></i></span>`}
        <button class="icon sumx" onClick=${hide} title="Hide until the next reply" aria-label="Hide the summary">✕</button>
      </div>
      ${chips && html`<${Replies} list=${x.replies} pick=${pick} busy=${sending} />`}
      ${open && !phone && more && html`<div class="sumbody"><${SummaryParts} x=${x} /><${SummaryFoot} onFull=${full} again=${again} /></div>`}
    </div>
    ${sheet && html`
      <div class="veil sumveil" onPointerDown=${(e) => e.target === e.currentTarget && setSheet(false)}>
        <div class="sumsheet" role="dialog" aria-label="Summary of the final message">
          <i class="grab" aria-hidden="true"></i>
          <p class="sumhead">${x.status}</p>
          <${SummaryParts} x=${x} />
          <${SummaryFoot} onFull=${full} again=${again} onClose=${() => setSheet(false)} />
        </div>
      </div>`}
  `;
}

function Replies({ list, pick, busy }) {
  return html`<div class="quick" role="group" aria-label="Quick replies">
    ${list.map((t) => html`<button disabled=${busy} title=${`Send “${t}”`} onClick=${() => pick(t)}>${t}</button>`)}
  </div>`;
}

function AskBar({ s, say }) {
  const a = s.asks?.[0];
  const [picked, setPicked] = useState([]);
  const [typed, setTyped] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPicked([]); setTyped([]); setBusy(false); }, [a?.id]);
  if (!a) return null;
  const send = (body) => {
    setBusy(true);
    api(`/api/sessions/${s.sessionId}/asks/${a.id}`, { method: "POST", body }).catch((e) => { say(e.message); setBusy(false); });
  };
  if (a.permission) return html`
    <div class="askbar" role="group" aria-label="Permission request">
      <p class="asktext">${s.harness || "Claude"} wants to use <b>${a.permission}</b>${a.patterns?.length > 0 && html` <code title=${a.patterns.join(" ")}>${a.patterns.join(" ")}</code>`}</p>
      <div class="askopts">
        <button class="btn primary" disabled=${busy} onClick=${() => send({ reply: "once" })}>${s.harness ? "Allow once" : "Allow"}</button>
        ${s.harness && html`<button class="btn" disabled=${busy} onClick=${() => send({ reply: "always" })}>Always allow</button>`}
        <button class="btn askskip" disabled=${busy} onClick=${() => send({ reject: true })}>Reject</button>
      </div>
    </div>`;
  const qs = a.questions || [];
  const oneTap = qs.length === 1 && !qs[0].multiple && !qs[0].custom;
  const dismiss = html`<button class="btn askskip" disabled=${busy} onClick=${() => send({ reject: true })}>Dismiss</button>`;
  const answers = () => qs.map((_, i) => [...(picked[i] || []), ...(typed[i]?.trim() ? [typed[i].trim()] : [])]);
  const choose = (i, label) => {
    if (oneTap) return send({ answers: [[label]] });
    const cur = picked[i] || [];
    const next = qs[i].multiple ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : cur.includes(label) ? [] : [label];
    setPicked(Object.assign([...picked], { [i]: next }));
  };
  return html`
    <div class="askbar" role="group" aria-label="Question">
      ${qs.map((q, i) => html`
        <div class="askq">
          <p class="asktext">${q.question}</p>
          <div class="askopts">
            ${q.options.map((o) => html`<button class="btn ${picked[i]?.includes(o.label) ? "on" : ""}" disabled=${busy} title=${o.description || ""}
              aria-pressed=${oneTap ? null : !!picked[i]?.includes(o.label)} onClick=${() => choose(i, o.label)}><span class="ol">${o.label}</span>${o.description && o.description !== o.label && html`<small>${o.description}</small>`}</button>`)}
            ${q.custom && html`<input class="askin" placeholder="Or type an answer" value=${typed[i] || ""} disabled=${busy}
              onInput=${(e) => setTyped(Object.assign([...typed], { [i]: e.target.value }))} />`}
            ${oneTap && dismiss}
          </div>
        </div>`)}
      ${!oneTap && html`<div class="askopts">
        <button class="btn primary" disabled=${busy || !answers().every((x) => x.length)} onClick=${() => send({ answers: answers() })}>Send</button>
        ${dismiss}
      </div>`}
    </div>`;
}

function SummaryParts({ x }) {
  const label = (l) => {
    const m = l.match(/^([^:]{1,16}):\s+(.*)$/);
    return m ? html`<b>${m[1]}:</b> ${m[2]}` : l;
  };
  return html`
    <div class="sumparts">
      ${x.gist?.length > 0 && html`<section><h4>Gist</h4><ul>${x.gist.map((l) => html`<li>${l}</li>`)}</ul></section>`}
      ${x.overview?.length > 0 && html`<section><h4>Overview</h4><ul class="ov">${x.overview.map((l) => html`<li>${label(l)}</li>`)}</ul></section>`}
    </div>`;
}

function SummaryFoot({ onFull, again, onClose }) {
  return html`
    <div class="sumfoot">
      <button class="btn primary" onClick=${onFull}>Read the full message</button>
      <button class="btn" onClick=${again}>Summarize again</button>
      ${onClose && html`<button class="btn" onClick=${onClose}>Close</button>`}
    </div>`;
}

function Unattachable(s, resume, busy, setMode) {
  if (s.kind === "interactive")
    return html`<div><p class="h">Open in a terminal</p><p>This session runs in a terminal window on the server, so it can't be shown here. You can read along in the transcript.</p><div class="row"><button class="btn" onClick=${() => setMode("chat")}>Read transcript</button></div></div>`;
  return html`<div><p class="h">${s.state === "stopped" ? "Stopped" : "Not running"}</p><p>Resume it to pick up where it left off. The whole conversation comes back.</p><div class="row"><button class="btn primary" disabled=${busy} onClick=${resume}>${busy ? "Resuming…" : "Resume"}</button></div></div>`;
}

function Menu({ busy, items, label = "•••", cls = "icon", aria = "More actions", width = 190, left }) {
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
      <button class=${cls} aria-label=${aria} aria-expanded=${open} onClick=${() => setOpen(!open)}>${label}</button>
      ${open && html`
        <div class="sheet" style="position: absolute; ${left ? "left" : "right"}: 0; top: calc(100% + 6px); width: ${typeof width === "number" ? `${width}px` : width}; padding: 8px; display: flex; flex-direction: column; gap: 6px; z-index: 10">
          ${items.map((it) => html`<button class="btn ${it.danger ? "danger" : ""} ${it.cls || ""}" title=${it.title} disabled=${busy} onClick=${() => { setOpen(false); it.run(); }}>${it.label}</button>`)}
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
      const v = window.visualViewport, h = v ? v.height * v.scale : innerHeight;
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

const markFocus = () => document.documentElement.classList.toggle("unfocused", !document.hasFocus());
addEventListener("focus", markFocus);
addEventListener("blur", markFocus);
markFocus();

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
  let ws = null, exited = false, owner = false, tries = 0, timer = null, dead = false, heard = 0, opened = 0, me = 0;
  const WS_STATE = ["connecting", "open", "closing", "closed"];
  const wsState = () => WS_STATE[ws?.readyState] || "none";
  const quiet = () => (heard ? `${Math.round((Date.now() - heard) / 1000)}s` : "-");
  const tlog = (event, detail = {}) => fetch("/api/termlog", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: DEVICE, session: id, event, detail: me ? { ...detail, viewer: `#${me}` } : detail }) }).catch(() => {});
  const emit = (patch) => { Object.assign(d.state, patch); d.ui?.({ ...d.state }); };
  const ctl = (o) => ws?.readyState === 1 && (ws.send(JSON.stringify(o)), true);
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
    if (!ctl({ type: "resize", cols: p.cols, rows: p.rows })) tlog("resize not sent", { want: `${p.cols}x${p.rows}`, ws: wsState() });
    if (owner) fit.fit(); else scale(true);
  };
  d.relayout = relayout;

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = `cols=${term.cols}&rows=${term.rows}&device=${encodeURIComponent(DEVICE)}${d.box && !document.hidden ? "" : "&hidden=1"}${tries > 0 ? "&reconnect=1" : ""}`;
    ws = new WebSocket(`${proto}//${location.host}/api/sessions/${id}/attach?${q}`);
    ws.binaryType = "arraybuffer";
    const started = Date.now();
    ws.onmessage = (e) => {
      heard = Date.now();
      if (typeof e.data !== "string") return term.write(new Uint8Array(e.data));
      const c = JSON.parse(e.data);
      if (c.type === "size") {
        me = c.viewer || me;
        tlog("size", { got: `${c.cols}x${c.rows}`, mine: !!c.owner, holder: c.holder, viewers: c.viewers, shown: !!d.box });
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
      opened = heard = Date.now();
      tlog("open", { took: `${opened - started}ms`, attempt: tries, shown: !!d.box });
      tries = 0;
      emit({ retrying: false });
      if (d.box && !document.hidden) { ctl({ type: "visible" }); requestAnimationFrame(relayout); }
    };
    ws.onclose = (e) => {
      tlog("closed", { code: e.code, reason: e.reason || "-", clean: e.wasClean, lasted: opened ? `${Math.round((Date.now() - opened) / 1000)}s` : "never opened", quiet: quiet(), attempt: tries });
      opened = me = 0;
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
  el.addEventListener("touchstart", (e) => { ty = e.touches.length === 1 ? e.touches[0].clientY : null; acc = 0; }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (ty === null || e.touches.length > 1) return void (ty = null);
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
    if (!files.length || !d.hooks.paste) return;
    e.preventDefault();
    e.stopPropagation();
    d.hooks.paste(files);
  }, true);

  d.page = (visible) => {
    tlog(visible ? "page visible" : "page hidden", { ws: wsState(), quiet: quiet() });
    ctl({ type: visible ? "visible" : "hidden" });
  };
  d.show = (box) => {
    d.box = box;
    box.append(el);
    shelf().style.cssText = `width:${box.clientWidth}px;height:${box.clientHeight}px`;
    const p = fit.proposeDimensions();
    tlog("show", { ws: wsState(), quiet: quiet(), box: `${box.clientWidth}x${box.clientHeight}px`, fits: p?.cols ? `${p.cols}x${p.rows}` : "-", grid: `${term.cols}x${term.rows}`, holder: owner ? "me" : d.state.foreign || "?" });
    ctl({ type: "visible" });
    requestAnimationFrame(relayout);
  };
  d.hide = () => {
    if (dead) return;
    d.box = null;
    d.ui = null;
    d.hooks = {};
    d.used = Date.now();
    tlog("hide", { ws: wsState() });
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
  const [pasted, setPasted] = useState(null);
  const upload = useRef();
  upload.current = async (files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f, f.name || "pasted.png");
      try {
        const res = await fetch(`/api/sessions/${s.sessionId}/upload`, { method: "POST", body: fd });
        if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
        const { path } = await res.json();
        api_.current.send?.(` \x1b[200~${/\s/.test(path) ? `"${path}"` : path}\x1b[201~`);
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
      paste: (files) => setPasted(files),
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
      ${pasted && html`<${PasteConfirm} files=${pasted} onClose=${(ok) => { setPasted(null); ok ? upload.current(pasted) : api_.current.focus?.(); }} />`}
      ${voice && !cover && html`<${VoiceBar} s=${s} say=${say} type=${(t) => { api_.current.send?.(t); setTimeout(() => api_.current.send?.("\r"), 150); }} press=${(k) => api_.current.send?.(k)} onClose=${onVoiceOff} />`}
      <div class="keys ${keyboard ? "show" : ""}" onPointerDown=${(e) => e.preventDefault()}>
        ${KEYS.map(([label, seq]) => html`<button class=${label === "ctrl" && ctrl ? "on" : ""} onClick=${() => key(label, seq)}>${label}</button>`)}
        <button onClick=${() => picker.current.click()}>file</button>
      </div>
    </div>
  `;
}

function PasteConfirm({ files, onClose }) {
  const shown = useMemo(() => files.map((f) => ({ name: f.name || "pasted.png", type: f.type, size: f.size, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => shown.forEach((f) => URL.revokeObjectURL(f.url)), [shown]);
  useEffect(() => {
    const f = (e) => e.key === "Escape" && onClose(false);
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
  return html`
    <div class="veil confirm" onPointerDown=${(e) => e.target === e.currentTarget && onClose(false)}>
      <form class="sheet" onSubmit=${(e) => { e.preventDefault(); onClose(true); }}>
        <h3>Attach ${files.length === 1 ? "this file" : `${files.length} files`} to the session?</h3>
        <${FileList} files=${shown} />
        <div class="actions">
          <button type="button" class="btn" onClick=${() => onClose(false)}>Cancel</button>
          <button class="btn primary" ref=${focusOnMount}>Attach</button>
        </div>
      </form>
    </div>`;
}

function FileList({ files, remove }) {
  return html`
    <div class="files">
      ${files.map((f, i) => html`
        <div class="file">
          ${f.type?.startsWith("image/") ? html`<img src=${f.url} alt="" />` : html`<span class="ext">${(f.name.split(".").pop() || "file").slice(0, 4)}</span>`}
          <span class="nm">${f.name}<small>${fileSize(f.size || 0)}</small></span>
          ${remove && html`<button type="button" class="icon" aria-label=${`Remove ${f.name}`} onClick=${() => remove(i)}>✕</button>`}
        </div>`)}
    </div>`;
}

const loadScript = (src) =>
  new Promise((ok, no) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const el = Object.assign(document.createElement("script"), { src, onload: ok, onerror: () => no(new Error(`Could not load ${src}`)) });
    document.head.appendChild(el);
  });

const speakable = (t) =>
  (t || "")
    .replace(/```[\s\S]*?```/g, " There's some code in the transcript. ")
    .replace(/(^\|.*\|[ \t]*(\n|$))+/gm, " There's a table in the transcript. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\*\*|__|[*#>|]/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
const sentences = (t) => (t.match(/[^.!?…]+[.!?…]+["')]?(\s|$)|[^.!?…]+$/g) || [t]).map((x) => x.trim()).filter(Boolean);
const turkish = (t) => /[çğıöşüÇĞİÖŞÜ]/.test(t);
const HOLD_MS = 3000;
const PHANTOM = /^(thank you|thanks for watching|you|bye|altyazı.*|abone olmayı unutmayın.*|\.+)[.!]?$/i;
const PHASE = { starting: "Starting the microphone…", listening: "Listening", hearing: "Hearing you…", thinking: "Transcribing…", holding: "Keep talking · tap to send now", speaking: "Speaking · tap to stop", muted: "Muted · tap to talk", error: "Voice is not available" };
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const MIC = html`<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>`;
const MIC_OFF = html`<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2l20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8M5 10a7 7 0 0 0 11.9 5M19 10a7 7 0 0 1-.6 2.9M12 17v5"/></svg>`;
const STOP = html`<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;

function finalReplies(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.role === "user") out.push("");
    else if (m.role === "assistant" && out.length && m.text.trim()) out[out.length - 1] = m.text;
  }
  return out.filter((t) => t.trim());
}

const VOICE_LEFT = new Map();

function VoiceBar({ s, say, type, press, onClose, top }) {
  const sid = s.sessionId, left = VOICE_LEFT.get(sid) || {}, muteKey = `atc.mute.${sid}`;
  const who = s.harness || "Claude";
  const [phase, setPhase] = useState("starting");
  const [heard, setHeard] = useState(left.heard || "");
  const [spoken, setSpoken] = useState(left.spoken || "");
  const [muted, setMuted] = useState(() => pref(muteKey, "") === "on");
  const [holdMs, setHoldMs] = useState(0);
  const [source, setSource] = useState(() => pref("atc.voicesrc", VOICE.tts ? "mine" : "device"));
  const [bargeIn, setBargeIn] = useState(() => pref("atc.bargein", "off") === "on");
  const st = useRef({ awaiting: !!left.awaiting, sentAt: left.sentAt || 0, permission: false, speaking: false, audio: null, vad: null, turns: [], at: -1 });
  const live = useRef({});
  live.current = { s, source, muted, bargeIn, heard, spoken };

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

  const condensed = (full) =>
    api("/api/voice/condense", { method: "POST", body: { text: full } }).then((r) => speakable(r.text), () => speakable(full));
  const loadTurns = async () => {
    const p = await api(`/api/sessions/${live.current.s.sessionId}/transcript`).catch(() => ({ messages: [] }));
    st.current.turns = finalReplies(p.messages || []);
    return st.current.turns;
  };
  const readTurn = async (i, how) => {
    const turns = st.current.turns.length ? st.current.turns : await loadTurns();
    if (i < 0 || i >= turns.length) return speak(i < 0 ? "That was the first reply." : "Nothing newer.");
    st.current.at = i;
    speak(how === "short" ? await condensed(turns[i]) : speakable(turns[i]));
  };
  const current = () => (st.current.at >= 0 ? st.current.at : st.current.turns.length - 1);
  const replay = () => (spoken ? speak(spoken) : readLatest());
  const readLatest = async () => { await loadTurns(); readTurn(st.current.turns.length - 1); };
  const earlier = () => readTurn((st.current.at >= 0 ? st.current.at : st.current.turns.length) - 1);
  const full = () => readTurn(current());
  const short = () => readTurn(current(), "short");

  const answer = async (state) => {
    const turns = await loadTurns();
    st.current.at = turns.length - 1;
    const body = turns.length ? speakable(turns[turns.length - 1]) : "";
    st.current.permission = state === "needs-you";
    const ask = state === "needs-you" ? `It needs you${live.current.s.activity ? `, to run ${live.current.s.activity}` : ""}. Say yes to allow it.` : "";
    speak([body, ask].filter(Boolean).join(" ") || "Done.");
  };

  const heardSpeech = async (audio) => {
    st.current.talking = false;
    if (live.current.muted || (st.current.speaking && !live.current.bargeIn)) return;
    setPhase("thinking");
    let text = "";
    try {
      const res = await fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: vad.utils.encodeWAV(audio) });
      if (!res.ok) throw new Error((await res.text()).trim());
      text = (await res.json()).text.trim();
    } catch (e) {
      say(`Could not transcribe: ${e.message}`);
    }
    const buf = st.current.buf;
    if (!text || PHANTOM.test(text)) return buf ? hold(HOLD_MS) : rest();
    if (buf) {
      st.current.buf = `${buf.replace(/[.…]+$/, "")} ${/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text}`;
      setHeard(st.current.buf);
      return judge();
    }
    setHeard(text);
    const bare = text.toLowerCase().replace(/[.!?,]/g, "").trim();
    if (/^(stop|cancel|dur|durdur|iptal|bekle)$/.test(bare)) { press("\x1b"); st.current.awaiting = false; return rest(); }
    if (/^(repeat|again|say (that|it) again|tekrar|tekrarla|bir daha)$/.test(bare)) return replay();
    if (/^(read (it )?all|read the whole (thing|reply)|full|hepsini oku|tamamını oku|tamamı)$/.test(bare)) return full();
    if (/^(previous|earlier|go back|önceki|öncekini oku|geri)$/.test(bare)) return earlier();
    if (st.current.permission && /^(yes|yeah|yep|evet|tamam|olur|okay|ok)\b/.test(bare)) { st.current.permission = false; press("\r"); st.current.awaiting = true; st.current.sentAt = Date.now(); return rest(); }
    st.current.buf = text;
    judge();
  };

  const judge = async () => {
    const text = st.current.buf;
    const done = await api("/api/voice/finished", { method: "POST", body: { text } }).then((r) => r.finished, () => null);
    if (st.current.buf !== text || st.current.talking) return;
    done ? dispatch() : hold(/[.?!]["')]*$/.test(text) ? 1500 : HOLD_MS);
  };
  const hold = (ms) => {
    clearTimeout(st.current.hold);
    st.current.hold = setTimeout(dispatch, ms);
    setHoldMs(ms);
    if (!live.current.muted) listen(true);
    setPhase("holding");
  };
  const dispatch = () => {
    clearTimeout(st.current.hold);
    const text = st.current.buf;
    st.current.buf = "";
    setHoldMs(0);
    if (!text) return rest();
    type(text);
    st.current.awaiting = true;
    st.current.sentAt = Date.now();
    setPhase("waiting");
  };

  useEffect(() => {
    if (!st.current.awaiting || (s.state === "working" && !s.turnDone)) return;
    if (Date.parse(s.promptAt || 0) < st.current.sentAt - 5000) return;
    st.current.awaiting = false;
    answer(s.state);
  }, [s.state, s.turnDone, s.promptAt, s.updated]);

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
          redemptionMs: 1200,
          startOnLoad: false,
          minSpeechMs: 300,
          getStream: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
          onSpeechStart: () => {
            if (live.current.muted) return;
            if (st.current.speaking) { if (!live.current.bargeIn) return; stopSpeaking(); }
            clearTimeout(st.current.hold);
            st.current.talking = true;
            setPhase("hearing");
          },
          onVADMisfire: () => {
            st.current.talking = false; if (st.current.buf) hold(HOLD_MS); else if (!st.current.speaking) rest(); },
          onSpeechEnd: heardSpeech,
        });
        if (dead) return v.destroy();
        st.current.vad = v;
        if (!st.current.speaking) rest();
        if (APP) APP.keepScreenOn(true);
        else lock = await navigator.wakeLock?.request("screen").catch(() => null);
      } catch (e) {
        setPhase("error");
        say(e.name === "NotAllowedError" ? "Allow the microphone to use voice." : `Voice failed to start: ${e.message}`);
      }
    })();
    return () => {
      VOICE_LEFT.set(sid, { heard: live.current.heard, spoken: live.current.spoken, awaiting: st.current.awaiting, sentAt: st.current.sentAt });
      dead = true; st.current.vad?.destroy(); stopSpeaking(); lock?.release?.(); APP?.keepScreenOn(false); };
  }, []);

  const tapMic = () => {
    if (phase === "speaking") { stopSpeaking(); return rest(); }
    if (st.current.buf) return dispatch();
    const m = !muted;
    setMuted(m);
    setPref(muteKey, m ? "on" : "");
    live.current.muted = m;
    listen(!m);
    setPhase(m ? "muted" : st.current.awaiting ? "waiting" : "listening");
  };
  const pick = (v) => { setSource(v); setPref("atc.voicesrc", v); };
  const toggleBarge = () => { setBargeIn(!bargeIn); setPref("atc.bargein", bargeIn ? "off" : "on"); };

  return html`
    <div class="voicebar" role="region" aria-label="Voice">
      ${top}
      <div class="vtext" aria-live="polite">
        ${heard && html`<div class="vline ${phase === "holding" || (phase === "hearing" && st.current.buf) ? "more" : ""}"><b>You</b> ${heard}</div>`}
        ${spoken && html`<div class="vline said"><b>${who}</b> ${spoken}</div>`}
        ${!heard && !spoken && html`<div class="vline">Say what you want ${who} to do. It answers out loud when it is done.</div>`}
      </div>
      <div class="vrow">
        <div class="vside">
          <button class="vbtn" onClick=${replay} title="Read the last reply again (or say “repeat”)">Replay</button>
          <button class="vbtn" onClick=${earlier} title="Read the reply before (or say “previous”)">Earlier</button>
          ${VOICE.condense && html`<button class="vbtn" onClick=${short} title="A one or two sentence summary of the reply, written by the server's model">Short</button>`}
        </div>
        <div class="vmain">
          <button class="mic ${phase} ${muted ? "off" : ""}" onClick=${tapMic} aria-pressed=${!muted}
            aria-label=${phase === "speaking" ? "Stop speaking" : phase === "holding" ? "Send now" : muted ? "Unmute microphone" : "Mute microphone"}>
            ${phase === "speaking" ? STOP : muted ? MIC_OFF : MIC}
          </button>
          <div class="vphase">${phase === "waiting" ? `${who} is working` : PHASE[phase]}</div>
          ${phase === "holding" && holdMs > 0 && html`<div class="vhold" key=${Math.random()} style=${`animation-duration:${holdMs}ms`}></div>`}
        </div>
        <div class="vside right">
          ${phase === "waiting" && html`<button class="vbtn" onClick=${() => send("\x1b")} title=${`Send Esc to ${who} (or say “stop”)`}>Stop ${who}</button>`}
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

let WINS = null, winsAt = 0, winsLoading = null;
function loadWindows(fresh) {
  if (!fresh && Date.now() - winsAt < 120000) return Promise.resolve(WINS);
  return (winsLoading ||= api("/api/usage/windows").then((w) => { WINS = w; winsAt = Date.now(); return w; }, () => WINS).finally(() => (winsLoading = null)));
}
const winOf = (u, key) => u?.windows?.find((w) => w.key === key);
const perPct = (w) => (w?.cost > 0 && w.percent >= 1 ? w.cost / w.percent : null);
const asPct = (cost, w) => (cost != null && perPct(w) ? cost / perPct(w) : null);
const pct = (x) => (x < 0.1 ? "<0.1%" : x < 10 ? `${x.toFixed(1)}%` : `${Math.round(x)}%`);
const usd = (c) => (c > 0 && c < 0.01 ? "<$0.01" : `~${dollars(c)}`);
const approx = (x) => (x < 0.1 ? "<0.1%" : `≈${pct(x)}`);
const resetDay = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

function pace(w) {
  const from = Date.parse(w.from), end = Date.parse(w.resetsAt), now = Date.now();
  const gone = (now - from) / (end - from);
  if (!(gone > 0.1 && gone < 1) || w.percent < 1 || w.percent >= 100) return null;
  const at100 = from + ((now - from) * 100) / w.percent;
  return at100 < end
    ? { hot: true, text: `At this pace you reach 100% ${resetDay(at100)}, ${span((end - at100) / 1000)} before it resets.` }
    : { text: `At this pace you end near ${Math.round(w.percent / gone)}% (${Math.round(gone * 100)}% of the window has passed).` };
}

function useSessionUsage(s, every) {
  const [data, setData] = useState(null);
  useEffect(() => setData(null), [s.sessionId]);
  useEffect(() => {
    let live = true;
    const load = () => loadWindows().then((u) => {
      const q = [["week", winOf(u, "weekly_all")], ["fiveHour", winOf(u, "session")]].filter(([, w]) => w).map(([k, w]) => `${k}=${Math.floor(Date.parse(w.from) / 1000)}`);
      return api(`/api/sessions/${s.sessionId}/usage${q.length ? `?${q.join("&")}` : ""}`);
    }).then((d) => live && setData({ ...d, wins: WINS }), () => live && setData((d) => d || { failed: true }));
    load();
    const t = setInterval(load, every);
    return () => { live = false; clearInterval(t); };
  }, [s.sessionId, every]);
  return data;
}

const shares = (use) => {
  if (!use || use.failed || (use.local?.length && !use.cost)) return [];
  return [["week", "weekly_all", use.weekCost], ["5-hour window", "session", use.fiveHourCost]]
    .map(([name, key, cost]) => ({ name, cost, w: winOf(use.wins, key), p: asPct(cost, winOf(use.wins, key)) }))
    .filter((x) => x.cost != null && x.w);
};

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

const ESTIMATE = (asOf) => `Dollar figures are estimated from the transcripts at Claude API list prices${asOf ? ` (${asOf})` : ""}. A Claude subscription is not billed per token; this is what the same work would cost on the API.`;
const RATE = "Dollars and percent convert at each window's own rate: what was spent in it so far divided by its percentage. Anthropic reports whole percents, so the rate is rough while a window is in single digits.";

const ShareRows = ({ rows, total, w, onPick }) => html`
  <div class="shares">
    ${rows.map((r) => html`
      <button class="srow ${onPick ? "" : "flat"}" disabled=${!onPick} onClick=${() => onPick?.(r)} title=${r.hint || r.label}>
        <span class="sl">${r.label}${r.sub && html`<small>${r.sub}</small>`}</span>
        <span class="sv">${usd(r.cost)}${asPct(r.cost, w) != null && html`<small>${approx(asPct(r.cost, w))}</small>`}</span>
        <i style=${`width: ${total > 0 ? Math.max(1, (r.cost / total) * 100) : 0}%`}></i>
      </button>`)}
  </div>`;

const RANGES = [7, 14, 30, 90];
const FAMILIES = ["opus", "fable", "sonnet", "haiku"];
const SERIES = 5;
const modelRank = (m) => { const i = FAMILIES.findIndex((f) => m.includes(f)); return i < 0 ? FAMILIES.length : i; };
const byModel = (a, b) => modelRank(a) - modelRank(b) || b.localeCompare(a, undefined, { numeric: true });
const dayOf = (d, o) => new Date(d + "T12:00").toLocaleDateString([], o);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const share = (x, of) => (of > 0 ? pct((x / of) * 100) : "");
const ofWeek = (cost, w) => { const p = asPct(cost, w); return p != null ? `≈${pct(p)} of a week` : ""; };
const KINDS = [
  ["output", "Output", "What Claude wrote, thinking included"],
  ["cacheRead", "Cache reads", "Earlier context re-read from the prompt cache on every call"],
  ["cacheWrite", "Cache writes", "New context stored in the prompt cache"],
  ["input", "Input", "Context sent without caching"],
];

function useReport(n) {
  const [rep, setRep] = useState(null);
  useEffect(() => {
    let live = true;
    setRep((r) => r && { ...r, loading: true });
    api(`/api/usage/report?days=${n}`).then((r) => live && setRep(r), () => live && setRep({ days: [], sessions: [], projects: [], failed: true }));
    return () => (live = false);
  }, [n]);
  return rep;
}

function LimitCard({ w, x }) {
  useNow(60000);
  const rate = perPct(x), p = x && pace(x);
  const from = Date.parse(x?.from), end = Date.parse(w.resetsAt);
  const gone = from && end > from ? Math.min(1, Math.max(0, (Date.now() - from) / (end - from))) : null;
  return html`
    <div class="ucard ulimit">
      <div class="ulh"><span>${w.key === "session" ? "5-hour window" : w.label}</span><b class=${level(w.percent)}>${Math.round(w.percent)}%</b></div>
      <div class="utrack ${level(w.percent)}" title=${gone != null ? `${Math.round(w.percent)}% used, ${Math.round(gone * 100)}% of the window passed` : ""}>
        <i style=${`width: ${Math.min(100, w.percent)}%`}></i>
        ${gone != null && html`<u style=${`left: ${gone * 100}%`}></u>`}
      </div>
      <div class="ulm">
        <span>${x?.cost > 0 ? `${usd(x.cost)} used` : "Nothing used yet"}</span>
        <span>${rate && w.percent < 100 ? `≈${dollars(rate * (100 - w.percent))} left` : ""}</span>
      </div>
      ${p ? html`<p class=${p.hot ? "hot" : ""}>${p.text}</p>` : gone != null && html`<p>${Math.round(gone * 100)}% of the window has passed.</p>`}
      <p class="faint">${resetText(w.resetsAt)}${rate ? ` · ≈${dollars(rate)} per 1%` : ""}</p>
    </div>`;
}

function DailyChart({ days, models, color, week }) {
  const [at, setAt] = useState(null);
  const top = Math.max(...days.map((d) => d.cost), 0);
  const step = top <= 0 ? 1 : 10 ** Math.floor(Math.log10(top / 3));
  const tick = [1, 2, 5, 10].map((m) => m * step).find((t) => t * 3 >= top) || step * 10;
  const ceil = Math.max(tick * Math.ceil(top / tick), 1);
  const avg = days.reduce((a, d) => a + d.cost, 0) / (days.length || 1);
  const i = at ?? days.length - 1, pick = days[i];
  const labelAt = (d) => days.length <= 14 || new Date(d.day + "T12:00").getDay() === 1;
  return html`
    <div class="ureadout">
      ${pick && html`
        <b>${dayOf(pick.day, { weekday: "short", month: "short", day: "numeric" })}</b>
        <span class="big">${pick.cost > 0 ? usd(pick.cost) : "No usage"}</span>
        ${pick.cost > 0 && html`<span>${[ofWeek(pick.cost, week), `${tokens(pick.total)} tokens`, plural(pick.sessions, "session"), plural(pick.messages, "reply")].filter(Boolean).join(" · ")}</span>`}
        <span class="umix">${models.filter((m) => pick.models?.[m] >= 0.005).map((m) => html`<span><i style=${`background: ${color(m)}`}></i>${modelName(m)} ${dollars(pick.models[m])}</span>`)}</span>`}
    </div>
    <div class="uchart" style=${`--cols: ${days.length}`}>
      <div class="ugrid">
        ${[3, 2, 1, 0].map((k) => html`<span style=${`bottom: ${(k * tick / ceil) * 100}%`}><em>${k ? dollars(k * tick).replace(".00", "") : "$0"}</em></span>`)}
        ${avg > 0 && html`<span class="avg" style=${`bottom: ${(avg / ceil) * 100}%`}><em>avg ${dollars(avg)}</em></span>`}
      </div>
      <div class="ubars" onPointerLeave=${() => setAt(null)}>
        ${days.map((d, j) => html`
          <button class="ubar ${j === i ? "on" : ""}" onPointerEnter=${() => setAt(j)} onFocus=${() => setAt(j)} onClick=${() => setAt(j)}
            aria-label=${`${d.day}: about ${dollars(d.cost)}, ${tokens(d.total)} tokens`}>
            <span class="stack" style=${`height: ${(d.cost / ceil) * 100}%`}>
              ${models.filter((m) => d.models?.[m] > 0).map((m) => html`<i style=${`flex: ${d.models[m]} 1 0; background: ${color(m)}`}></i>`)}
            </span>
            ${labelAt(d) && html`<small>${j === 0 || +d.day.slice(8) <= (days.length <= 14 ? 1 : 7) ? dayOf(d.day, { month: "short", day: "numeric" }) : +d.day.slice(8)}</small>`}
          </button>`)}
      </div>
    </div>`;
}

function Heatmap({ days }) {
  const [at, setAt] = useState(null);
  const grid = WEEKDAYS.map(() => Array(24).fill(0)), count = Array(7).fill(0);
  for (const d of days) {
    const wd = (new Date(d.day + "T12:00").getDay() + 6) % 7;
    count[wd]++;
    d.hours?.forEach((c, h) => (grid[wd][h] += c));
  }
  const top = Math.max(...grid.flat(), 0);
  const hours = Array(24).fill(0).map((_, h) => grid.reduce((a, r) => a + r[h], 0));
  const busiest = hours.indexOf(Math.max(...hours));
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  const cell = at && grid[at[0]][at[1]];
  return html`
    <div class="ureadout sm">
      ${at ? html`<b>${WEEKDAYS[at[0]]} ${hh(at[1])}–${hh((at[1] + 1) % 24)}</b><span>${cell > 0 ? `${usd(cell)} over ${plural(count[at[0]], WEEKDAYS[at[0]])}` : "Nothing"}</span>`
        : top > 0 && html`<span>Busiest hour: <b>${hh(busiest)}–${hh((busiest + 1) % 24)}</b>, ${usd(hours[busiest])} in this range</span>`}
    </div>
    <div class="uheat" onPointerLeave=${() => setAt(null)}>
      ${grid.map((row, r) => html`
        <span class="rl">${WEEKDAYS[r]}</span>
        ${row.map((c, h) => html`<i class=${at && at[0] === r && at[1] === h ? "on" : ""} onPointerEnter=${() => setAt([r, h])} onClick=${() => setAt([r, h])}
          style=${c > 0 ? `--a: ${Math.round(12 + 88 * Math.sqrt(c / top))}%` : ""}></i>`)}`)}
      <span></span>
      ${Array(24).fill(0).map((_, h) => html`<span class="cl">${h % 3 ? "" : h}</span>`)}
    </div>`;
}

function UsagePage({ limits, multi, onClose, onOpen }) {
  const [n, setN] = useState(() => { try { return +localStorage.getItem("atc.usage.days") || 30; } catch { return 30; } });
  const pickN = (v) => { setN(v); try { localStorage.setItem("atc.usage.days", v); } catch {} };
  const [order, setOrder] = useState("cost");
  const [all, setAll] = useState(false);
  const [u, setU] = useState(WINS);
  useEffect(() => { loadWindows(true).then(setU); }, []);
  const rep = useReport(n);
  const ws = limits?.windows || [];
  const week = winOf(u, "weekly_all");
  const firstUsed = (rep?.days || []).findIndex((d) => d.cost > 0);
  const days = (rep?.days || []).slice(Math.max(0, firstUsed));
  const since = firstUsed > 0 && dayOf(days[0].day, { month: "short", day: "numeric" });
  const sum = days.reduce((a, d) => {
    for (const k of ["cost", "total", "messages", "input", "cacheRead", "cacheWrite", "output"]) a[k] += d[k] || 0;
    for (const [k] of KINDS) a.costs[k] += d.costs?.[k] || 0;
    for (const [m, c] of Object.entries(d.models || {})) a.models[m] = (a.models[m] || 0) + c;
    return a;
  }, { cost: 0, total: 0, messages: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costs: Object.fromEntries(KINDS.map(([k]) => [k, 0])), models: {} });
  const models = Object.keys(sum.models).filter((m) => sum.models[m] >= 0.005).sort(byModel);
  const color = (m) => { const i = models.indexOf(m); return i >= 0 && i < SERIES ? `var(--s${i + 1})` : "var(--faint)"; };
  const active = days.filter((d) => d.cost > 0).length;
  const today = days.at(-1);
  const restAvg = days.length > 1 ? (sum.cost - (today?.cost || 0)) / (days.length - 1) : 0;
  const cin = sum.input + sum.cacheRead + sum.cacheWrite;
  const projects = Object.values((rep?.projects || []).reduce((a, p) => {
    const name = project(p.cwd).name || "other";
    const x = (a[name] ||= { label: name, cost: 0, sessions: 0, total: 0, hosts: new Set() });
    x.cost += p.cost; x.sessions += p.sessions; x.total += p.total;
    p.hosts?.forEach((h) => x.hosts.add(h));
    return a;
  }, {})).sort((a, b) => b.cost - a.cost);
  const nSessions = projects.reduce((a, p) => a + p.sessions, 0);
  const sessions = [...(rep?.sessions || [])].sort(order === "cost" ? (a, b) => b.cost - a.cost : order === "tokens" ? (a, b) => b.total - a.total : (a, b) => Date.parse(b.last) - Date.parse(a.last));
  const shown = all ? sessions : sessions.slice(0, 12);
  const src = !limits ? "Checking…"
    : limits.source === "live" ? `Checked ${agoLong(limits.fetchedAt)} with your Claude account.`
    : limits.source === "cached" ? `Not current: from Claude Code's last check, ${agoLong(limits.fetchedAt)}.`
    : limits.source === "statusline" ? `From Claude Code's status line, ${agoLong(limits.fetchedAt)}.` : "";
  const kpis = rep && !rep.failed && [
    [usd(sum.cost), since ? `spent since ${since}` : `spent in ${n} days`, perPct(week) ? `≈${(sum.cost / (perPct(week) * 100)).toFixed(1)}× a full week's limit` : ""],
    [usd(active ? sum.cost / active : 0), "per active day", `${active} of ${days.length} days active`],
    [usd(today?.cost || 0), "today", restAvg > 0 && today ? `${today.cost >= restAvg ? "+" : "−"}${Math.round(Math.abs(today.cost / restAvg - 1) * 100)}% vs the daily average` : ""],
    [tokens(sum.total), "tokens", `${tokens(sum.output)} written · ${plural(sum.messages, "reply")}`],
    [String(nSessions), nSessions === 1 ? "session" : "sessions", plural(projects.length, "project")],
    [cin ? `${Math.round((sum.cacheRead / cin) * 100)}%` : "–", "context from cache", "cache reads cost a tenth of fresh input"],
  ];
  return html`
    <div class="usepage" role="dialog" aria-label="Usage">
      <header class="uphead">
        <button class="icon back" onClick=${onClose} aria-label="Back">←</button>
        <div class="who"><h2>Usage</h2><span class="sub">${[limits?.plan && `${limits.plan} plan`, multi && "all machines"].filter(Boolean).join(" · ")}</span></div>
        <div class="seg">${RANGES.map((r) => html`<button class=${r === n ? "on" : ""} onClick=${() => pickN(r)}>${r}d</button>`)}</div>
        <button class="icon close" onClick=${onClose} aria-label="Close" title="Close (Esc)">✕</button>
      </header>
      <div class="upbody ${rep?.loading ? "loading" : ""}">
        <section class="ulimits">
          ${ws.map((w) => html`<${LimitCard} w=${w} x=${winOf(u, w.key)} />`)}
          ${limits && !ws.length && html`<p class="unote">Limits are not available here${limits.error ? `: ${limits.error}` : "."}</p>`}
        </section>
        <p class="unote">${src}${ws.length && limits?.error ? ` ${limits.error}.` : ""}${ws.length ? " The bar is what you've used; the tick is how much of the window has passed." : ""}</p>
        ${!rep ? html`<p class="unote">Adding up transcripts…</p>` : rep.failed ? html`<p class="unote">Couldn't add up the transcripts.</p>` : html`
          <section class="ukpis">${kpis.map(([v, l, s]) => html`<div><span class="n">${v}</span><span class="l">${l}</span>${s && html`<span class="s">${s}</span>`}</div>`)}</section>
          <section class="ugrid2">
            <div class="ucard wide">
              <h4>Spend by day</h4>
              <${DailyChart} days=${days} models=${models} color=${color} week=${week} />
              ${since && html`<p class="unote">Nothing before ${since}: Claude Code deletes transcripts after 30 days unless <code>cleanupPeriodDays</code> in its settings says otherwise.</p>`}
              <div class="ulegend">${models.map((m, i) => html`<span><i style=${`background: ${color(m)}`}></i>${i < SERIES ? modelName(m) : `${modelName(m)} (other)`}<b>${usd(sum.models[m])}</b><small>${share(sum.models[m], sum.cost)}</small></span>`)}</div>
            </div>
            <div class="ucard">
              <h4>Where the cost goes</h4>
              <${ShareRows} w=${week} total=${Math.max(...KINDS.map(([k]) => sum.costs[k]), 0.01)}
                rows=${KINDS.map(([k, label, hint]) => ({ label, hint, cost: sum.costs[k], sub: `${tokens(sum[k])} tokens · ${share(sum.costs[k], sum.cost)}` }))} />
            </div>
            <div class="ucard wide">
              <h4>When you use it</h4>
              <${Heatmap} days=${days} />
            </div>
            <div class="ucard">
              <h4>Projects</h4>
              <${ShareRows} w=${week} total=${projects[0]?.cost || 1}
                rows=${projects.slice(0, 8).map((p) => ({ ...p, sub: `${plural(p.sessions, "session")}${multi ? ` · ${[...p.hosts].join(", ")}` : ""}` }))} />
            </div>
          </section>
          <section class="ucard">
            <div class="uthead">
              <h4>Sessions${sessions.length >= 60 ? `, top ${sessions.length}` : ""}</h4>
              <div class="seg">${[["cost", "Cost"], ["tokens", "Tokens"], ["last", "Recent"]].map(([k, l]) => html`<button class=${order === k ? "on" : ""} onClick=${() => setOrder(k)}>${l}</button>`)}</div>
            </div>
            <div class="utable">
              ${shown.map((x) => html`
                <button class="urow" onClick=${() => onOpen(x)} title=${tilde(x.cwd)}>
                  <span class="t">${x.title || x.sessionId.slice(0, 8)}</span>
                  <span class="p">${x.cwd && html`<span class="proj" style=${`--ph: ${hueOf(project(x.cwd).name)}`}>${project(x.cwd).name}</span>`}${multi && x.host && html`<small>${x.host}</small>`}</span>
                  <span class="m">${x.model ? modelName(x.model) : ""}</span>
                  <span class="k">${tokens(x.total || 0)}</span>
                  <span class="w">${agoLong(x.last)}</span>
                  <span class="c">${usd(x.cost)}<small>${asPct(x.cost, week) != null ? approx(asPct(x.cost, week)) : ""}</small></span>
                </button>`)}
            </div>
            ${sessions.length > 12 && html`<button class="btn umore" onClick=${() => setAll(!all)}>${all ? "Show fewer" : `Show all ${sessions.length}`}</button>`}
          </section>`}
        <p class="unote">${ESTIMATE()} ${RATE}</p>
      </div>
    </div>`;
}

function SessionUsage({ s, use, onClose }) {
  const sub = use?.subagents;
  const sh = shares(use);
  const week = winOf(use?.wins, "weekly_all");
  const cin = use ? use.input + use.cacheRead + use.cacheWrite : 0;
  const kinds = use && !use.failed && use.costs && [
    ["Output", use.output, use.costs.output, "What Claude wrote, thinking included"],
    ["Cache reads", use.cacheRead, use.costs.cacheRead, "Earlier context re-read from the prompt cache on every call"],
    ["Cache writes", use.cacheWrite, use.costs.cacheWrite, "New context stored in the prompt cache"],
    ["Input", use.input, use.costs.input, "Context sent without caching"],
  ].map(([label, n, cost, hint]) => ({ label, sub: `${tokens(n)} tokens`, cost, hint }));
  const rows = use && !use.failed && [
    ["Turns", use.turns ? `${use.turns}${use.cost > 0 ? ` · ${usd(use.cost / use.turns)} each` : ""}` : "0"],
    ["Replies", use.messages],
    ["Tool calls", use.toolCalls],
    ["Cache hits", cin ? `${Math.round((use.cacheRead / cin) * 100)}% of the context came from cache` : "n/a"],
    ["Subagents", sub.count ? `${sub.count} · ${tokens(sub.total)} tokens · ${usd(sub.cost)}${use.cost > 0 ? ` (${Math.round((sub.cost / use.cost) * 100)}%)` : ""}` : "none"],
    ["Wall time", use.start ? `${span(use.wallSeconds)}, since ${new Date(use.start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "n/a"],
  ];
  return html`
    <${Sheet} cls="usage" title="Usage" sub=${s.title} onClose=${onClose}>
      ${!use ? html`<p class="note">Reading the transcript…</p>` : use.failed ? html`<p class="note">Couldn't read this session's usage.</p>` : html`
        <div class="tiles">
          ${sh.map((x) => html`<div>
            <span class="n">${x.p != null ? approx(x.p) : `${usd(x.cost)}`}</span>
            <span class="l">of this ${x.name}${x.p != null ? ` · ${usd(x.cost)}` : ""}</span>
            <span class="l faint">${x.name === "week" ? `at ${Math.round(x.w.percent)}%, resets ${resetDay(x.w.resetsAt)}` : `at ${Math.round(x.w.percent)}%, resets in ${span((Date.parse(x.w.resetsAt) - Date.now()) / 1000)}`}</span>
          </div>`)}
          <div>
            <span class="n">${usd(use.cost)}</span>
            <span class="l">whole session${asPct(use.cost, week) != null ? `, ${approx(asPct(use.cost, week))} of a week` : ""}</span>
            <span class="l faint">${tokens(use.total)} tokens</span>
          </div>
          <div>
            <span class="n">${span(use.activeSeconds)}</span>
            <span class="l">${s.harness || "Claude"} working</span>
            ${use.activeSeconds > 60 && use.cost > 0 && html`<span class="l faint">${usd(use.cost / (use.activeSeconds / 3600))} per working hour</span>`}
          </div>
        </div>
        ${use.local?.length > 0 && html`<p class="quiet">${use.local.join(", ")} is not Claude: its part costs nothing and doesn't count toward your plan.</p>`}
        ${kinds && use.cost > 0 && html`
          <h4>Where the cost goes</h4>
          <${ShareRows} w=${week} total=${Math.max(...kinds.map((k) => k.cost))} rows=${kinds} />`}
        ${use.models?.length > 0 && html`
          <h4>Models</h4>
          <${ShareRows} w=${week} total=${use.models[0].cost}
            rows=${use.models.map((m) => ({ label: modelName(m.model), sub: `${tokens(m.total)} tokens · ${m.messages} replies`, cost: m.cost }))} />`}
        <h4>Activity</h4>
        <dl class="facts">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        <p class="note">The share of a limit counts this session's spend since that window opened. ${RATE} ${ESTIMATE(use.pricesAsOf)}${use.unpriced?.length ? ` No price known for ${use.unpriced.join(", ")}, so it counts as $0.` : ""} Working time adds up the gaps between messages in each turn, at most 10 minutes per gap.</p>`}
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
      (d) => live && setData({ servers: d.servers || [], featured: d.featured || [], links: d.links || [], files: d.files || [] }),
      () => live && setData((d) => d || { servers: [], featured: [], links: [], files: [], failed: true }));
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
  const nothing = !data.servers.length && !data.featured.length && !data.links.length && !data.files.length;
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
        ${data.featured.length > 0 && html`
          <section>
            <h4>Published</h4>
            <div class="cards">
              ${data.featured.map((l) => html`<button class="card ${l.kind || "page"}" title=${l.url} onClick=${() => openOut(l.url)}>
                <div class="pv"><${Pic} src=${l.image} fallback=${l.text ? html`<${Peek} kind=${l.kind} text=${l.text} tsv=${l.url.endsWith(".tsv")} />`
                  : html`<span class="ext">${l.kind || "page"}</span>`} /></div>
                <div class="cap"><span class="n">${pageLabel(l)}</span><span class="m">${pageMeta(l)}</span></div>
              </button>`)}
            </div>
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
        ${f.kind === "image" ? html`<${Pic} src=${f.url} fallback=${html`<span class="ext">${ext}</span>`} />`
          : f.kind === "html" ? html`<iframe src=${f.url} sandbox="allow-scripts" loading="lazy" tabindex="-1" aria-hidden="true"></iframe>`
          : f.kind === "video" ? html`<video src=${f.url} preload="metadata" muted></video>`
          : f.kind === "markdown" || f.kind === "table" ? html`<${FilePeek} f=${f} ext=${ext} />`
          : html`<span class="ext">${ext}</span>`}
      </div>
      <div class="cap">
        <span class="n">${baseName(f.path)}</span>
        <span class="m">${KIND_LABEL[f.kind]}${f.size ? ` · ${fileSize(f.size)}` : ""} · ${f.op} ${agoLong(f.at)}</span>
      </div>
    </button>`;
}

function FilePeek({ f, ext }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch(f.url, { headers: { Range: "bytes=0-2047" } }).then((r) => (r.ok ? r.text() : "")).then(setText, () => setText(""));
  }, [f.url]);
  return text ? html`<${Peek} kind=${f.kind} text=${text} tsv=${f.path.endsWith(".tsv")} />` : html`<span class="ext">${ext}</span>`;
}

function Peek({ kind, text, tsv }) {
  if (kind === "markdown") return html`<div class="peek md" dangerouslySetInnerHTML=${{ __html: md(text) }}></div>`;
  if (kind !== "table") return html`<pre class="peek">${text}</pre>`;
  const rows = parseRows(text, tsv ? "\t" : ",").slice(0, 12);
  return html`<div class="peek"><table class="data">${rows.map((r, i) => html`<tr>${r.slice(0, 6).map((c) => (i ? html`<td>${c}</td>` : html`<th>${c}</th>`))}</tr>`)}</table></div>`;
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
          : f.kind === "markdown" ? html`<article class="md" dangerouslySetInnerHTML=${{ __html: md(text.t) }}></article>`
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

const TX_LEVELS = [
  [1, "Outline", "Outline", "One line per turn: what you asked and how it was answered"],
  [2, "Story", "Story", "Replies in full, the work between them told in a few lines"],
  [3, "Everything", "All", "Every turn open with every step, command and diff"],
];
const TX_FACES = {
  news: { name: "Newsreader", css: "Newsreader, Georgia, serif", sizes: [17, 19, 21], lh: 1.6 },
  lit: { name: "Literata", css: "Literata, Georgia, serif", sizes: [15.5, 17, 19], lh: 1.66 },
  sans: { name: "Plex Sans", css: "var(--sans)", sizes: [15, 16, 17.5], lh: 1.62 },
};
const txStore = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`atc.tx.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(`atc.tx.${k}`) : localStorage.setItem(`atc.tx.${k}`, JSON.stringify(v)); } catch {} },
};

function bodyOf(msgs) {
  const items = [];
  let cost = 0, ms = 0;
  for (const m of msgs) {
    cost += m.cost || 0;
    if (m.role === "done") ms = Math.max(ms, m.ms || 0);
    else if (m.role === "assistant") items.push({ t: "text", text: m.text, time: m.time });
    else if (m.role === "event") items.push({ t: "event", text: m.text, time: m.time });
    else if (m.role === "note") items.push({ t: "note", text: m.text, time: m.time });
    else if (m.role === "tool") items.push({ t: "step", ...m, input: m.input || {} });
  }
  const last = items.findLastIndex((it) => it.t === "step");
  const answer = items.slice(last + 1).filter((it) => it.t === "text").map((it) => it.text).join("\n\n");
  const work = items.slice(0, last + 1).concat(items.slice(last + 1).filter((it) => it.t === "event" || it.t === "note"));
  const user = msgs.find((m) => m.role === "user");
  return { items: work, answer, images: user?.images || [], prompt: user?.text, cost, ms };
}

function phasesOf(items) {
  const phases = [];
  let cur = null;
  for (const it of joinEdits(items)) {
    if (it.t === "text" || !cur) {
      cur = { head: it.t === "text" ? it.text : "", rows: [] };
      phases.push(cur);
      if (it.t === "text") continue;
    }
    cur.rows.push(it);
  }
  return phases.filter((p) => p.head || p.rows.length);
}

function rowsOf(rows) {
  const out = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (r.t === "step" && r.look && !r.out?.error && !(r.out?.images || []).length) {
      if (prev?.t === "looks") prev.steps.push(r);
      else out.push({ t: "looks", steps: [r] });
    } else out.push(r);
  }
  return out;
}

const txKind = (s) => {
  if (s.tool === "Bash") return s.badge ? s.badge.kind : "run";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(s.tool)) return "edit";
  if (/^(Read|Grep|Glob|LS)$/.test(s.tool)) return "look";
  if (/^Web/.test(s.tool)) return "web";
  if (/^(Agent|Task)$/.test(s.tool)) return "agent";
  if (s.tool === "AskUserQuestion") return "ask";
  return "tool";
};
const TX_NOISE = /^(ToolSearch|EnterWorktree|ExitWorktree|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|ReadNotifications|TodoWrite|TodoRead)$/;
const txSteps = (items) => items.filter((i) => i.t === "step");
const txSpan = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const txDur = (t) => { const ms = Math.max(t.ms || 0, t.end && t.at ? new Date(t.end) - new Date(t.at) : 0); return ms >= 1000 ? txSpan(ms) : ""; };
const txClock = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
const txDay = (ts) => ts ? new Date(ts).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) : "";
const txUsd = (n) => n >= 1 ? `$${n.toFixed(2)}` : n >= 0.005 ? `${Math.round(n * 100)}¢` : "";
const plain = (t) => (t || "").replace(/```[\s\S]*?```/g, " ").replace(/^#+\s*/gm, "").replace(/^\s*>\s?/gm, "").replace(/[*`|]/g, "").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
const firstSentence = (t) => { const p = plain(t); const m = p.match(/^.{12,220}?[.!?:](\s|$)/); return m ? m[0].trim().replace(/:$/, "") : p.slice(0, 200) + (p.length > 200 ? "…" : ""); };
const toolName = (n) => n.startsWith("mcp__") ? n.split("__").slice(1).join(" · ").replace(/_/g, " ") : n;
const relPath = (p, s) => {
  if (!p) return "";
  const wt = p.match(/\/\.claude\/worktrees\/[^/]+\/(.*)/);
  if (wt) return wt[1];
  for (const base of [s.cwd, s.startCwd]) if (base && p.startsWith(base + "/")) return p.slice(base.length + 1);
  return p.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
};
const scratch = (p) => /^(\/tmp\/|\/var\/|\/private\/)|\/\.claude\/jobs\/|\/\.cache\//.test(p || "");
const byKeep = (a, b) => scratch(a.path) - scratch(b.path);
const hostOf = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname.length > 1 ? x.pathname : ""); } catch { return u || ""; } };

function txEdits(s) {
  const i = s.input;
  if (s.tool === "MultiEdit") return (i.edits || []).map((e) => ({ old: e.old_string || "", new: e.new_string || "" }));
  return [{ old: i.old_string || "", new: i.new_string || "" }];
}
const writeLines = (s) => (s.input.content || "").split("\n").length + (s.input._cut?.content || 0);
function diffStat(s) {
  if (s.tool === "Write") return { add: writeLines(s), del: 0 };
  let add = 0, del = 0;
  for (const e of s.edits || txEdits(s)) for (const p of diffLines(e.old, e.new)) { if (p.added) add += p.count; else if (p.removed) del += p.count; }
  return { add, del };
}
const isEdit = (s) => s?.t === "step" && /^(Edit|MultiEdit)$/.test(s.tool) && !s.out?.error;
const joinEdits = (items) => items.reduce((out, it) => {
  const last = out[out.length - 1];
  if (isEdit(it) && isEdit(last) && last.input.file_path === it.input.file_path) out[out.length - 1] = { ...last, edits: [...(last.edits || txEdits(last)), ...txEdits(it)], n: (last.n || 1) + 1 };
  else out.push(it);
  return out;
}, []);

function squash(badges) {
  const out = [], seen = new Set();
  const last = (kind) => badges.findLast((b) => b.kind === kind);
  const test = last("test"), build = last("build");
  if (test) out.push(test);
  if (build && !build.ok) out.push(build);
  for (const b of badges) {
    if (b.kind === "test" || b.kind === "build") continue;
    const key = b.kind + (b.kind === "commit" ? b.ref : b.kind === "publish" ? b.ref : b.text + (b.ref || ""));
    if (!seen.has(key)) { seen.add(key); out.push(b); }
  }
  return out;
}

const TX_ICON = {
  test: (ok) => ok ? "M3 8.5l3 3 7-7" : "M4 4l8 8M12 4l-8 8",
  build: (ok) => ok ? "M3 8.5l3 3 7-7" : "M4 4l8 8M12 4l-8 8",
  commit: () => "M8 2v4M8 10v4M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  push: () => "M8 13V3M4 7l4-4 4 4",
  deploy: () => "M3 13h10M8 10V2M5 5l3-3 3 3",
  publish: () => "M6 3H3v10h10v-3M9 3h4v4M13 3L7 9",
};
const Ico = ({ d, cls = "" }) => html`<svg class="ico ${cls}" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d=${d} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function BadgeChip({ b }) {
  const label = b.kind === "commit" ? b.text : b.kind === "deploy" ? (b.ok ? `Deployed · ${b.ref}` : b.text) : b.kind === "test" && b.ref ? `${b.text} · ${b.ref}` : b.text;
  const chip = html`<span class="chip ${b.kind} ${b.ok ? "ok" : "bad"}" title=${b.ref || label}><${Ico} d=${TX_ICON[b.kind]?.(b.ok) || ""} />${b.kind === "commit" && html`<code>${b.ref}</code>`}<span class="l">${label}</span></span>`;
  return b.kind === "publish" && b.ref ? html`<a class="chiplink" href=${b.ref} data-out>${chip}</a>` : chip;
}
const Chips = ({ badges, max = 6 }) => {
  const list = squash(badges || []);
  if (!list.length) return null;
  return html`<div class="chips">${list.slice(0, max).map((b) => html`<${BadgeChip} b=${b} />`)}${list.length > max && html`<span class="chip more">+${list.length - max}</span>`}</div>`;
};

function Clip({ out, bad, n = 8 }) {
  const [all, setAll] = useState(false);
  if (!out?.text) return null;
  const lines = out.text.split("\n");
  const hidden = (all ? 0 : Math.max(0, lines.length - n)) + (out.more || 0);
  return html`<pre class="tpre out ${bad ? "bad" : ""}">${all ? out.text : lines.slice(0, n).join("\n")}</pre>${hidden > 0 && !all && html`<button class="more-lines" onClick=${() => setAll(true)}>Show ${hidden} more line${hidden > 1 ? "s" : ""}</button>`}${all && out.more > 0 && html`<p class="more-lines">${out.more} more lines were not kept</p>`}`;
}

const TX_LANG = { go: "go", js: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", py: "python", kt: "kotlin", css: "css", html: "xml", sh: "bash", json: "json", md: "markdown", yml: "yaml", yaml: "yaml", rb: "ruby", sql: "sql", toml: "ini" };
const tint = (line, lang) => lang ? hljs.highlight(line, { language: lang, ignoreIllegals: true }).value : esc(line);
function dedent(lines) {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return isFinite(ind) && ind > 0 ? lines.map((l) => l.slice(ind)) : lines;
}

function Diff({ edits, path }) {
  const lang = TX_LANG[(path || "").split(".").pop()];
  const rows = [];
  edits.forEach((e, ei) => {
    if (ei) rows.push({ gap: "…" });
    const parts = diffLines(e.old, e.new);
    parts.forEach((p, pi) => {
      const ls = p.value.replace(/\n$/, "").split("\n");
      const c = p.added ? "add" : p.removed ? "del" : "ctx", sig = p.added ? "+" : p.removed ? "−" : "";
      if (c === "ctx" && ls.length > 6) {
        const head = pi === 0 ? [] : ls.slice(0, 3), tail = pi === parts.length - 1 ? [] : ls.slice(-3);
        head.forEach((l) => rows.push({ c, sig, l }));
        rows.push({ gap: `${ls.length - head.length - tail.length} unchanged lines` });
        tail.forEach((l) => rows.push({ c, sig, l }));
      } else ls.forEach((l) => rows.push({ c, sig, l }));
    });
  });
  const code = dedent(rows.filter((r) => !r.gap).map((r) => r.l.replace(/\t/g, "  ")));
  let k = 0;
  return html`<div class="diff"><div class="rows">${rows.map((r) => r.gap
    ? html`<span class="gap">${r.gap}</span>`
    : html`<div class="r ${r.c}" data-s=${r.sig} dangerouslySetInnerHTML=${{ __html: tint(code[k++], lang) || " " }}></div>`)}</div></div>`;
}

const Shots = ({ st, zoom }) => (st.out?.images || []).map((src) => html`<img class="snap" src=${src} alt="Screenshot Claude looked at" onClick=${() => zoom(src)} />`);
const Failed = ({ st }) => st.out?.error && html`<span class="end bad">failed</span>`;

function answersOf(st) {
  const a = st.out?.meta?.answers;
  if (a) return a;
  return Object.fromEntries([...(st.out?.text || "").matchAll(/"([^"]+)"="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

function Running({ st }) {
  useNow(1000);
  return html`<span class="end running">${st.time ? txSpan(Date.now() - new Date(st.time)) : "running"}</span>`;
}

function AgentThread({ st, s, zoom }) {
  const [page, setPage] = useState(null);
  const done = page?.done || (st.out && !/^Async agent launched/.test(st.out.text || ""));
  useEffect(() => {
    const get = () => api(`/api/sessions/${s.sessionId}/agents/${st.id}`).then(setPage, () => setPage((p) => p || { messages: [] }));
    get();
    if (done) return;
    const t = setInterval(get, 3000);
    return () => clearInterval(t);
  }, [st.id, done]);
  if (!page) return html`<p class="cont">Reading the agent's work…</p>`;
  const b = bodyOf(page.messages || []);
  return html`<div class="thread">
    ${b.prompt && html`<p class="thread-ask">${firstSentence(b.prompt)}</p>`}
    ${b.items.length > 0 && html`<${Story} items=${b.items} s=${s} zoom=${zoom} level=${2} live=${!done} />`}
    ${b.answer ? html`<div class="prose small" dangerouslySetInnerHTML=${{ __html: md(b.answer) }}></div>`
      : done ? st.out?.text && html`<div class="prose small" dangerouslySetInnerHTML=${{ __html: md(st.out.text) }}></div>`
      : html`<p class="live-line"><span class="dot"></span>The agent is still working</p>`}
  </div>`;
}

function Step({ st, s, zoom, pin }) {
  const k = txKind(st), i = st.input, bad = st.out?.error;
  const [opened, setOpen] = useState(!!bad || (st.out?.images || []).length > 0);
  const open = opened || pin;
  const toggle = () => setOpen(!open);
  const cls = `step ${st.tool === "Write" ? "write" : k} ${bad ? "bad" : ""}`;
  const running = pin && !st.out && html`<${Running} st=${st} />`;
  if (k === "ask") {
    const ans = answersOf(st);
    return html`<div class=${cls}>${(i.questions || []).map((q) => {
      const a = ans[q.question] || "";
      const parts = a.split(/,\s*/), hits = q.options?.filter((o) => a === o.label || parts.includes(o.label)) || [];
      const rest = parts.filter((x) => x && !hits.some((o) => o.label === x)).join(", ");
      return html`<div class="qcard"><p class="q">${q.question}</p><div class="opts">${q.options?.map((o) => html`<div class="opt ${hits.includes(o) ? "chosen" : ""}"><b>${o.label}</b>${o.description !== o.label && o.description}</div>`)}</div>${a && rest && html`<p class="said">${rest}</p>`}${!a && !st.out && html`<p class="said wait">${s.asks?.length ? "Answer below" : "Waiting for your answer in the terminal"}</p>`}</div>`;
    })}</div>`;
  }
  if (st.tool === "Bash") {
    const cmd = i.command || st.detail || "";
    const b = st.badge;
    return html`<div class=${cls}>
      <div class="line click" onClick=${toggle}>
        ${b ? html`<${BadgeChip} b=${b} />` : html`<b>${i.description || "Ran"}</b>`}
        ${!b && !i.description && html`<span class="arg">${cmd.split("\n")[0]}</span>`}
        ${b && i.description && html`<span class="arg sans">${i.description}</span>`}
        <${Failed} st=${b ? {} : st} />${running}
      </div>
      ${open && html`<div class="tbox"><pre class="tpre"><span class="ps">$ </span>${cmd}</pre><${Clip} out=${st.out} bad=${bad} /></div>`}
    </div>`;
  }
  if (k === "edit") {
    const d = diffStat(st), path = relPath(i.file_path || st.detail, s);
    return html`<div class=${cls}>
      <div class="line click" onClick=${toggle}><b>${st.tool === "Write" ? "Wrote" : st.n > 1 ? `Edited ×${st.n}` : "Edited"}</b><span class="arg">${path}</span><span class="end"><span class="plus">+${d.add}</span>${d.del > 0 && html` <span class="minus">−${d.del}</span>`}</span>${running}</div>
      ${open && html`<div class="tbox"><div class="hd"><span class="p"><bdi>${path}</bdi></span><span class="n">${st.tool === "Write" ? `new, ${writeLines(st)} lines` : ""}</span></div>
        ${st.tool === "Write" ? html`<pre class="tpre">${(i.content || "").split("\n").slice(0, 40).join("\n")}</pre>${writeLines(st) > 40 && html`<p class="more-lines">${writeLines(st) - 40} more lines</p>`}` : html`<${Diff} edits=${st.edits || txEdits(st)} path=${path} />`}</div>`}
    </div>`;
  }
  if (st.tool === "Read") {
    const from = i.offset, to = i.offset && i.limit ? i.offset + i.limit : null;
    return html`<div class=${cls}><div class="line"><b>Read</b><span class="arg">${relPath(i.file_path || st.detail, s)}${from ? `:${from}${to ? `–${to}` : ""}` : ""}</span><${Failed} st=${st} />${running}</div><${Shots} st=${st} zoom=${zoom} /></div>`;
  }
  if (st.tool === "Grep" || st.tool === "Glob") return html`<div class=${cls}><div class="line"><b>Searched</b><span class="arg">${i.pattern || st.detail}${i.path ? `  in ${relPath(i.path, s)}` : ""}</span>${running}</div></div>`;
  if (st.tool === "WebSearch") {
    const hits = st.out?.meta?.hits || [];
    return html`<div class=${cls}>
      <div class="line click" onClick=${toggle}><b>Searched the web</b><span class="arg wrap sans">${i.query || st.detail}</span>${running}</div>
      ${open && hits.length > 0 && html`<div class="tbox"><ul class="hits">${hits.map((h) => html`<li><span class="d">${hostOf(h.url)}</span><a href=${h.url} data-out>${h.title}</a></li>`)}</ul></div>`}
    </div>`;
  }
  if (st.tool === "WebFetch") return html`<div class=${cls}>
    <div class="line click" onClick=${toggle}><b>Read</b><span class="arg">${hostOf(i.url || st.detail)}</span>${running}</div>
    ${open && html`<div class="tbox">${i.prompt && html`<div class="hd"><span>${i.prompt}</span></div>`}<div class="prose small" dangerouslySetInnerHTML=${{ __html: md(st.out?.text) }}></div></div>`}
  </div>`;
  if (k === "agent") return html`<div class=${cls}>
    <div class="line click" onClick=${toggle}><b>Agent</b><span class="arg wrap sans">${i.description || st.detail}</span>${running}</div>
    ${open && html`<div class="tbox"><${AgentThread} st=${st} s=${s} zoom=${zoom} /></div>`}
  </div>`;
  if (TX_NOISE.test(st.tool)) return null;
  const input = Object.keys(i).length ? JSON.stringify(i, null, 1) : st.detail;
  return html`<div class=${cls}>
    <div class="line click" onClick=${toggle}><b>${toolName(st.tool)}</b><${Failed} st=${st} />${running}</div>
    ${open && html`<div class="tbox">${input && html`<pre class="tpre">${input}</pre>`}<${Clip} out=${st.out} bad=${bad} /></div>`}
    <${Shots} st=${st} zoom=${zoom} />
  </div>`;
}

function Looks({ steps, s }) {
  const [open, setOpen] = useState(false);
  const names = [...new Set(steps.map((x) => x.tool === "Bash" ? null : relPath(x.input.file_path || x.input.path || x.input.pattern || "", s).split("/").pop()).filter(Boolean))];
  const cmds = steps.filter((x) => x.tool === "Bash").length;
  const what = [names.length && `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`, cmds && `${cmds} quick check${cmds > 1 ? "s" : ""}`].filter(Boolean).join(", ");
  return html`<div class="step look group">
    <div class="line click" onClick=${() => setOpen(!open)}><b>Looked at</b><span class="arg sans">${what}</span></div>
    ${open && html`<div class="looks">${steps.map((x) => html`<${Step} key=${x.id} st=${x} s=${s} zoom=${() => {}} />`)}</div>`}
  </div>`;
}

const TX_TAIL = 4;

function Story({ items, s, level, zoom, live, badges }) {
  const [open, setOpen] = useState(level === 3);
  useEffect(() => setOpen(level === 3), [level]);
  if (!items.length) return null;
  const phases = phasesOf(items);
  const follow = live && !open;
  const steps = txSteps(items).filter((x) => !TX_NOISE.test(x.tool));
  const asks = steps.filter((x) => txKind(x) === "ask");
  const failed = steps.filter((x) => x.out?.error).length;
  const files = new Set(steps.filter((x) => txKind(x) === "edit" && !x.out?.error).map((x) => x.input.file_path)).size;
  const counts = [steps.length > 0 && `${steps.length} step${steps.length > 1 ? "s" : ""}`, files > 0 && `${files} file${files > 1 ? "s" : ""} changed`, failed > 0 && `${failed} failed`].filter(Boolean).join(" · ");
  const lastStep = steps[steps.length - 1];
  const row = (it, j) => it.t === "note" ? html`<${Note} key=${`m${j}`} n=${it} />`
    : it.t === "looks" ? html`<${Looks} key=${`l${j}`} steps=${it.steps} s=${s} />`
    : it.t === "event" ? html`<p class="event" key=${`e${j}`}>${it.text}</p>`
    : html`<${Step} key=${it.id || j} st=${it} s=${s} zoom=${zoom} pin=${follow && it === lastStep} />`;
  const heads = phases.filter((p) => p.head);
  const notes = items.filter((it) => it.t === "note");
  const tail = follow ? new Set(rowsOf(phases[phases.length - 1]?.rows || []).slice(-TX_TAIL)) : new Set();
  const loose = open ? [] : notes.filter((n) => !tail.has(n));
  return html`
    ${!open && !follow && asks.map((x) => html`<${Step} st=${x} s=${s} zoom=${zoom} />`)}
    <div class="story ${open ? "open" : ""} ${follow ? "live" : ""}">
      <button class="story-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <span class="what">${counts || "Worked"}</span>
        <svg class="chev" width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      ${badges !== false && html`<${Chips} badges=${steps.map((x) => x.badge).filter(Boolean)} />`}
      ${!open && !follow && heads.length > 0 && html`<ol class="plot" onClick=${() => setOpen(true)}>
        ${(heads.length > 5 ? [...heads.slice(0, 2), null, ...heads.slice(-2)] : heads).map((p) => p ? html`<li>${firstSentence(p.head)}</li>` : html`<li class="skip">${heads.length - 4} more</li>`)}
      </ol>`}
      ${loose.length > 0 && html`<div class="notes">${loose.map((n, j) => html`<${Note} key=${`ln${j}`} n=${n} />`)}</div>`}
      ${follow && html`<div class="phases">
        ${phases.length > 1 && html`<button class="earlier-steps" onClick=${() => setOpen(true)}>${phases.length - 1} earlier part${phases.length > 2 ? "s" : ""}: ${phases.slice(0, -1).filter((p) => p.head).slice(-1).map((p) => firstSentence(p.head))}</button>`}
        ${phases.slice(-1).map((p) => html`<section class="phase">
          ${p.head && html`<p class="narr">${plain(p.head)}</p>`}
          ${(() => { const rows = rowsOf(p.rows), shown = rows.slice(-TX_TAIL), hidden = rows.length - shown.length; return html`${hidden > 0 && html`<button class="earlier-steps" onClick=${() => setOpen(true)}>${hidden} earlier step${hidden > 1 ? "s" : ""}</button>`}<div class="steps">${shown.map(row)}</div>`; })()}
        </section>`)}
      </div>`}
      ${open && html`<div class="phases">${phases.map((p) => html`<section class="phase">
        ${p.head && html`<p class="narr">${plain(p.head)}</p>`}
        ${p.rows.length > 0 && html`<div class="steps">${(level === 3 ? p.rows : rowsOf(p.rows)).map(row)}</div>`}
      </section>`)}</div>`}
    </div>`;
}

const Note = ({ n }) => html`<div class="note-you" title=${`You, while Claude was working${n.time ? ` · ${txClock(n.time)}` : ""}`}><span>${n.text}</span></div>`;

function Prompt({ text, images, partial }) {
  const [all, setAll] = useState(false);
  if (partial) return html`<p class="partial">This turn started before what is loaded here.</p>`;
  if (images?.length) text = text.replace(/\[Image #\d+\]\s*/g, "");
  const long = text.length > 480 || text.split("\n").length > 6;
  return html`<div class="prompt">${text && html`<div class=${long && !all ? "clamp" : ""}>${text}</div>`}${long && html`<button class="fold" onClick=${() => setAll(!all)}>${all ? "Show less" : "Show all"}</button>`}${(images || []).map((src) => html`<img src=${src} alt="Image you attached" />`)}</div>`;
}

const headsOf = (src) => [...(src || "").matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => plain(m[1]));
const readMin = (t) => Math.round(plain(t).split(" ").length / 230);

function Margin({ t, i, s, answer }) {
  const files = (t.files || []).filter((f) => !scratch(f.path));
  return html`<aside class="margin"><div class="rail">
    <div><span class="k">${txClock(t.at)}</span>${txDur(t) && html` · worked <span class="k">${txDur(t)}</span>`}</div>
    ${txUsd(t.cost) && html`<div><span class="k">${txUsd(t.cost)}</span> at API prices</div>`}
    ${readMin(answer) > 1 && html`<div><span class="k">${readMin(answer)} min</span> to read</div>`}
    ${headsOf(answer).length > 1 && html`<ul class="toc">${headsOf(answer).map((h, j) => html`<li><a href=${`#tx${i}h${j}`} data-jump>${h}</a></li>`)}</ul>`}
    ${files.length > 0 && html`<ul class="flist">${files.slice(0, 8).map((f) => html`<li><span class="p"><bdi>${relPath(f.path, s)}</bdi></span><span class="n"><span class="plus">+${f.add}</span>${f.del > 0 && html` <span class="minus">−${f.del}</span>`}</span></li>`)}${files.length > 8 && html`<li>and ${files.length - 8} more</li>`}</ul>`}
  </div></aside>`;
}

function Acts({ answer, quote }) {
  const [copied, setCopied] = useState(false);
  return html`<div class="acts">
    <button onClick=${() => { copyText(answer); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>${copied ? "Copied" : "Copy"}</button>
    ${quote && html`<button onClick=${() => quote(firstSentence(answer))}>Quote in reply</button>`}
  </div>`;
}

function Gist({ s, answer }) {
  const sum = s.summary;
  if (!sum?.gist?.length || answer.length < 1400 || !sum.reply || !answer.startsWith(sum.reply.slice(0, 40))) return null;
  return html`<div class="gist"><p>In short</p><ul>${sum.gist.map((g) => html`<li>${g}</li>`)}</ul></div>`;
}

function Turn({ t, i, s, body, level, zoom, quote, latest, live, fresh }) {
  const answer = body?.answer || "";
  const html_ = useMemo(() => { let j = 0; return md(answer).replace(/<h([1-3])>/g, (_, n) => `<h${n} id="tx${i}h${j++}">`); }, [answer]);
  const files = (t.files || []).filter((f) => !scratch(f.path));
  return html`<section class="turn ${latest ? "latest" : ""} ${fresh ? "fresh" : ""}" id=${`tx${i}`} data-i=${i}>
    <${Node} t=${t} live=${live} />
    <${Prompt} text=${body?.prompt ?? t.prompt} images=${body?.images} partial=${t.partial} />
    <p class="meta-inline">${txClock(t.at)}${txDur(t) && ` · worked ${txDur(t)}`}${txUsd(t.cost) && ` · ${txUsd(t.cost)}`}${files.length > 0 && ` · ${files.length} file${files.length > 1 ? "s" : ""} changed`}</p>
    <${Margin} t=${t} i=${i} s=${s} answer=${answer} />
    ${!body ? (t.steps || t.reply) && html`<div class="skeleton"><i></i><i></i><i></i></div>` : html`
      <${Story} items=${body.items} s=${s} level=${level} zoom=${zoom} live=${live} />
      ${latest && answer && html`<${Gist} s=${s} answer=${answer} />`}
      ${answer ? html`<div class="prose" data-answer dangerouslySetInnerHTML=${{ __html: html_ }}></div><${Acts} answer=${answer} quote=${quote} />`
        : !latest && html`<p class="cont">No reply after this.</p>`}`}
  </section>`;
}

const Folded = ({ t, i, open }) => html`<button class="ol-row folded" id=${`tx${i}`} data-i=${i} onClick=${() => open(i)}>
  <${Node} t=${t} />
  <span class="t">${txClock(t.at)}</span>
  <span class="a">${t.partial ? "Continued from earlier" : plain(t.prompt) || "Image"}</span>
  <span class="b">${t.reply ? firstSentence(t.reply) : t.steps ? `${t.steps} steps, no reply` : "No reply"}</span>
</button>`;

function Outline({ turns, go }) {
  let lastDay = "";
  return html`<div class="ol">${turns.map((t, i) => {
    const d = txDay(t.at), showDay = d !== lastDay;
    lastDay = d;
    return html`${showDay && html`<p class="ol-day">${d}</p>`}<button class="ol-row" data-i=${i} onClick=${() => go(i)}>
      <span class="t">${txClock(t.at)}</span>
      <span class="a">${t.partial ? "Continued from earlier" : plain(t.prompt) || "Image"}</span>
      <span class="b">${t.reply ? firstSentence(t.reply) : "No reply"}</span>
    </button>`;
  })}</div>`;
}

function Scrub({ turns, inView, go }) {
  const [tip, setTip] = useState(null);
  const n = turns.length;
  if (n < 2) return null;
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * n)));
    setTip({ i, y: e.clientY - r.top });
    go(i, true);
  };
  return html`<div class="scrub" onPointerDown=${(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }} onPointerMove=${(e) => e.buttons && pick(e)} onPointerUp=${() => setTip(null)} onPointerCancel=${() => setTip(null)}>
    ${turns.map((t, i) => html`<i class="${inView.has(i) ? "in" : ""} ${t.failed ? "bad" : ""}" style=${`top:${(i / n) * 100}%;height:max(3px, calc(${100 / n}% - 4px))`}></i>`)}
    ${tip && html`<div class="tip" style=${`top:${tip.y - 18}px`}>${t0(turns[tip.i])}<small>${txClock(turns[tip.i].at)}</small></div>`}
  </div>`;
}
const t0 = (t) => (t.partial ? "Continued from earlier" : plain(t.prompt)).slice(0, 90);

function Levels({ level, set }) {
  return html`<div class="pop levels" role="menu" aria-label="How much to show">
    ${TX_LEVELS.map(([l, name, , what]) => html`<button role="menuitemradio" aria-checked=${level === l} onClick=${() => set(l)}>
      <span class="l">${name}</span><kbd>${l}</kbd><span class="d">${what}</span>
    </button>`)}
  </div>`;
}

function Prefs({ prefs, set }) {
  const row = (items) => html`<div class="opts">${items.map(([on, label, act, style]) => html`<button aria-pressed=${on} onClick=${act} style=${style || ""}>${label}</button>`)}</div>`;
  return html`<div class="pop prefs" role="dialog" aria-label="Reading settings">
    <p>Typeface</p>
    ${row(Object.entries(TX_FACES).map(([k, f]) => [prefs.face === k, f.name, () => set({ face: k }), `font-family:${f.css}`]))}
    <p>Size</p>
    ${row(["Small", "Medium", "Large"].map((n, i) => [prefs.size === i, n, () => set({ size: i })]))}
    <p>Line length</p>
    ${row(["Narrow", "Normal", "Wide"].map((n, i) => [prefs.width === i, n, () => set({ width: i })]))}
  </div>`;
}

function Results({ turns, s, bodies, need, go, close }) {
  const files = new Map(), commits = [], deploys = [], pushes = [], pubs = [];
  turns.forEach((t, i) => {
    for (const f of t.files || []) { const cur = files.get(f.path) || { path: f.path, add: 0, del: 0, turns: [] }; cur.add += f.add; cur.del += f.del; cur.turns.push(i); files.set(f.path, cur); }
    for (const b of t.badges || []) {
      if (b.kind === "commit") commits.push({ ...b, i });
      if (b.kind === "deploy" && b.ok) deploys.push({ ...b, i });
      if (b.kind === "push" && b.ok) pushes.push({ ...b, i });
      if (b.kind === "publish" && b.ref) pubs.push({ ...b, i });
    }
  });
  const [file, setFile] = useState(null);
  const [showJunk, setShowJunk] = useState(false);
  const all = [...files.values()], kept = all.filter((f) => !scratch(f.path)), junk = all.filter((f) => scratch(f.path));
  const fileRow = (f) => html`<li><button onClick=${() => setFile(f)}><span class="p"><bdi>${relPath(f.path, s)}</bdi></span><span class="n"><span class="plus">+${f.add}</span>${f.del > 0 && html` <span class="minus">−${f.del}</span>`}</span></button></li>`;
  useEffect(() => { if (file) file.turns.forEach((i) => need(i)); }, [file]);
  const fileEdits = file && file.turns.flatMap((i) => txSteps(bodies[turns[i].from]?.items || []).filter((x) => txKind(x) === "edit" && x.input.file_path === file.path && !x.out?.error).flatMap((x) => x.tool === "Write" ? [{ old: "", new: x.input.content || "" }] : txEdits(x)));
  const pages = [...(s.pages || []).map((p) => ({ url: p.url, title: p.title })), ...pubs.filter((p) => !(s.pages || []).some((x) => x.url === p.ref)).map((p) => ({ url: p.ref }))];
  const sec = (title, n, body) => n > 0 && html`<section><h4>${title}<span>${n}</span></h4>${body}</section>`;
  return html`<div class="pop results" role="dialog" aria-label="What this session produced">
    <div class="pop-head"><b>What this session produced</b><button class="x" onClick=${close} aria-label="Close">✕</button></div>
    ${file ? html`<div class="file-diff">
      <button class="back" onClick=${() => setFile(null)}>‹ All files</button>
      <p class="p"><bdi>${relPath(file.path, s)}</bdi> <span class="plus">+${file.add}</span> <span class="minus">−${file.del}</span></p>
      ${fileEdits.length ? html`<${Diff} edits=${fileEdits} path=${file.path} />` : html`<p class="cont">Loading the edits…</p>`}
    </div>` : html`
      ${sec("Files changed", kept.length || junk.length, html`<ul class="rlist">${kept.map(fileRow)}${junk.length > 0 && html`<li><button onClick=${() => setShowJunk(!showJunk)}><span class="l quiet">${showJunk ? "Hide" : "Show"} ${junk.length} scratch file${junk.length > 1 ? "s" : ""}</span></button></li>`}${showJunk && junk.map(fileRow)}</ul>`)}
      ${sec("Commits", commits.length, html`<ul class="rlist">${commits.map((c) => html`<li><button onClick=${() => { go(c.i); close(); }}><code>${c.ref}</code><span class="l">${c.text}</span></button></li>`)}</ul>`)}
      ${sec("Pushed", new Set(pushes.map((p) => p.text)).size, html`<ul class="rlist">${[...new Set(pushes.map((p) => p.text))].map((t) => html`<li><span class="l">${t}</span></li>`)}</ul>`)}
      ${sec("Deployed", deploys.length, html`<ul class="rlist">${deploys.map((d) => html`<li><button onClick=${() => { go(d.i); close(); }}><span class="l">${d.ref}</span><span class="n">${txClock(turns[d.i].at)}</span></button></li>`)}</ul>`)}
      ${sec("Pages", pages.length, html`<ul class="rlist">${pages.map((p) => html`<li><a href=${p.url} data-out><span class="l">${p.title || hostOf(p.url)}</span></a></li>`)}</ul>`)}
      ${sec("Running", (s.servers || []).length, html`<ul class="rlist">${(s.servers || []).map((p) => html`<li><a href=${serverURL(s, p)} data-out><span class="l">:${p}</span></a></li>`)}</ul>`)}
      ${!files.size && !commits.length && !deploys.length && !pages.length && html`<p class="cont">Nothing yet: no files changed, commits, deploys or pages.</p>`}
    `}
  </div>`;
}

const TX_FILTERS = [["failed", "Failures", (t) => t.failed > 0], ["commit", "Commits", (t) => (t.badges || []).some((b) => b.kind === "commit")], ["files", "Changed files", (t) => (t.files || []).length > 0], ["deploy", "Deploys", (t) => (t.badges || []).some((b) => b.kind === "deploy" || b.kind === "publish")], ["asks", "Questions", (t) => t.asks > 0]];

function Find({ turns, s, go, close, init }) {
  const [q, setQ] = useState(init || "");
  const [filter, setFilter] = useState(null);
  const [hits, setHits] = useState([]);
  const ref = useRef();
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api(`/api/sessions/${s.sessionId}/search?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.hits || []), () => {}), 220);
    return () => clearTimeout(t);
  }, [q]);
  const ql = q.trim().toLowerCase();
  const f = TX_FILTERS.find((x) => x[0] === filter);
  const rows = new Map();
  turns.forEach((t, i) => {
    if (f && !f[2](t)) return;
    if (!ql) { if (f) rows.set(i, ""); return; }
    const file = (t.files || []).find((x) => x.path.toLowerCase().includes(ql));
    if (plain(t.prompt).toLowerCase().includes(ql)) rows.set(i, "");
    else if (file) rows.set(i, `changed ${relPath(file.path, s)}`);
  });
  if (ql) for (const h of hits) if (!f || f[2](turns[h.turn] || {})) if (!rows.get(h.turn) && !plain(turns[h.turn]?.prompt).startsWith(plain(h.text).replace(/^…/, "").slice(0, 30))) rows.set(h.turn, h.text);
  const list = [...rows].sort((a, b) => b[0] - a[0]);
  return html`<div class="pop find" role="dialog" aria-label="Find in this session">
    <div class="find-in"><input ref=${ref} value=${q} placeholder="Find in this session: words, files, commands" onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && list[0]) { go(list[0][0], false, q); close(); } }} /><button class="x" onClick=${close} aria-label="Close">✕</button></div>
    <div class="filters">${TX_FILTERS.map(([k, label]) => html`<button aria-pressed=${filter === k} onClick=${() => setFilter(filter === k ? null : k)}>${label}</button>`)}</div>
    ${(ql || f) && html`<ul class="hitlist">${list.length === 0 && html`<li class="none">No turn matches.</li>`}${list.slice(0, 40).map(([i, text]) => html`<li><button onClick=${() => { go(i, false, q); close(); }}>
      <span class="t">${txClock(turns[i].at)}</span><span class="a">${t0(turns[i])}</span>${text && html`<span class="b">${text}</span>`}</button></li>`)}</ul>`}
  </div>`;
}

function highlight(el, q) {
  if (!el || !q || !window.CSS?.highlights) return;
  const ranges = [], needle = q.toLowerCase();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.data.toLowerCase();
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + needle.length)) {
      const r = new Range(); r.setStart(n, i); r.setEnd(n, i + needle.length); ranges.push(r);
    }
  }
  CSS.highlights.set("tx-find", new Highlight(...ranges));
  ranges[0]?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function wavFrom(buf) {
  const ch = buf.getChannelData(0), rate = buf.sampleRate, out = new DataView(new ArrayBuffer(44 + ch.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + ch.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, ch.length * 2, true);
  ch.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([out], { type: "audio/wav" });
}

function useDictation(onText, say) {
  const [state, setState] = useState("idle");
  const rec = useRef(null);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream), chunks = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("busy");
        try {
          const ctx = new AudioContext();
          const buf = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
          ctx.close();
          const res = await fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wavFrom(buf) });
          if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
          const text = (await res.json()).text?.trim();
          if (text) onText(text);
        } catch (e) { say(`Couldn't transcribe: ${e.message}`); }
        setState("idle");
      };
      r.start();
      rec.current = r;
      setState("rec");
    } catch (e) { say(`The microphone isn't available: ${e.message}`); }
  };
  const stop = () => rec.current?.state === "recording" && rec.current.stop();
  return { state, toggle: () => (state === "rec" ? stop() : state === "idle" && start()) };
}

function useDock() {
  const root = useRef();
  useLayoutEffect(() => {
    const el = root.current, wrap = el?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => wrap.style.setProperty("--dock", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); wrap.style.removeProperty("--dock"); };
  }, []);
  return root;
}

function ResumeBar({ s, resume, busy }) {
  const root = useDock();
  return html`<div class="composer" ref=${root}>
    <div class="in">
      <div class="box resumebar">
        <span>${s.state === "stopped" ? "Stopped." : "Not running."} Resume it to pick up where it left off.</span>
        <button class="go" disabled=${busy} onClick=${resume}>${busy ? "Resuming…" : "Resume"}</button>
      </div>
    </div>
  </div>`;
}

function BgStrip({ s }) {
  const seen = useRef(new Map());
  const [open, setOpen] = useState(() => pref("atc.bgopen", "on") === "on");
  const [more, setMoreRaw] = useState(null);
  const [src, setSrc] = useState({});
  const setMore = (id) => {
    setMoreRaw(id);
    if (id && !src[id]) api(`/api/sessions/${s.sessionId}/tasks/${encodeURIComponent(id)}`).then((r) => setSrc((m) => ({ ...m, [id]: r })), () => {});
  };
  useNow(1000);
  const now = Date.now(), cur = s.background || [], ids = new Set(cur.map((t) => t.id));
  for (const t of cur) seen.current.set(t.id, { ...t, done: t.doneAt || 0 });
  for (const [id, t] of seen.current) if (!ids.has(id) && !t.done) t.done = now;
  const all = [...seen.current.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const running = all.filter((t) => !t.done).length;
  if (!all.length) return null;
  if (!running && now - Math.max(...all.map((t) => t.done)) > 60e3) { seen.current.clear(); return null; }
  const word = (n) => (all.every((t) => t.kind === "agent") ? (n === 1 ? "agent" : "agents") : n === 1 ? "task" : "tasks");
  const toggle = () => { setOpen(!open); setPref("atc.bgopen", open ? "off" : "on"); };
  return html`<div class="bgstrip ${running ? "" : "finished"}">
    <button class="bg-head" onClick=${toggle} aria-expanded=${open && running > 0}>
      <span class="bg-dot ${running ? "run" : ""}"></span>
      <span>${running ? `${running} ${word(running)} running in the background` : `${all.length} background ${word(all.length)} finished`}</span>
      ${running > 0 && all.length > running && html`<span class="bg-sub">${all.length - running} done</span>`}
      ${running > 0 && html`<svg class="bg-chev ${open ? "open" : ""}" width="12" height="12" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`}
    </button>
    ${open && running > 0 && html`<ul>${all.map((t) => html`<li class="${t.done ? "done" : ""} ${more === t.id ? "more" : ""}" onClick=${() => setMore(more === t.id ? null : t.id)}>
      <span class="bg-k">${t.kind === "shell" ? "shell" : "agent"}</span>
      <span class="bg-l" title=${more === t.id ? null : t.label}>${more === t.id
        ? html`${src[t.id]?.description && t.kind === "shell" && html`<b>${src[t.id].description}</b>`}${src[t.id]?.detail || t.label}`
        : t.kind === "shell" ? t.label.replace(/^cd \S+ && /, "") : t.label}</span>
      <span class="bg-t">${t.done ? "done" : t.startedAt ? txSpan(now - t.startedAt) : "running"}</span>
    </li>`)}</ul>`}
  </div>`;
}

function Composer({ s, say, draft, setDraft, quotes, setQuotes, send, replies, focusRef, working, top }) {
  const ta = useRef();
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [atts, setAtts] = useState([]);
  const [big, setBig] = useState(null);
  focusRef.current = () => ta.current?.focus();
  const dict = useDictation((t) => setDraft((d) => (d ? `${d.trimEnd()} ${t}` : t)), say);
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, innerHeight * 0.4) + "px"; } }, [draft]);
  const go = async () => {
    const paths = atts.map((a) => (/\s/.test(a.path) ? `"${a.path}"` : a.path)).join("\n");
    const text = [...quotes.map((q) => q.split("\n").map((l) => `> ${l}`).join("\n")), draft.trim(), paths].filter(Boolean).join("\n\n");
    if (!text || busy || atts.some((a) => !a.path)) return;
    setBusy(true);
    setDraft("");
    setQuotes([]);
    setAtts([]);
    await send(text);
    setBusy(false);
  };
  const upload = async (files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f, f.name);
      const id = Math.random().toString(36).slice(2);
      setAtts((as) => [...as, { id, name: f.name, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : null }]);
      try {
        const res = await fetch(`/api/sessions/${s.sessionId}/upload`, { method: "POST", body: fd });
        if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
        const path = (await res.json()).path;
        setAtts((as) => as.map((a) => (a.id === id ? { ...a, path } : a)));
      } catch (e) {
        setAtts((as) => as.filter((a) => a.id !== id));
        say(`Uploading ${f.name} failed: ${e.message}`);
      }
    }
    ta.current?.focus();
  };
  const press = useRef(), held = useRef(false);
  const fill = (text) => { setDraft(text); requestAnimationFrame(() => { const el = ta.current; el?.focus(); el?.setSelectionRange(text.length, text.length); }); };
  const ready = (draft.trim() || quotes.length || atts.length) && !busy && !atts.some((a) => !a.path);
  const asked = s.asks?.[0]?.questions;
  const hint = asked ? (asked.length === 1 ? "Or type your own answer" : "Answer the questions above") : working ? "Queue a message for Claude" : s.state === "needs-you" ? "Claude is waiting on you" : "Reply to Claude";
  const root = useDock();
  return html`<div class="composer ${drag ? "drag" : ""}" ref=${root} onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)} onDrop=${(e) => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]); }}>
    <div class="in">
      ${top}
      ${s.asks?.length > 0 && html`<div class="ask-card asking"><${AskBar} s=${s} say=${say} /></div>`}
      ${replies?.length > 0 && !s.asks?.length && !draft && !quotes.length && html`<div class="ask-card"><div class="quick" role="group" aria-label="Suggested replies">
        ${replies.map((t) => html`<span class="sugg"><button title=${touch ? "Tap to send, hold to edit first" : `Send “${t}”`} onClick=${() => !held.current && send(t, { suggested: true })}
          onPointerDown=${() => { held.current = false; clearTimeout(press.current); press.current = setTimeout(() => { held.current = true; fill(t); }, 450); }}
          onPointerUp=${() => clearTimeout(press.current)} onPointerLeave=${() => clearTimeout(press.current)} onContextMenu=${(e) => touch && e.preventDefault()}>${t}</button>${!touch && html`<button class="edit" title="Edit before sending" aria-label=${`Edit “${t}” before sending`} onClick=${() => fill(t)}><svg width="13" height="13" viewBox="0 0 16 16"><path d="M10.5 2.5l3 3-8 8H2.5v-3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>`}</span>`)}
      </div></div>`}
      ${quotes.length > 0 && html`<div class="quotes">${quotes.map((q, j) => html`<div class="qchip"><span>${q}</span><button aria-label="Remove quote" onClick=${() => setQuotes(quotes.filter((_, k) => k !== j))}>✕</button></div>`)}</div>`}
      ${atts.length > 0 && html`<div class="atts">${atts.map((a) => html`<div class="att ${a.path ? "" : "up"}" title=${a.name}>
        ${a.url ? html`<img src=${a.url} alt=${a.name} onClick=${() => setBig(a.url)} />` : html`<span>${a.name}</span>`}
        <button aria-label=${`Remove ${a.name}`} onClick=${() => setAtts(atts.filter((x) => x.id !== a.id))}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`)}</div>`}
      ${big && html`<div class="lightbox" onClick=${() => setBig(null)}><img src=${big} alt="" /></div>`}
      <div class="box ${ready ? "ready" : ""}" onClick=${(e) => e.target === e.currentTarget && ta.current?.focus()}>
        <textarea ref=${ta} rows="1" value=${draft} placeholder=${hint} enterkeyhint=${touch ? "enter" : "send"}
          onInput=${(e) => setDraft(e.target.value)}
          onPaste=${(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); upload(fs); } }}
          onKeyDown=${(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); go(); }
            else if (e.key === "Escape") e.target.blur();
          }}></textarea>
        <div class="tools">
          <label class="tool" title="Attach a file"><input type="file" multiple hidden onChange=${(e) => { upload([...e.target.files]); e.target.value = ""; }} /><svg width="16" height="16" viewBox="0 0 16 16"><path d="M10.5 4.5l-5 5a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.4 7.4a4.5 4.5 0 0 0 6.4 6.4l3.7-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></label>
          ${VOICE_OK && html`<button class="tool ${dict.state}" title=${dict.state === "rec" ? "Stop and transcribe" : "Dictate"} onClick=${dict.toggle} disabled=${dict.state === "busy"}><svg width="16" height="16" viewBox="0 0 16 16"><rect x="5.5" y="1.5" width="5" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 8a5 5 0 0 0 10 0M8 13v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`}
          <button class="send" disabled=${!ready} onClick=${go} title="Send (Enter)" aria-label="Send">${busy ? html`<span class="spin"></span>` : html`<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`}</button>
        </div>
      </div>
    </div>
  </div>`;
}

const pendingOf = (sid) => txStore.get(`pending.${sid}`, []).filter((p) => Date.now() - p.at < 6 * 3600e3).map((p) => (p.state === "sending" ? { ...p, state: "sent" } : p));

const UPLOADED = /^"?[^\n"]*\/\.cache\/atc\/uploads\/[^\n]*$/gm;
const unpathed = (t) => t.replace(UPLOADED, "").trim();

function Pending({ p, retry, drop }) {
  const text = unpathed(p.text), n = (p.text.match(UPLOADED) || []).length;
  return html`<section class="turn pending">
    <span class="node live" aria-hidden="true"></span>
    <div class="prompt">${text}${n > 0 && html`<div class="att-note">${n === 1 ? "1 attachment" : `${n} attachments`}</div>`}</div>
    <p class="live-line pend ${p.state}"><span class="dot"></span>${p.state === "sending" ? "Sending" : p.state === "failed" ? html`Not sent: ${p.err} <button onClick=${retry}>Try again</button><button onClick=${drop}>Discard</button>` : p.queued ? "Queued. Claude reads it after its current step" : "Sent. Waiting for Claude"}</p>
  </section>`;
}

const SEL_ASKS = [["Explain", "explain this part:"], ["Push back", "i'm not sure about this:"], ["Do this", "go ahead with this:"]];

function SelBar({ sel, live, act }) {
  return html`<div class="selbar" style=${`left:${sel.x}px;top:${sel.y}px`} onMouseDown=${(e) => e.preventDefault()}>
    ${live && html`<button onClick=${() => act("quote")}>Quote</button>`}
    ${live && SEL_ASKS.map(([label, lead]) => html`<button onClick=${() => act("ask", lead)}>${label}</button>`)}
    <button onClick=${() => act("copy")}>Copy</button>
    <button onClick=${() => act("find")}>Find</button>
  </div>`;
}

function copyText(text) {
  try { navigator.clipboard.writeText(text); } catch { const ta = Object.assign(document.createElement("textarea"), { value: text }); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
}

function Transcript({ s, say, slot, resume, busy, voice, onVoiceOff }) {
  const wide = useWide();
  const [idx, setIdx] = useState(null);
  const [bodies, setBodies] = useState({});
  const [err, setErr] = useState(null);
  const [level, setLevelRaw] = useState(() => txStore.get("level", 2));
  const [prefs, setPrefsRaw] = useState(() => ({ face: "news", size: 1, width: 1, ...txStore.get("prefs", {}) }));
  const [pop, setPop] = useState(null);
  const [opened, setOpened] = useState(() => new Set());
  const [inView, setInView] = useState(() => new Set());
  const [sel, setSel] = useState(null);
  const [below, setBelow] = useState(false);
  const [fresh, setFresh] = useState(0);
  const [shot, setShot] = useState(null);
  const [pending, setPendingRaw] = useState(() => pendingOf(s.sessionId));
  const setPending = (f) => setPendingRaw((ps) => { const n = typeof f === "function" ? f(ps) : f; txStore.set(`pending.${s.sessionId}`, n.length ? n : null); return n; });
  const [draft, setDraftRaw] = useState(() => txStore.get(`draft.${s.sessionId}`, ""));
  const [quotes, setQuotes] = useState([]);
  const box = useRef(), landed = useRef(false), atEnd = useRef(false), loading = useRef(new Set()), focusInput = useRef(() => {}), findQ = useRef("");
  const seenAt = useRef(txStore.get(`seen.${s.sessionId}`, null));
  const live = s.attachable || s.harness === "opencode";
  const working = s.state === "working" && !s.turnDone;
  const turns = idx || [];

  const setDraft = (v) => setDraftRaw((d) => { const n = typeof v === "function" ? v(d) : v; txStore.set(`draft.${s.sessionId}`, n || null); return n; });

  const loadIdx = async () => {
    try {
      const r = await api(`/api/sessions/${s.sessionId}/turns`);
      setIdx(r.turns || []);
      setErr(null);
    } catch (e) { setErr(e.message); setIdx((x) => x || []); }
  };
  const need = async (i) => {
    const t = turns[i];
    if (!t) return;
    const have = bodies[t.from];
    const key = `${t.from}:${t.to}`;
    if ((have && have.to === t.to) || loading.current.has(key)) return;
    loading.current.add(key);
    try {
      const p = await api(`/api/sessions/${s.sessionId}/transcript?from=${t.from}&to=${t.to}`);
      setBodies((b) => (b[t.from]?.to > t.to ? b : { ...b, [t.from]: { to: t.to, ...bodyOf(p.messages || []) } }));
    } catch (e) { setErr(e.message); }
    loading.current.delete(key);
  };

  useEffect(() => { landed.current = false; setIdx(null); setBodies({}); setOpened(new Set()); setPendingRaw(pendingOf(s.sessionId)); setQuotes([]); setDraftRaw(txStore.get(`draft.${s.sessionId}`, "")); seenAt.current = txStore.get(`seen.${s.sessionId}`, null); loadIdx(); }, [s.sessionId]);
  useEffect(() => { if (idx) loadIdx(); }, [s.updated, s.state]);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(loadIdx, 10000);
    return () => clearInterval(t);
  }, [working, s.sessionId]);

  const firstOpen = useMemo(() => {
    if (!turns.length) return 0;
    const i = seenAt.current ? turns.findIndex((t) => !t.partial && t.at > seenAt.current) : -1;
    return i < 0 ? turns.length - 1 : Math.max(i, turns.length - 2);
  }, [turns.length > 0, s.sessionId]);
  const isOpen = (i) => level === 3 || i >= firstOpen || opened.has(i);
  const folded = (i) => level === 2 && !isOpen(i);
  const openTurn = (i) => setOpened((o) => new Set(o).add(i));

  useEffect(() => { for (let i = firstOpen; i < turns.length; i++) if (level !== 1) need(i); }, [idx, level]);
  useEffect(() => { opened.forEach((i) => need(i)); }, [opened]);
  useEffect(() => {
    if (!pending.length || !idx) return;
    const head = (p) => plain(unpathed(p.text)).slice(0, 24);
    const said = (t) => plain(t.prompt.replace(/\[Image #\d+\]\s*/g, ""));
    const landed = (p) => turns.some((t) => (t.at && new Date(t.at) >= p.at - 60000 && (head(p) ? said(t).startsWith(head(p)) : t.images > 0 || /\[Image #\d+\]/.test(t.prompt))) || (head(p) && (t.notes || []).some((n) => plain(n).startsWith(head(p)))));
    const passed = (p) => turns.some((t) => t.at && new Date(t.at) > p.at + 60000);
    const stale = (p) => passed(p) || (!working && Date.now() - p.at > 5 * 60e3);
    const gone = (p) => p.state !== "failed" && landed(p) || p.state === "sent" && stale(p);
    if (pending.some(gone)) setPending((ps) => ps.filter((p) => !gone(p)));
  }, [idx, pending]);

  useEffect(() => {
    const f = TX_FACES[prefs.face] || TX_FACES.news, st = box.current?.parentElement?.style;
    if (!st) return;
    st.setProperty("--rf", f.css);
    st.setProperty("--rs", `${f.sizes[prefs.size]}px`);
    st.setProperty("--rl", f.lh);
    st.setProperty("--measure", `${[600, 660, 740][prefs.width]}px`);
    txStore.set("prefs", prefs);
  }, [prefs]);
  const setPrefs = (p) => setPrefsRaw((cur) => ({ ...cur, ...p }));

  const topTurn = () => {
    const el = box.current, top = el?.getBoundingClientRect().top || 0;
    const rows = [...(el?.querySelectorAll("[data-i]") || [])];
    const r = rows.find((e) => e.getBoundingClientRect().bottom > top + 60) || rows[0];
    return r ? { i: +r.dataset.i, off: r.getBoundingClientRect().top } : null;
  };
  const go = (i, instant, q) => {
    if (level === 1) setLevelRaw(2);
    if (!isOpen(i)) openTurn(i);
    need(i);
    const jump = (n = 0) => requestAnimationFrame(() => {
      const el = box.current?.querySelector(`#tx${i}`);
      if (!el) return;
      el.scrollIntoView({ behavior: instant || level === 1 ? "instant" : "smooth", block: "start" });
      if (q) { if (el.querySelector(".prose, .story") || n > 20) highlight(el, q); else setTimeout(() => jump(n + 1), 150); }
    });
    jump();
  };
  const anchor = useRef(null);
  const setLevel = (l) => { anchor.current = level === 1 ? null : topTurn(); setLevelRaw(l); txStore.set("level", l); };
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    const el = a && box.current?.querySelector(`#tx${a.i}`);
    if (el) box.current.scrollTop += el.getBoundingClientRect().top - a.off;
  }, [level]);

  const openBodies = turns.filter((_, i) => i >= firstOpen).map((t) => bodies[t.from]);
  const ready = idx && (level === 1 || openBodies.every(Boolean));
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !idx) return;
    if (!landed.current && ready) {
      landed.current = true;
      atEnd.current = level !== 1;
      const land = () => { if (atEnd.current) el.scrollTop = el.scrollHeight; };
      land();
      document.fonts.ready.then(() => requestAnimationFrame(land));
      if (turns.length) txStore.set(`seen.${s.sessionId}`, turns[turns.length - 1].at);
    } else if (landed.current && atEnd.current) el.scrollTop = el.scrollHeight;
    if (landed.current && turns.length) txStore.set(`seen.${s.sessionId}`, turns[turns.length - 1].at);
  }, [idx, bodies, ready, pending]);

  useEffect(() => {
    const el = box.current, inner = el?.querySelector(".frame");
    if (!inner) return;
    let h = 0;
    const ro = new ResizeObserver(() => {
      if (landed.current && atEnd.current) el.scrollTop = el.scrollHeight;
      else if (landed.current && el.scrollHeight > h + 40) setFresh((n) => n + 1);
      h = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [idx !== null]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      setInView((prev) => {
        const n = new Set(prev);
        for (const e of es) e.isIntersecting ? n.add(+e.target.dataset.i) : n.delete(+e.target.dataset.i);
        return n;
      });
      for (const e of es) if (e.isIntersecting && e.target.matches(".turn")) need(+e.target.dataset.i);
    }, { root: el, rootMargin: "200px 0px 200px 0px" });
    el.querySelectorAll("[data-i]").forEach((x) => io.observe(x));
    return () => io.disconnect();
  }, [idx, level, opened, bodies]);

  useEffect(() => {
    if (!pop) return;
    const off = (e) => !e.target.closest(".pop, .txc button") && setPop(null);
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [pop]);

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (["1", "2", "3"].includes(e.key)) { e.preventDefault(); setLevel(+e.key); }
      else if (e.key === "r" && live) { e.preventDefault(); focusInput.current(); }
      else if (e.key === "f") { e.preventDefault(); findQ.current = ""; setPop("find"); }
      else if (e.key === "Escape") { setPop(null); setShot(null); setSel(null); CSS.highlights?.delete("tx-find"); }
    };
    const onSel = () => {
      const g = getSelection(), txt = g?.toString().trim();
      const node = g?.anchorNode?.parentElement?.closest?.(".tx .col");
      if (!txt || txt.length < 2 || !node || g.anchorNode.parentElement.closest(".composer")) return setSel(null);
      const r = g.getRangeAt(0).getBoundingClientRect(), b = box.current.parentElement.getBoundingClientRect();
      const below = touch || r.top - b.top < 60;
      setSel({ text: txt, x: Math.min(b.width - 330, Math.max(8, r.left - b.left + r.width / 2 - 160)), y: below ? r.bottom - b.top + 10 : r.top - b.top - 46 });
    };
    addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSel);
    return () => { removeEventListener("keydown", onKey); document.removeEventListener("selectionchange", onSel); };
  }, [level, live]);

  const quote = (text) => { setQuotes((q) => [...q, text]); requestAnimationFrame(() => focusInput.current()); };
  const selAct = (what, lead) => {
    const text = sel.text;
    getSelection().removeAllRanges();
    setSel(null);
    if (what === "copy") return copyText(text);
    if (what === "find") { findQ.current = text; return setPop("find"); }
    setQuotes((q) => [...q, text]);
    if (what === "ask") setDraft((d) => d || lead + " ");
    requestAnimationFrame(() => focusInput.current());
  };

  const send = async (text, { retryId, suggested } = {}) => {
    const ask = s.asks?.[0];
    if (ask?.permission && !s.harness) { say("Allow or reject the request above first."); return false; }
    if (ask && !ask.permission) {
      if (ask.questions?.length !== 1) { say("Answer the questions above first."); return false; }
      try { await api(`/api/sessions/${s.sessionId}/asks/${ask.id}`, { method: "POST", body: { answers: [[text]] } }); return true; }
      catch (e) { say(e.message); return false; }
    }
    const id = retryId || Math.random().toString(36).slice(2);
    const p = { id, text, at: Date.now(), state: "sending", queued: working };
    setPending((ps) => [...ps.filter((x) => x.id !== id), p]);
    atEnd.current = true;
    try {
      await api(`/api/sessions/${s.id || s.sessionId}/send`, { method: "POST", body: { text, suggested } });
      setPending((ps) => ps.map((x) => (x.id === id ? { ...x, state: "sent" } : x)));
      setTimeout(loadIdx, 1500);
      return true;
    } catch (e) {
      setPending((ps) => ps.map((x) => (x.id === id ? { ...x, state: "failed", err: e.message } : x)));
      return true;
    }
  };

  const onClick = (e) => {
    const j = e.target.closest("a[data-jump]");
    if (j) { e.preventDefault(); box.current.querySelector(j.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  };

  const last = turns[turns.length - 1], lastBody = last && bodies[last.from];
  const running = working && lastBody ? txSteps(lastBody.items).findLast((x) => !x.out) : null;
  const replies = live && !working && !pending.length && s.state === "your-turn" && !s.asks?.length ? s.summary?.replies : null;
  const nFolded = turns.filter((_, i) => folded(i)).length;
  const cost = turns.reduce((a, t) => a + (t.cost || 0), 0);
  const files = new Set(turns.flatMap((t) => (t.files || []).filter((f) => !scratch(f.path)).map((f) => f.path))).size;
  const controls = html`<div class="txc">
    <button class="tb lv" aria-pressed=${pop === "level"} onClick=${() => setPop(pop === "level" ? null : "level")} title=${`Showing: ${TX_LEVELS[level - 1][1]} (1 2 3)`}><svg width="15" height="15" viewBox="0 0 16 16">${level === 1 ? html`<path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` : level === 2 ? html`<path d="M3 3.5h10M3 7h7M3 10.5h10M3 13h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` : html`<path d="M3 3h10M5 5.5h8M5 8h8M3 10.5h10M5 13h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`}</svg>${level !== 2 && html`<span class="lv-n">${TX_LEVELS[level - 1][2]}</span>`}</button>
    <button class="tb" aria-pressed=${pop === "find"} onClick=${() => { findQ.current = ""; setPop(pop === "find" ? null : "find"); }} title="Find in this session (f)"><svg width="15" height="15" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
    <button class="tb" aria-pressed=${pop === "results"} onClick=${() => setPop(pop === "results" ? null : "results")} title="What this session produced"><svg width="15" height="15" viewBox="0 0 16 16"><path d="M3 2.5h7l3 3v8H3z M10 2.5v3h3 M5.5 8.5h5M5.5 11h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>${files > 0 && html`<span class="n">${files}</span>`}</button>
    <button class="tb aa" aria-pressed=${pop === "prefs"} onClick=${() => setPop(pop === "prefs" ? null : "prefs")} title="Reading settings">Aa</button>
  </div>`;
  const inHeader = slot && wide;
  return html`<div class="tx-wrap" style=${`--ph: ${hueOf(project(s.cwd || "").name)}`}>
    ${inHeader && html`<${Into} node=${slot}>${controls}<//>`}
    <div class="tx" ref=${box} onClick=${onClick} onScroll=${(e) => { const el = e.target; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; setBelow(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 0.6); if (atEnd.current) setFresh(0); setSel(null); }}>
      <div class="tx-top ${inHeader ? "bare" : ""}">
        ${!inHeader && controls}
        ${pop === "prefs" && html`<${Prefs} prefs=${prefs} set=${setPrefs} />`}
        ${pop === "level" && html`<${Levels} level=${level} set=${(l) => { setLevel(l); setPop(null); }} />`}
        ${pop === "find" && html`<${Find} turns=${turns} s=${s} go=${go} close=${() => setPop(null)} init=${findQ.current} key=${findQ.current} />`}
        ${pop === "results" && html`<${Results} turns=${turns} s=${s} bodies=${bodies} need=${need} go=${go} close=${() => setPop(null)} />`}
      </div>
      <div class="frame">
        <main class="col ${level === 1 ? "" : "spined"}">
          ${err && html`<p class="err">${err}</p>`}
          ${idx === null && !err && html`<div class="skeleton big"><i></i><i></i><i></i><i></i></div>`}
          ${idx && turns.length === 0 && !pending.length && html`<p class="cont empty">No messages yet.${live ? " Write the first one below." : ""}</p>`}
          ${level === 1 ? html`<${Outline} turns=${turns} go=${go} />` : html`
            ${nFolded > 0 && html`<div class="earlier"><span>${nFolded} earlier turn${nFolded > 1 ? "s" : ""} you've read</span><button onClick=${() => setOpened(new Set(turns.map((_, i) => i)))}>Open all</button></div>`}
            ${turns.map((t, i) => html`
              ${i > 0 && html`<${Lapse} a=${turns[i - 1]} b=${t} />`}
              ${folded(i)
                ? html`<${Folded} key=${`f${t.from}`} t=${t} i=${i} open=${openTurn} />`
                : html`${i === firstOpen && firstOpen > 0 && html`<div class="since">${firstOpen === turns.length - 1 ? "Latest" : `${turns.length - firstOpen} new since you last read`}</div>`}<${Turn} key=${`t${t.from}`} t=${t} i=${i} s=${s} body=${bodies[t.from]} level=${level} zoom=${setShot} quote=${live ? quote : null} latest=${i === turns.length - 1} live=${working && i === turns.length - 1} fresh=${opened.has(i)} />`}`)}
            ${pending.map((p) => html`<${Pending} key=${p.id} p=${p} retry=${() => send(p.text, { retryId: p.id })} drop=${() => setPending((ps) => ps.filter((x) => x.id !== p.id))} />`)}
            ${working && !pending.some((p) => p.state !== "failed") && html`<${Thinking} since=${lastAt(lastBody) || last?.end} step=${running} />`}
          `}
        </main>
      </div>
      ${sel && html`<${SelBar} sel=${{ ...sel, y: sel.y + (box.current?.scrollTop || 0) - 0 }} live=${live} act=${selAct} />`}
    </div>
    ${level !== 1 && html`<${Scrub} turns=${turns} inView=${inView} go=${go} />`}
    ${level !== 1 && below && html`<button class="to-end ${fresh ? "fresh" : ""}" onClick=${() => { atEnd.current = true; setFresh(0); box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" }); }} aria-label="Jump to the latest">
      ${fresh > 0 && html`<span>${working ? "New activity" : "New reply"}</span>`}<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`}
    ${!live && resume && s.kind !== "interactive" && level !== 1 && html`<${ResumeBar} s=${s} resume=${resume} busy=${busy} />`}
    ${live && voice && html`<${VoiceBar} s=${s} say=${say} type=${(t) => send(t)} onClose=${onVoiceOff} top=${html`<${BgStrip} s=${s} />`}
      press=${(k) => api(`/api/sessions/${s.id || s.sessionId}/keys`, { method: "POST", body: { keys: k } }).catch((e) => say(e.message))} />`}
    ${live && !voice && level !== 1 && html`<${Composer} s=${s} say=${say} draft=${draft} setDraft=${setDraft} quotes=${quotes} setQuotes=${setQuotes} send=${send} replies=${replies} focusRef=${focusInput} working=${working} top=${html`<${BgStrip} s=${s} />`} />`}
    ${shot && html`<div class="lightbox" onClick=${() => setShot(null)}><img src=${shot} alt="" /></div>`}
  </div>`;
}

function Into({ node, children }) {
  useLayoutEffect(() => { if (node) render(children, node); });
  useLayoutEffect(() => () => node && render(null, node), [node]);
  return null;
}

function useWide(q = "(min-width: 900px)") {
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q), f = () => setWide(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [q]);
  return wide;
}

function Lapse({ a, b }) {
  const gap = a.end && b.at ? new Date(b.at) - new Date(a.end) : 0;
  const newDay = txDay(a.at) !== txDay(b.at);
  if (!newDay && gap < 3600e3) return null;
  return html`<div class="lapse"><span>${newDay ? txDay(b.at) : `${txSpan(gap).replace(/ \d+s$/, "")} later`}</span></div>`;
}

const shipped = (t) => (t.badges || []).some((b) => b.ok && (b.kind === "commit" || b.kind === "push" || b.kind === "deploy" || b.kind === "publish"));
const Node = ({ t, live }) => html`<span class="node ${shipped(t) ? "ship" : ""} ${live ? "live" : ""}" aria-hidden="true"><span class="node-t">${txClock(t.at)}</span></span>`;

const lastAt = (body) => (body?.items || []).map((it) => it.out?.time || it.time).filter(Boolean).sort().pop();

function Thinking({ since, step }) {
  useNow(1000);
  const ms = Date.now() - new Date(step?.time || since || Date.now());
  const what = step ? `Running ${step.tool}` : "Thinking";
  return html`<p class="live-line"><span class="dot"></span>${ms > 3000 ? `${what} · ${txSpan(ms)}` : step ? what : "Working"}</p>`;
}

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const TX_FILE = /^(~?[\w.\-]+\/)*[\w.\-]+\.(go|js|mjs|ts|tsx|py|md|json|kt|css|html|sh|yml|yaml|toml|rb|sql|txt|service|plist)(:\d+(-\d+)?)?$/;
const safeURL = (u) => /^(https?:|mailto:|\/|#|\.)/i.test(u || "") ? u : null;
const mdRender = new Marked.Renderer();
mdRender.code = (code, lang) => {
  const l = (lang || "").split(/\s/)[0];
  const body = l && hljs.getLanguage(l) ? hljs.highlight(code, { language: l, ignoreIllegals: true }).value : esc(code);
  return `<pre><button class="copy" data-copy>Copy</button><code>${body}</code></pre>`;
};
mdRender.codespan = (t) => `<code class="${TX_FILE.test(t.replace(/&amp;/g, "&")) ? "path" : ""} ${t.length < 28 ? "nowrap" : ""}">${t}</code>`;
mdRender.table = (header, body) => `<div class="tbl"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
mdRender.link = (href, title, text) => safeURL(href) ? `<a href="${esc(href)}" data-out>${text}</a>` : text;
mdRender.image = (href, title, text) => safeURL(href) ? `<a href="${esc(href)}" data-out>${esc(text || href)}</a>` : esc(text || "");
mdRender.html = (h) => esc(h);
Marked.use({
  renderer: mdRender, gfm: true, breaks: false,
  tokenizer: {
    del(src) {
      const m = /^~~(?=\S)([\s\S]*?\S)~~(?!~)/.exec(src);
      if (m) return { type: "del", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      const lone = /^~+/.exec(src);
      return lone ? { type: "text", raw: lone[0], text: lone[0] } : false;
    },
  },
});
const md = (src) => Marked.parse(src || "");

document.addEventListener("click", (e) => {
  const c = e.target.closest?.("[data-copy]");
  if (c) { copyText(c.parentElement.querySelector("code").innerText); c.textContent = "Copied"; setTimeout(() => (c.textContent = "Copy"), 1200); return; }
  const a = e.target.closest?.("a[data-out]");
  if (a) { e.preventDefault(); openOut(a.getAttribute("href")); }
});

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
      <input value=${dir} onInput=${(e) => setDir(e.target.value, true)} placeholder="~/projects/app" ref=${autofocus && !touch ? focusOnMount : null} autocapitalize="off" autocomplete="off" spellcheck="false" />
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

function NewSession({ onClose, say, hosts, home, start: from }) {
  const [host, setHost] = useState(from?.host || home);
  const dirs = useDirs(host, home);
  const [dir, setDir] = useState(from?.dir ? tilde(from.dir) : "~");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [presets, setPresets] = useState([]);
  const [preset, setPreset] = useState(null);
  useEffect(() => { api("/api/presets").then((p) => setPresets(p || []), () => {}); }, []);
  const [engines, setEngines] = useState([]);
  const [engine, setEngine] = useState("");
  useEffect(() => { api("/api/engines").then((e) => setEngines(e || []), () => {}); }, []);
  const target = preset ? preset.host || home : host;
  const usable = engines.filter((e) => (e.host || home) === target);
  useEffect(() => { if (!usable.some((e) => e.name === engine)) setEngine(""); }, [target, engines]);
  const harness = usable.find((e) => e.name === engine)?.harness;
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
        ? await api(`/api/sessions${hostQ(preset.host, home)}`, { method: "POST", body: { preset: preset.name, name: name.trim(), prompt, engine } })
        : await api(`/api/sessions${hostQ(host, home)}`, { method: "POST", body: { dir: dir.trim(), name: name.trim(), prompt, worktree: worktree && !harness, engine } });
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
        ${preset ? html`
          <p class="presetnote"><span class="proj" style=${`--ph: ${hueOf(preset.name)}`}>${preset.name}</span> starts in <b>${tilde(preset.dir)}</b>${MULTI && preset.host ? html` on <b>${preset.host}</b>` : ""}${preset.brief ? html`, with the instructions in <b>${preset.brief}</b>` : ""}. <button type="button" class="link" onClick=${() => setPreset(null)}>Pick a folder instead</button></p>
        ` : html`
          <${HostField} hosts=${hosts} host=${host} setHost=${(h) => { setHost(h); setDir("~"); }} />
          <${FolderField} dirs=${dirs} dir=${dir} setDir=${setDir} autofocus />
          ${!harness && html`<${WorktreeField} dirs=${dirs} dir=${dir} on=${worktree} setOn=${setWorktree} />`}`}
        <label class="field"><span>Name</span><input value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${preset ? preset.name : "Optional"} />${!preset && html`<small>Without one, ${harness || "Claude"} titles the session from what you ask.</small>`}</label>
        <label class="field"><span>First message</span><textarea rows="3" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder="Optional. You can also type it in the terminal."></textarea></label>
        ${err && html`<p class="err">${err}</p>`}
        ${usable.length > 0 && html`
          <p class="presetline">Model:${[{ name: "" }, ...usable].map((e) => html` <button type="button" class="pick ${e.name === engine ? "on" : ""}" title=${e.harness ? `${e.harness}${e.model ? ` on ${e.model}` : ""}` : e.model || "Claude, as configured"}
            onClick=${() => setEngine(e.name)}>${e.name || "Claude"}</button>`)}</p>`}
        ${presets.length > 0 && !preset && html`
          <p class="presetline">Or use a preset:${presets.map((p) => html` <button type="button" class="proj" style=${`--ph: ${hueOf(p.name)}`} title=${`${MULTI && p.host ? p.host + ": " : ""}${tilde(p.dir)}`} onClick=${() => setPreset(p)}>${p.name}</button>`)}</p>`}
        <div class="actions">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn primary" disabled=${(!preset && !dir.trim()) || busy}>${busy ? "Starting…" : "Start session"}</button>
        </div>
      </form>
    </div>
  `;
}

function fuzzy(q, text) {
  if (!q) return { score: 1, hits: [] };
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return { score: 200 - i + (i === 0 || /[\s/_-]/.test(t[i - 1]) ? 50 : 0), hits: [...Array(q.length).keys()].map((k) => i + k) };
  const hits = [];
  let j = 0, gaps = 0, last = -1;
  for (let k = 0; k < t.length && j < q.length; k++) {
    if (t[k] === q[j]) { hits.push(k); if (last >= 0) gaps += k - last - 1; last = k; j++; }
  }
  return j === q.length ? { score: 100 - gaps - hits[0], hits } : null;
}

function marked(text, hits) {
  if (!hits?.length) return text;
  const set = new Set(hits);
  const out = [];
  let run = "", on = false;
  [...text].forEach((c, k) => {
    const h = set.has(k);
    if (h !== on && run) { out.push(on ? html`<b>${run}</b>` : run); run = ""; }
    on = h; run += c;
  });
  if (run) out.push(on ? html`<b>${run}</b>` : run);
  return out;
}

function Palette({ live, sel, say, home, actions, onClose }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [presets, setPresets] = useState([]);
  const [dirs, setDirs] = useState([]);
  const [past, setPast] = useState([]);
  const list = useRef();
  useEffect(() => {
    api("/api/presets").then((p) => setPresets(p || []), () => {});
    api("/api/dirs").then((d) => setDirs(d || []), () => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => api(`/api/history?limit=${q ? 12 : 6}&q=${encodeURIComponent(q)}`).then((h) => setPast(h || []), () => {}), q ? 120 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const run = (f) => () => { onClose(); f(); };
  const items = [];
  const add = (group, label, opts) => items.push({ group, label, ...opts });
  const cur = SESSION_API;
  if (cur && sel) {
    const s = cur.s;
    const act = (label, f, kw = "") => add(`This session: ${s.title || "Untitled"}`, label, { run: run(f), kw, glyph: "›" });
    if (cur.canAttach) act("Terminal", () => cur.mode("term"), "shell attach");
    act("Transcript", () => cur.mode("chat"), "read conversation");
    act("Outputs", () => cur.mode("out"), "files servers links");
    if (cur.canAttach && VOICE_OK) act("Voice", cur.voice, "talk speak mic");
    act("Usage", cur.usage, "tokens cost limit");
    act("Rename", cur.rename, "title name");
    act(s.pinned ? "Unpin" : "Pin to top", () => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { pinned: !s.pinned } }));
    act(s.parked ? "Unpark" : "Park", () => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { parked: !s.parked } }), "hide quiet");
    if (s.attachable) act("Stop", () => api(`/api/sessions/${s.sessionId}/stop`, { method: "POST" }).then(() => say("Stopped. Resume it any time.")), "end");
  }
  for (const s of live) add("Sessions", s.title || "Untitled", { s, kw: `${project(s.cwd).name} ${s.host || ""} ${s.lastPrompt || ""}`, run: run(() => go(keyOf(s))) });
  const liveIDs = new Set(live.map((s) => s.sessionId));
  for (const s of past.filter((s) => !liveIDs.has(s.sessionId))) add("Earlier", s.title || "Untitled", { s, kw: project(s.cwd).name, run: run(() => go(s.sessionId)) });
  if (TABS.tabs.length > 1) {
    const tab = (label, name, sub, opts) => add("Tabs", label, { kw: "tab project", sub: [TABS.only === name && "shown", sub].filter(Boolean).join(" · "), run: run(() => { TABS.set(name); if (matchMedia("(max-width: 899px)").matches) go(null); }), ...opts });
    tab("All", null, "", { glyph: "◌" });
    for (const t of TABS.tabs) tab(t.name, t.name, t.summary, { proj: t.name });
  }
  add("Actions", "New session", { glyph: "+", hint: "n", run: run(() => actions.create()) });
  for (const p of presets) add("Actions", `Start ${p.name}`, { proj: p.name, kw: `preset ${p.dir}`, sub: tilde(p.dir), run: run(() => api(`/api/sessions${hostQ(p.host, home)}`, { method: "POST", body: { preset: p.name } }).then((r) => { say(`Started ${p.name}.`); go(r.id); }, (e) => say(e.message))) });
  add("Actions", "Assistant", { glyph: "◇", hint: "a", kw: "ask chat switchboard", run: run(actions.ask) });
  if (VOICE_OK) add("Actions", "Talk to Claude", { glyph: "◉", hint: "t", kw: "voice assistant", run: run(actions.talk) });
  add("Actions", "Usage and limits", { glyph: "%", hint: "u", kw: "tokens cost week", run: run(actions.usage) });
  add("Actions", "Keyboard shortcuts", { glyph: "?", hint: "?", kw: "help keys", run: run(actions.help) });
  if (q.length > 1) for (const d of dirs.slice(0, 60)) add("New session in", tilde(d.path), { glyph: "+", kw: "folder", run: run(() => actions.create({ dir: d.path })) });

  const ql = q.trim().toLowerCase();
  const shown = [];
  for (const it of items) {
    const m = fuzzy(ql, it.label) || (ql && fuzzy(ql, `${it.label} ${it.kw || ""}`) && { score: 10, hits: [] });
    if (m) shown.push({ ...it, ...m });
  }
  const order = ["Tabs", "Sessions", "Actions", "This session", "Earlier", "New session in"];
  const gi = (g) => order.findIndex((o) => g.startsWith(o));
  if (ql) shown.sort((a, b) => b.score - a.score);
  else shown.sort((a, b) => gi(a.group) - gi(b.group));
  const top = (ql ? shown.slice(0, 40) : shown.filter((x) => x.group !== "Earlier" || past.indexOf(x.s) < 4).slice(0, 40));
  const groups = [];
  for (const it of top) {
    let g = groups.find((g) => g[0] === it.group);
    if (!g) groups.push((g = [it.group, []]));
    g[1].push(it);
  }
  const flat = groups.flatMap((g) => g[1]);
  const pick = Math.min(at, Math.max(0, flat.length - 1));
  useEffect(() => setAt(0), [q]);
  useEffect(() => { list.current?.querySelector(".pi.on")?.scrollIntoView({ block: "nearest" }); }, [pick]);

  const key = (e) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setAt((pick + 1) % Math.max(1, flat.length)); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setAt((pick - 1 + flat.length) % Math.max(1, flat.length)); }
    else if (e.key === "Enter") { e.preventDefault(); flat[pick]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };
  const keyRef = useRef();
  keyRef.current = key;
  useEffect(() => {
    const k = (e) => {
      if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key) && !(e.ctrlKey && (e.key === "n" || e.key === "p"))) return;
      e.stopPropagation();
      keyRef.current(e);
    };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, []);
  let n = -1;
  return html`
    <div class="veil palveil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <div class="pq">
          <span class="ps">${ICON.search}</span>
          <input ref=${focusOnMount} value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Jump to a tab, session or action" autocapitalize="off" autocomplete="off" spellcheck="false" />
          <kbd>esc</kbd>
        </div>
        <div class="plist" ref=${list}>
          ${groups.map(([g, its]) => html`
            <div class="pg">${g}</div>
            ${its.map((it) => { n++; const idx = n; return html`
              <button class=${`pi ${idx === pick ? "on" : ""}`} onPointerMove=${() => idx !== pick && setAt(idx)} onClick=${it.run}>
                ${it.s ? html`<i class=${`dot ${it.s.parked ? "parked" : it.s.state}`}></i>` : it.proj ? html`<span class="proj" style=${`--ph: ${hueOf(it.proj)}`}>${it.proj.slice(0, 2)}</span>` : html`<span class="gl">${it.glyph || "›"}</span>`}
                <span class="pl">${marked(it.label, it.hits)}${it.s && it.s.state === "working" && it.s.activity ? html`<small>${oneLine(it.s.activity)}</small>` : it.sub ? html`<small>${it.sub}</small>` : ""}</span>
                ${it.s ? html`<span class="pr"><${ProjectTag} path=${it.s.cwd} /><span class="when">${ago(it.s)}</span></span>` : it.hint ? html`<kbd>${it.hint}</kbd>` : ""}
              </button>`; })}`)}
          ${flat.length === 0 && html`<p class="calm">Nothing matches "${q}".</p>`}
        </div>
        <div class="pf"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>${MAC ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd> toggle</span></div>
      </div>
    </div>`;
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
        ${files.length > 0 && html`<${FileList} files=${files} remove=${(i) => setFiles(files.filter((_, j) => j !== i))} />`}
        <label class="field"><span>What should Claude do?</span>
          <textarea rows="2" value=${ask} onInput=${(e) => setAsk(e.target.value)} placeholder="Look into this" ref=${touch ? null : focusOnMount}></textarea>
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
