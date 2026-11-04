import { html, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "./vendor/preact-htm.js";
import { marked as Marked } from "./vendor/marked.esm.js";
import hljs from "./vendor/highlight.min.js";
import { diffLines } from "./vendor/diff.mjs";
import { Call } from "./call.js";
import { persona } from "./persona.js";
import { minimal } from "./minimal.js";
import { cube, niceMax } from "./usage-cube.js";

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
const cssColors = (scheme, names) => {
  const probe = document.createElement("i");
  probe.style.cssText = `position: absolute; visibility: hidden; color-scheme: ${scheme}`;
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const out = names.map((n) => ((probe.style.color = `var(--${n})`), cs.color));
  probe.remove();
  return out;
};
const THEMES = { "": "atc", frappe: "Frappé and Dawn", nord: "Nord" };
const NATIVE_COLORS = ["board", "strip", "line", "ink", "dim", "faint", "needs", "turn", "work"];
const hexColor = (css) => {
  const g = (hexColor.g ||= document.createElement("canvas").getContext("2d", { willReadFrequently: true }));
  g.clearRect(0, 0, 1, 1);
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
  return "#" + [a, r, gr, b].map((v) => v.toString(16).padStart(2, "0")).join("");
};
const LOOK = {
  scheme: "auto",
  theme: "",
  sheets: [],
  load() {
    try { this.take(JSON.parse(localStorage.getItem("atc.look"))); } catch {}
    this.sheets = Object.keys(THEMES).filter(Boolean).map((t) => new Promise((done) =>
      document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: `themes/${t}.css`, onload: done, onerror: done }))));
    Promise.all(this.sheets).then(() => this.apply());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.apply());
    this.apply();
  },
  take(l) {
    this.scheme = ["light", "dark"].includes(l?.scheme) ? l.scheme : "auto";
    this.theme = l?.theme in THEMES ? l.theme : "";
  },
  adopt(l) {
    if (!l || (l.scheme === this.scheme && (l.theme || "") === this.theme)) return;
    this.take(l);
    this.apply();
    this.restyle();
  },
  set(k, v) {
    this[k] = v;
    this.apply();
    this.restyle();
    api("/api/look", { method: "PUT", body: { scheme: this.scheme, theme: this.theme } }).catch(() => {});
  },
  message() { return { atc: 1, op: "look", scheme: this.scheme, theme: this.theme }; },
  restyle() {
    for (const d of DOCK.values()) d.term.options.theme = termTheme();
  },
  palettes(names = NATIVE_COLORS, fmt = hexColor) {
    const r = document.documentElement, keep = r.dataset.theme;
    const out = {};
    for (const t of Object.keys(THEMES)) {
      if (t) r.dataset.theme = t; else delete r.dataset.theme;
      out[t || "atc"] = Object.fromEntries(["light", "dark"].map((sc) => [sc, Object.fromEntries(cssColors(sc, names).map((c, i) => [names[i], fmt(c)]))]));
    }
    if (keep) r.dataset.theme = keep; else delete r.dataset.theme;
    return out;
  },
  apply() {
    const r = document.documentElement;
    if (this.scheme === "auto") delete r.dataset.scheme; else r.dataset.scheme = this.scheme;
    if (this.theme) r.dataset.theme = this.theme; else delete r.dataset.theme;
    try { localStorage.setItem("atc.look", JSON.stringify({ scheme: this.scheme, theme: this.theme })); } catch {}
    dispatchEvent(new Event("atc-look"));
    for (const f of document.querySelectorAll("iframe")) f.contentWindow?.postMessage(this.message(), "*");
    for (const m of document.querySelectorAll('meta[name="theme-color"]'))
      m.content = cssColors(this.scheme !== "auto" ? this.scheme : m.media.includes("dark") ? "dark" : "light", ["board"])[0];
    if (window.AtcApp?.setLook) Promise.all(this.sheets).then(() =>
      window.AtcApp.setLook(JSON.stringify({ look: { scheme: this.scheme, theme: this.theme || "atc" }, palettes: this.palettes() })));
  },
};
LOOK.load();
addEventListener("message", (e) => { if (e.data?.atc === 1 && e.data.op === "hello" && e.source) e.source.postMessage(LOOK.message(), "*"); });
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
let PALETTE_OPEN = () => {}, NEW_SESSION = () => {};
let SESSION_API = null;
let ASK = null, ASKED = 0;
const ask = (d) => new Promise((done) => (ASK ? ASK({ ...d, id: ++ASKED, done }) : done(null)));
const focusOnMount = (el) => { if (el && !el.dataset.focused) { el.dataset.focused = "1"; requestAnimationFrame(() => el.focus({ preventScroll: true })); } };
const local = (m) => !!m && !m.startsWith("claude-") && m !== "<synthetic>";
const model = (m) => (local(m) ? m.split("/").pop().split(":")[0] : (m || "").replace(/^claude-/, "").replace(/-\d.*$/, ""));
const engineTag = (s) => s.harness && s.kind !== "hub"
  ? html`<span class="eng" title=${`Runs in ${s.harness}${s.model ? ` on ${s.model}` : ""}, not Claude Code`}>${s.engine || s.harness}</span>`
  : (s.engine || local(s.model)) && html`<span class="eng" title=${`Runs on ${s.engine || s.model}, not Claude`}>${s.engine || model(s.model)}</span>`;
const keyOf = (s) => s.id || s.sessionId;
const go = (k) => (location.hash = k ? `#/s/${k}` : "#/");
const USAGE = "#/usage", PAGES = "#/pages", SETTINGS = "#/settings";
const closeSettings = () => (history.length > 1 ? history.back() : location.replace("#/"));
const pagesHash = (bay = BAY.only, sid, name) => `#/g/${bay ? encodeURIComponent(bay) : "all"}${sid ? `/${encodeURIComponent(sid)}/${encodeURIComponent(name)}` : ""}`;
const pagesRoute = () => {
  const m = location.hash.match(/^#\/g\/([^/]+)(?:\/([^/]+)\/(.+))?$/);
  if (!m) return null;
  const bay = decodeURIComponent(m[1]);
  return { bay: bay === "all" ? null : bay, sid: m[2] ? decodeURIComponent(m[2]) : null, name: m[3] ? decodeURIComponent(m[3]) : null };
};
let PAGES_FROM = null;
const openUsage = () => { if (location.hash !== USAGE) location.hash = USAGE; };
const SCREENS = { usage: "Usage", backlog: "Backlog", agents: "Agents" };
const screenOf = () => location.hash === USAGE ? "usage" : location.hash === BACKLOG ? "backlog" : agentRoute() !== null ? "agents" : null;
const closeScreen = () => { if (screenOf()) { rememberBay(BAY.only, { view: "board" }); go(null); } };

function useRoute() {
  const read = () => (location.hash.match(/^#\/s\/([^/]+)/) || [])[1] || null;
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
let AUTO_VOICE = false, AUTO_PANE = null, AUTO_SPLIT = false;
const WEB = { at: null, fresh: false, shown: Date.now() };
const CALL = "#/call";
let CAN_CALL = false;
const ASSIST = "#/assist";
let ASSIST_FROM = null;
const openAssistant = () => { if (location.hash === ASSIST) return; if (location.hash !== CALL) ASSIST_FROM = location.hash; location.hash = ASSIST; };
const closeAssistant = () => (location.hash = ASSIST_FROM && ASSIST_FROM !== ASSIST ? ASSIST_FROM : "#/");
const CALLDOCK = { open: true, set(v) { CALLDOCK.open = v; dispatchEvent(new Event("atc-calldock")); } };
const isPhone = () => !matchMedia("(min-width: 900px)").matches;
const returnToCall = () => (isPhone() ? (location.hash = CALL) : CALLDOCK.set(true));
const callAssistant = () => {
  if (APP?.call) return APP.call();
  CALLDOCK.set(true);
  Call.dial();
  if (isPhone() && location.hash !== CALL) location.hash = CALL;
};
const KEYLAYERS = [];
function useKeyLayer(fn, on = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return;
    const f = (e) => ref.current(e);
    KEYLAYERS.push(f);
    return () => KEYLAYERS.splice(KEYLAYERS.indexOf(f), 1);
  }, [on]);
}
const typingIn = (t) => t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
let appSent = "";
const FEED_STATES = ["needs-you", "your-turn", "working"];

function App() {
  useSync();
  const [me, setMe] = useState(undefined);
  const [runs, setLive] = useState(null);
  const live = useMemo(() => runs && runs.filter((x) => !hiddenRun(x)), [runs]);
  const reach = useMemo(() => runs && runs.filter((x) => !hiddenRun(x) || x.kind === "hub"), [runs]);
  const hub = runs?.find((x) => x.kind === "hub" && x.agent === "assistant");
  const [agents, setAgents] = useState(null);
  const [up, setUp] = useState(true);
  const [past, setPast] = useState({});
  const [creating, setCreating] = useState(false);
  NEW_SESSION = (start) => setCreating(start || true);
  const [palette, setPalette] = useState(false);
  PALETTE_OPEN = () => setPalette(true);
  const [cursor, setCursor] = useState(null);
  const [quick, setQuick] = useState(null);
  QUICK = (s, rect) => setQuick({ s, rect });
  const [agentUse, setAgentUse] = useState(null);
  AGENT_SHEET = (name, view) => (view === "usage" ? setAgentUse(name) : (location.hash = `${AGENTS_ROUTE}/${encodeURIComponent(name)}`));
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState(null);
  const [agentName, setAgentName] = useState(agentRoute);
  const [limits, setLimits] = useState(null);
  const route = useRoute();
  const [stale, setStale] = useState(null);
  const [panes, setPanesRaw] = useState(() => ({ rail: true, index: true, pgindex: true, aleft: true, ...stored("atc.panes", {}) }));
  const rememberPast = useCallback((list) => setPast((p) => Object.fromEntries([...Object.entries(p), ...list.map((s) => [s.sessionId, s])])), []);
  const [hist, moreHist, canMore] = useBayHistory(!!me, rememberPast);
  const togglePane = (k) => setPanesRaw((p) => { const n = { ...p, [k]: !p[k] }; store("atc.panes", n); return n; });
  const only = useBay();
  const wide = useWide();
  const [peek, setPeek] = useState(null);
  useNow(30000);

  useEffect(() => {
    const load = () => api("/api/me").then((m) => { setMe(m); newWeb(m.web); }, (e) => setMe((m) => (e.auth ? null : m || { host: "" })));
    load();
    const t = setInterval(load, 20000);
    const back = () => {
      if (document.visibilityState !== "visible") return;
      if (WEB.fresh) return location.reload();
      WEB.shown = Date.now();
      load();
    };
    addEventListener("visibilitychange", back);
    return () => { clearInterval(t); removeEventListener("visibilitychange", back); };
  }, []);
  const [updated, setUpdated] = useState(false);
  const newWeb = (v) => {
    if (!v || v === (WEB.at ||= v)) return;
    WEB.fresh = true;
    if (document.visibilityState !== "visible" || Date.now() - WEB.shown < 3000) location.reload();
    else setUpdated(true);
  };

  useEffect(() => {
    if (!me) return;
    const es = new EventSource("/api/events");
    es.addEventListener("sessions", (e) => {
      setLive(steady(JSON.parse(e.data) || []));
      setUp(true);
    });
    es.addEventListener("look", (e) => LOOK.adopt(JSON.parse(e.data)));
    es.addEventListener("seen", (e) => syncEvent("seen", JSON.parse(e.data)));
    es.addEventListener("drafts", (e) => syncEvent("drafts", JSON.parse(e.data)));
    es.addEventListener("bays", (e) => adoptBays(JSON.parse(e.data)));
    loadBays();
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

  const fromCall = () => { if (location.hash !== CALL || isPhone()) return false; history.replaceState(null, "", ASSIST); CALLDOCK.set(true); return true; };
  const [assisting, setAssisting] = useState(() => fromCall() || location.hash === ASSIST);
  const [scr, setScr] = useState(screenOf);
  const shareRoute = () => (location.hash.startsWith("#/share") ? location.hash : null);
  const [sharing, setSharing] = useState(shareRoute);
  const aloneRoute = () => {
    const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(.+))?$/);
    if (!m || !m[2]) return m && false;
    const sid = decodeURIComponent(m[1]), ref = decodeURIComponent(m[2]), at = atOf(ref), name = splitRef(ref)[0];
    if (at) history.replaceState(null, "", aloneLink(sid, name));
    return { sid, name, at };
  };
  const [alone, setAlone] = useState(aloneRoute);
  const readPages = () => { if (location.hash === PAGES) history.replaceState(null, "", pagesHash()); return pagesRoute(); };
  const [pagesAt, setPagesAt] = useState(readPages);
  const [settings, setSettings] = useState(location.hash === SETTINGS);
  const [calling, setCalling] = useState(location.hash === CALL);
  useEffect(() => {
    const f = () => { setAssisting(fromCall() || location.hash === ASSIST); setCalling(location.hash === CALL); setScr(screenOf()); setAgentName(agentRoute()); setSharing(shareRoute()); setAlone(aloneRoute()); setPagesAt(readPages()); setSettings(location.hash === SETTINGS); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const loadAgents = useCallback(() => api("/api/agents").then((l) => { AGENT_INFO = Object.fromEntries((l || []).map((a) => [a.name, a])); setAgents(l || []); }, () => {}), []);
  useEffect(() => {
    if (!me) return;
    loadAgents();
    const t = setInterval(() => document.visibilityState === "visible" && loadAgents(), 30000);
    return () => clearInterval(t);
  }, [!!me]);
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
      if (!was || was === x.state || away(x) || (x.state !== "needs-you" && x.state !== "your-turn")) continue;
      const n = new Notification(x.title || "atc", { body: x.state === "needs-you" ? `Needs you${x.activity ? ": " + x.activity : ""}` : (x.summary?.status || x.lastReply || "Finished its turn"), tag: x.sessionId, icon: "/icon.svg" });
      n.onclick = () => { window.focus(); go(keyOf(x)); n.close(); };
    }
  }, [live]);

  const bayFor = useRef(null);
  useEffect(() => {
    if (!live) return;
    const x = route && live.find((v) => v.id === route || v.sessionId === route);
    const b = bayOf(x);
    if (b && bayFor.current !== x.sessionId) { bayFor.current = x.sessionId; BAY.set(b); rememberBay(b, { sid: x.sessionId, view: "session" }); }
    if (!route) bayFor.current = null;
  }, [live, route]);

  const warmed = useRef(false);
  useEffect(() => {
    if (!live || warmed.current) return;
    warmed.current = true;
    const likely = live.filter((x) => x.attachable && !away(x) && (x.state === "needs-you" || x.state === "your-turn")).slice(0, 2);
    setTimeout(() => likely.forEach(prewarm), 1200);
  }, [live]);

  useEffect(() => {
    if (!live) return;
    if (APP?.setSessions) {
      const feedAsk = (s) => {
        const a = s.asks?.[0], q = a?.questions?.[0];
        if (!a || (!a.permission && !q)) return undefined;
        const base = { sid: s.sessionId, id: a.id, key: a.key, host: s.host || undefined };
        if (a.permission) return { ...base, tool: a.permission, cmd: (a.patterns || []).join(" ") };
        return { ...base, text: q.question, options: a.questions.length === 1 ? q.options.map((o) => o.label) : undefined };
      };
      const rows = arrange(reach).filter((s) => !away(s) && FEED_STATES.includes(s.state)).slice(0, 12).map((s) => ({
        id: s.attachable ? s.id : undefined, sid: s.sessionId, title: s.title, state: s.state, host: s.host || undefined, pinned: s.pinned || undefined,
        since: (s.state === "working" && s.promptAt) || s.updated || undefined,
        summary: (s.state !== "working" && s.summary?.status) || undefined, bay: bayOf(s) || undefined, ask: s.state === "needs-you" ? feedAsk(s) : undefined,
      }));
      const hub = (live || []).find((s) => s.kind === "hub");
      const said = hub && oneLine(hub.lastReply || hub.summary?.status);
      const assistant = said ? { text: said, at: hub.updated || undefined } : undefined;
      const key = JSON.stringify([rows.map(({ since, ...r }) => r), said]);
      if (key !== appSent) { appSent = key; APP.setSessions(JSON.stringify({ type: "sessions", at: new Date().toISOString(), sessions: rows, assistant })); }
    } else if (APP?.setTargets) {
      const targets = JSON.stringify(reach.filter((s) => s.attachable && !away(s)).slice(0, 8).map((s) => ({ id: s.sessionId, title: s.title })));
      if (targets !== appSent) APP.setTargets((appSent = targets));
    }
  }, [reach]);

  useEffect(() => {
    const n = (live || []).filter(waiting).length;
    document.title = n ? `(${n}) atc` : "atc";
  }, [live]);

  const say = useCallback((msg, act) => {
    const t = { msg, undo: act?.undo };
    setToast(t);
    setTimeout(() => setToast((x) => (x === t ? null : x)), act?.undo ? 8000 : 3500);
  }, []);
  const undo = () => setToast((t) => { t?.undo?.(); return null; });

  const ordered = arrange(live);
  const keys = useRef({});
  keys.current = { ordered, route, cursor, creating, live, togglePane, setPeek, pages: !!pagesAt, toast, undo, list: !screenOf() && !pagesAt };
  useEffect(() => {
    const step = (from, d) => {
      const k = keys.current;
      const list = [...new Set([...document.querySelectorAll(".bview [data-sid], .rail [data-sid]")].map((el) => k.ordered.find((x) => x.sessionId === el.dataset.sid)).filter(Boolean))];
      if (!list.length) return null;
      const i = list.findIndex((x) => keyOf(x) === from || x.sessionId === from);
      return list[Math.max(0, Math.min(list.length - 1, i < 0 ? (d > 0 ? 0 : list.length - 1) : i + d))];
    };
    const onKey = (e) => {
      const k = keys.current;
      if (k.creating) return;
      if (!document.querySelector(".veil, .keys-ov, .pal") && !e.metaKey && !e.ctrlKey && !e.altKey)
        for (const f of [...KEYLAYERS].reverse()) if (f(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyJ" || e.code === "KeyK")) {
        const next = step(k.route, e.code === "KeyK" ? -1 : 1);
        if (next) { e.preventDefault(); e.stopPropagation(); go(keyOf(next)); }
        return;
      }
      const t = e.target;
      if (e.key.toLowerCase() === "k" && (MAC ? e.metaKey : e.ctrlKey && !t.closest?.(".xterm")) && !e.altKey && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation(); setPalette((v) => !v);
        return;
      }
      const typing = t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
      const digit = /^Digit\d$/.test(e.code) && !e.metaKey && !e.ctrlKey && ((e.altKey && e.shiftKey) || (!e.altKey && !e.shiftKey && !typing && !t.closest?.(".ask, [data-ask]") && !document.querySelector(".veil, .pghome, .palone, .keys-ov, .peek")));
      if (digit) {
        const n = +e.code.slice(5), bays = baysOf(k.live, BAY.only);
        e.preventDefault();
        if (e.altKey && e.shiftKey) { if (bays[n - 1]) k.setPeek((v) => (v === bays[n - 1].name ? null : bays[n - 1].name)); return; }
        if (n === 0 && k.pages) { const b = BAY.only; location.hash = pagesHash(b === null ? PAGES_FROM || bays[0]?.name || null : null); PAGES_FROM = b || PAGES_FROM; return; }
        if (n === 0) return BAY.set(null);
        const b = bays[n - 1];
        if (!b) return;
        if (b.name === BAY.only && k.route) {
          const ring = railRing(bayLists(k.live, null, b.name));
          const i = ring.findIndex((x) => keyOf(x) === k.route || x.sessionId === k.route);
          const next = ring[(i + 1) % ring.length];
          if (next && ring.length > 1) go(keyOf(next));
          return;
        }
        return goBay(b.name, k.live);
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return;
      if (document.querySelector(".veil, .pghome, .palone, .keys-ov, .pal")) {
        if (e.key === "Escape") setHelp(false);
        if (e.key === "?") setHelp((h) => !h);
        return;
      }
      const qi = QWERTY.indexOf(e.key);
      if (qi >= 0 && k.list && !e.shiftKey) {
        const rows = [...new Set([...document.querySelectorAll(".bview [data-sid], .rail [data-sid]")].map((el) => el.dataset.sid))];
        const x = rows[qi] && (k.ordered.find((v) => v.sessionId === rows[qi]) || { sessionId: rows[qi] });
        e.preventDefault(); e.stopPropagation();
        if (x) go(keyOf(x));
        return;
      }
      const move = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
      const act = {
        s: () => goBay(BAY.only, k.live, true),
        b: () => { rememberBay(BAY.only, { view: "board" }); go(null); },
        g: () => (location.hash = pagesHash()),
        ".": () => (Call.live() ? returnToCall() : openAssistant()),
        "+": () => setCreating(location.hash === BACKLOG ? { later: true } : true),
        n: () => {
          const bays = baysOf(k.live, BAY.only).map((b) => b.name);
          const needs = (k.live || []).filter(waiting).sort((a, b) => bays.indexOf(bayOf(a)) - bays.indexOf(bayOf(b)) || (a.state === "needs-you" ? 0 : 1) - (b.state === "needs-you" ? 0 : 1));
          const i = needs.findIndex((x) => keyOf(x) === k.route || x.sessionId === k.route);
          const next = needs[(i + 1) % needs.length];
          next ? go(keyOf(next)) : say("Nothing needs you.");
        },
        "[": () => (k.route ? k.togglePane("rail") : k.pages && k.togglePane("pgindex")),
        "]": () => !k.route && k.list && k.togglePane("index"),
        z: () => k.toast?.undo && k.undo(),
        ",": () => (location.hash === SETTINGS ? closeSettings() : (location.hash = SETTINGS)),
        "/": () => setPalette(true),
        "?": () => setHelp((h) => !h),
      }[e.key];
      if (move && k.route && (e.key === "j" || e.key === "k")) {
        const next = step(k.route, move);
        e.preventDefault();
        if (next && next.sessionId !== k.route && keyOf(next) !== k.route) go(keyOf(next));
      } else if (move && !k.route && k.list) {
        const next = step(k.cursor || k.route, move);
        if (next) { e.preventDefault(); setCursor(next.sessionId); document.querySelector(`[data-sid="${next.sessionId}"]`)?.scrollIntoView({ block: "nearest" }); }
      } else if (e.key === "Enter" && k.cursor && k.list) {
        e.preventDefault();
        const x = k.ordered.find((x) => x.sessionId === k.cursor);
        if (x) go(keyOf(x));
      } else if (act) {
        e.preventDefault(); act();
      } else if (e.key === "Escape") {
        setHelp(false); setCursor(null); closeScreen();
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  if (me === undefined) return null;
  if (me === null) return html`<${Login} onDone=${setMe} />`;
  HOME = me.home || HOME;
  CLAUDE_THEME = me.claudeTheme || CLAUDE_THEME;
  LOOK.adopt(me.look);
  MULTI = (me.hosts || []).length > 1;
  HERE = me.host || "";
  VOICE = me.voice || {};
  VOICE_OK = !!VOICE.stt;
  CAN_CALL = !!APP?.call || (!APP && !!me.call && Call.supported());
  const down = (me.peers || []).filter((p) => p.error);

  const all = runs || [];
  const sel = route && (all.find((s) => s.id === route || s.sessionId === route) || past[route]);
  const assistView = assisting || (sel?.kind === "hub" && sel.agent === "assistant");
  const screen = assistView ? "assistant" : route ? "session" : pagesAt ? "pages" : scr || "board";
  const bays = baysOf(live, only);
  const inBay = (live || []).filter((x) => x.state !== "stopped" && (only ? bayOf(x) === only : !homeless(x))).length;
  const remember = rememberPast;
  const openFromUsage = async (x) => {
    if (!all.some((s) => s.sessionId === x.sessionId) && !past[x.sessionId])
      remember((await api(`/api/history?q=${encodeURIComponent(x.title)}&limit=50`).catch(() => [])).filter((s) => s.sessionId === x.sessionId));
    go(x.sessionId);
  };

  return html`
    <div class="app ${assistView ? "assisting" : ""}">
    <${BayBar} bays=${bays} only=${only} view=${screen} panes=${panes} togglePane=${togglePane} up=${up} down=${down} live=${live} peek=${peek} onPeek=${setPeek} />
    ${peek && html`<${BayPeek} key=${peek} bay=${peek} live=${live} say=${say} onClose=${() => setPeek(null)} />`}
    ${assistView ? html`<${AssistantView} hub=${hub} live=${all} loaded=${!!runs} agents=${agents} say=${say} panes=${panes} togglePane=${togglePane} />`
    : pagesAt && !route ? html`<div class="shell pagesv"><${PagesView} at=${pagesAt} live=${all} bays=${bays} say=${say} index=${panes.pgindex !== false} /></div>`
    : scr && !route ? html`<main class="shell scr">${scr === "usage" ? html`<${UsagePage} limits=${limits} live=${all} down=${down} onOpen=${openFromUsage} />`
      : scr === "backlog" ? html`<${BacklogPage} live=${all} say=${say} onAdd=${setCreating} only=${only} />`
      : html`<${AgentsPage} name=${agentName} agents=${agents} live=${all} say=${say} reload=${loadAgents} />`}</main>`
    : !route ? html`<div class="shell boardv"><${BoardView} live=${live} hist=${hist} more=${canMore && moreHist} only=${only} sel=${sel} cursor=${cursor} say=${say} index=${panes.index && wide} /></div>` : html`
    <div class="shell open ${!panes.rail ? "norail" : ""}">
      <aside class="side">
        <div class="ph"><b>${only || "Every bay"}</b><span>${plural(inBay, "session")}</span>
          <span class="r"><button class="kb" onClick=${() => setCreating(true)} aria-keyshortcuts="+">New session <kbd aria-hidden="true">+</kbd></button></span></div>
        <${RailList} live=${live} hist=${hist} only=${only} sel=${sel} cursor=${cursor} />
        <${UsageFoot} limits=${limits} onOpen=${openUsage} />
      </aside>
      <main class="main">
        ${sel && !wide && html`<${SessionStrip} live=${live} sel=${sel} />`}
        ${sel
          ? html`<${Session} key=${sel.sessionId} s=${sel} say=${say} live=${all} panes=${panes} togglePane=${togglePane} />`
          : html`<div class="blank">${!live ? "Opening…" : "This session is gone. Pick another from the list."}</div>`}
      </main>
    </div>`}
    <${Console} hub=${hub} agents=${agents} runs=${runs} onTalk=${openAssistant} onKeys=${() => setHelp(true)} />
    ${!calling && html`<${CallPill} hub=${hub} />`}
    <${TabBar} view=${calling ? "assistant" : screen} onTalk=${openAssistant} />
    </div>
    ${creating && html`<${NewSession} onClose=${() => setCreating(false)} say=${say} hosts=${me.hosts || [me.host]} down=${down} home=${me.host} live=${all}
      start=${creating === true ? null : creating} context=${creating === true ? here(sel, live) : null} />`}
    ${palette && html`<${Palette} live=${reach || []} sel=${sel} say=${say} home=${me.host} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} onClose=${() => setPalette(false)}
      actions=${{ create: (start) => setCreating(start || true), usage: openUsage, help: () => setHelp(true), talk: openAssistant, ask: openAssistant,
        pane: togglePane, next: () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })) }} />`}
    ${sharing && html`<${Share} key=${sharing} live=${live} say=${say} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} home=${me.host} />`}
    ${settings && html`<${SettingsPage} me=${me} onClose=${closeSettings} />`}
    ${alone && html`<${PageAlone} key=${alone.sid} sid=${alone.sid} name=${alone.name} at=${alone.at} live=${all} say=${say} />`}
    ${calling ? html`<${CallScreen} hub=${hub} live=${all} />` : html`<${CallDock} hub=${hub} live=${all} assisting=${assistView} />`}
    ${quick && html`<${QuickMenu} quick=${quick} say=${say} onClose=${() => setQuick(null)} />`}
    ${agentUse && html`<${AgentUsage} name=${agentUse} onClose=${() => setAgentUse(null)} />`}
    <${Dialogs} />
    ${toast && html`<div class="toast" role="status">${toast.msg}${toast.undo && html` <button class="tundo" onClick=${undo} aria-keyshortcuts="z">Undo <kbd aria-hidden="true">z</kbd></button>`}</div>`}
    ${notifAsk && me && !updated && !settings && html`<div class="appbar" role="status">
      <span>Get a desktop notification when a session finishes or needs you, while this tab is in the background?</span>
      <button class="btn primary" onClick=${() => notifDone(true)}>Turn on</button>
      <button class="btn" onClick=${() => notifDone(false)}>Not now</button>
    </div>`}
    ${updated && html`<div class="appbar" role="status">
      <span>atc was updated. Reload to get the new version.</span>
      <button class="btn primary" onClick=${() => location.reload()}>Reload</button>
      <button class="icon" aria-label="Dismiss" onClick=${() => setUpdated(false)}>✕</button>
    </div>`}
    ${stale && html`<div class="appbar" role="status">
      <span>A newer atc app is available (${stale}).</span>
      <button class="btn primary" onClick=${() => APP?.checkUpdate()}>Update</button>
      <button class="icon" aria-label="Dismiss" onClick=${() => setStale(null)}>✕</button>
    </div>`}
    ${help && html`<${KeysOverlay} onClose=${() => setHelp(false)} />`}
  `;
}

const BAY = {
  only: (() => { try { return localStorage.getItem("atc.project") || null; } catch { return null; } })(),
  set(v) {
    if (v === BAY.only) return;
    BAY.only = v;
    try { v ? localStorage.setItem("atc.project", v) : localStorage.removeItem("atc.project"); } catch {}
    dispatchEvent(new Event("atc-bay"));
  },
};
function useBay() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    addEventListener("atc-bay", f);
    return () => removeEventListener("atc-bay", f);
  }, []);
  return BAY.only;
}
const PAGE_ID = Math.random().toString(36).slice(2, 10);
let BAYDATA = { order: [], memory: {}, local: true };
const loadBays = () => api("/api/bays").then((d) => {
  const was = BAYDATA.local ? { order: stored("atc.bays", []), memory: stored("atc.baymem", {}), local: true } : BAYDATA;
  BAYDATA = { order: d.order || [], memory: d.memory || {} };
  if (was.local && !BAYDATA.order.length && was.order.length) {
    BAYDATA = { order: was.order, memory: { ...was.memory, ...BAYDATA.memory } };
    api("/api/bays", { method: "PUT", body: { order: was.order, from: PAGE_ID } }).catch(() => {});
  }
  dispatchEvent(new Event("atc-bay"));
}, () => {});
const adoptBays = (d) => { if (d.from === PAGE_ID) return; BAYDATA = { order: d.order || [], memory: d.memory || {} }; dispatchEvent(new Event("atc-bay")); };
const bayMem = (b) => BAYDATA.memory[b] || {};
const rememberBay = (b, m) => {
  if (!b || Object.entries(m).every(([k, v]) => bayMem(b)[k] === v)) return;
  BAYDATA.memory = { ...BAYDATA.memory, [b]: { ...bayMem(b), ...m } };
  api(`/api/bays/${encodeURIComponent(b)}`, { method: "PATCH", body: { ...m, from: PAGE_ID } }).catch(() => {});
};
const AGENT_BAY = "agents";
const bayOf = (s) => (!s ? null : homeless(s) || s.kind === "hub" ? AGENT_BAY : project(s.cwd).name);
const waiting = (s) => (s.state === "needs-you" || s.state === "your-turn") && !away(s);

function baysOf(live, keep) {
  const tabs = projectTabs(live || [], keep);
  const ag = (live || []).filter((s) => bayOf(s) === AGENT_BAY && s.state !== "stopped" && s.state !== "past");
  if (ag.length || keep === AGENT_BAY) tabs.push({ name: AGENT_BAY, pips: ag.filter((s) => !away(s) && RANK[s.state] !== undefined).map((s) => s.state) });
  const names = tabs.map((t) => t.name);
  let order = BAYDATA.order;
  const fresh = names.filter((n) => !order.includes(n));
  if (fresh.length && !BAYDATA.local) {
    BAYDATA.order = order = [...order, ...fresh];
    api("/api/bays", { method: "PUT", body: { order, from: PAGE_ID } }).catch(() => {});
  } else if (fresh.length) order = [...order, ...fresh];
  return order.filter((n) => names.includes(n)).map((n) => {
    const t = tabs.find((x) => x.name === n), c = (st) => t.pips.filter((x) => x === st).length;
    return { name: n, needs: c("needs-you"), turn: c("your-turn"), work: c("working") };
  });
}

function goBay(name, live, session) {
  BAY.set(name);
  const m = bayMem(name), mine = (live || []).filter((s) => bayOf(s) === name && !away(s));
  const known = m.sid && (live || []).find((s) => s.sessionId === m.sid);
  if (!session && (pagesRoute() || m.view === "pages")) return (location.hash = pagesHash(name));
  if (!session && (m.view === "board" || !name)) return go(null);
  const pick = known || mine.find((s) => s.state === "needs-you") || mine.find((s) => s.state === "your-turn") || mine[0];
  go(pick ? keyOf(pick) : null);
}

const bayWords = (b, i) => [`${b.name}, bay ${i + 1}`, [b.needs + b.turn && `${b.needs + b.turn} waiting on you`, b.work && `${b.work} working`].filter(Boolean).join(", ")].filter(Boolean).join(": ");

function BayBar({ bays, only, view, panes, togglePane, up, down, live, peek, onPeek }) {
  const now = new Date();
  const scroller = useRef();
  const [hidden, setHidden] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => {
      const box = el.getBoundingClientRect();
      setHidden(bays.filter((b) => {
        const r = el.querySelector(`[data-bay="${CSS.escape(b.name)}"]`)?.getBoundingClientRect();
        return b.needs + b.turn > 0 && r && (r.right > box.right + 1 || r.left < box.left - 1);
      }).reduce((n, b) => n + b.needs + b.turn, 0));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    addEventListener("resize", check);
    return () => { el.removeEventListener("scroll", check); removeEventListener("resize", check); };
  }, [bays.map((b) => b.name + b.needs).join()]);
  const kb = (on, label, key, run, title) => html`<button class="kb ${on ? "on" : ""}" aria-pressed=${on} aria-keyshortcuts=${key} title=${title || ""} onClick=${run}>${label} <kbd aria-hidden="true">${key}</kbd></button>`;
  return html`
    <nav class="bays" aria-label="Bays">
      <div class="bays-scroll" ref=${scroller}>
        ${only === null && html`<span class="bay on"><button class="bn" aria-current="true" title="Every bay (alt 0)"><span class="k">0</span><span class="n">All</span></button></span>`}
        ${bays.map((b, i) => html`
          <span class="bay ${only === b.name ? "on" : ""} ${peek === b.name ? "peeking" : ""}" data-bay=${b.name}>
            <button class="bn" aria-current=${only === b.name ? "true" : null} aria-label=${bayWords(b, i)}
              aria-keyshortcuts=${i < 9 ? `${i + 1}` : null} onClick=${() => goBay(b.name, live)}
              onContextMenu=${(e) => { e.preventDefault(); onPeek(b.name); }}>
              <span class="k" aria-hidden="true">${i + 1}</span><span class="n">${b.name}</span></button>
            ${(b.needs > 0 || b.turn > 0 || b.work > 0) && html`<button class="cts" aria-label=${`Peek at ${b.name}`} aria-expanded=${peek === b.name}
              aria-keyshortcuts=${i < 9 ? `Shift+Alt+${i + 1}` : null} onClick=${() => onPeek(peek === b.name ? null : b.name)}>
              ${b.needs + b.turn > 0 && html`<i class="cn n">${b.needs + b.turn}</i>`}${b.work > 0 && html`<i class="cn w">${b.work}</i>`}</button>`}
          </span>`)}
      </div>
      ${hidden > 0 && html`<button class="offneeds" onClick=${() => onPeek(peek === "*" ? null : "*")} aria-label=${`${hidden} more need you in other bays`}><i class="cn n">+${hidden}</i>need you</button>`}
      <span class="sp"></span>
      <div class="views">
        ${kb(view === "session", "Session", "s", () => goBay(only, live, true))}
        ${kb(view === "board", "Board", "b", () => { rememberBay(only, { view: "board" }); go(null); })}
        ${kb(view === "pages", "Pages", "g", () => (location.hash = pagesHash()))}
        ${SCREENS[view] && html`<button class="kb on" aria-current="page">${SCREENS[view]}</button>`}
      </div>
      ${view === "board" && html`<div class="tgl">${kb(only === null, html`<span class="nm">All bays</span>`, "0", () => BAY.set(only === null ? bays[0]?.name || null : null), "Every bay on one board")}${kb(panes.index, html`<span class="nm">Page index</span>`, "]", () => togglePane("index"), "The bay's pages beside the board")}</div>`}
      ${view === "pages" && html`<div class="tgl">${kb(panes.pgindex !== false, html`<span class="nm">Index</span>`, "[", () => togglePane("pgindex"), "Every page in the bay, newest first")}${kb(only === null, html`<span class="nm">All bays</span>`, "0", () => { location.hash = pagesHash(only === null ? PAGES_FROM || bays[0]?.name || null : null); PAGES_FROM = only || PAGES_FROM; }, "Pages from every bay, grouped by bay")}</div>`}
      ${view === "assistant" && html`<div class="tgl">${kb(panes.aleft, html`<span class="nm">Touched today</span>`, "[", () => togglePane("aleft"), "Sessions it started or told today, and the agents")}</div>`}
      ${view === "session" && html`<div class="tgl">${kb(panes.rail, html`<span class="nm">Sessions</span>`, "[", () => togglePane("rail"), "The bay's sessions beside the transcript")}${kb(panes.state, html`<span class="nm">State</span>`, "\\", () => togglePane("state"), "What the session is doing, what it made, and its facts")}</div>`}
      <div class="meta">
        ${!up && html`<span class="host off" role="status">reconnecting</span>`}
        ${down.map((p) => html`<span class="host off" title=${p.error}>${p.name} off</span>`)}
        <span class="clock">${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}</span>
      </div>
    </nav>`;
}

function SessionStrip({ live, sel }) {
  const bay = bayOf(sel);
  const ring = railRing(bayLists(live, null, bay));
  const items = ring.some((x) => x.sessionId === sel.sessionId) ? ring : [sel, ...ring];
  const box = useRef();
  useLayoutEffect(() => {
    const el = box.current?.querySelector(".on");
    if (el) box.current.scrollLeft = el.offsetLeft - 16;
  }, [sel.sessionId]);
  if (items.length < 2) return null;
  return html`<nav class="sstrip" ref=${box} aria-label=${`Sessions in ${bay || "this bay"}`}>
    ${items.map((x) => html`<button class=${x.sessionId === sel.sessionId ? "on" : ""} aria-current=${x.sessionId === sel.sessionId ? "true" : null} onClick=${() => go(keyOf(x))}>
      <${StateBlock} s=${x} /><span>${x.title || "Untitled"}</span></button>`)}
  </nav>`;
}

function BayPeek({ bay, live, say, onClose }) {
  const phone = usePhone();
  const box = useRef();
  useEffect(() => {
    const k = (e) => e.key === "Escape" && (e.stopPropagation(), onClose());
    const out = (e) => !box.current?.contains(e.target) && !e.target.closest?.(".bays") && onClose();
    addEventListener("keydown", k, true);
    addEventListener("pointerdown", out);
    return () => { removeEventListener("keydown", k, true); removeEventListener("pointerdown", out); };
  }, []);
  useLayoutEffect(() => {
    const at = document.querySelector(every ? ".bays .offneeds" : `.bays .bay[data-bay="${CSS.escape(bay)}"]`)?.getBoundingClientRect(), el = box.current;
    if (!phone && at && el) el.style.left = `${Math.max(8, Math.min(at.left, innerWidth - el.offsetWidth - 8))}px`;
  });
  const every = bay === "*";
  const mine = (live || []).filter((s) => (every ? waiting(s) : bayOf(s) === bay) && !away(s));
  const wait = mine.filter(waiting).sort((a, b) => (a.state === "needs-you" ? 0 : 1) - (b.state === "needs-you" ? 0 : 1)), work = mine.filter((s) => s.state === "working");
  const open = (s) => { onClose(); go(keyOf(s)); };
  const row = (s) => html`<div class="pk ${s.state}" key=${s.sessionId}>
    <div class="row"><${StateBlock} s=${s} /><a class="ti" href=${`#/s/${keyOf(s)}`} onClick=${(e) => { e.preventDefault(); open(s); }}>${s.title || "Untitled"}</a><span class="ago">${every && html`<span class="bayn">${bayOf(s)}</span>`}${ago(s)}</span></div>
    <p class="what">${s.state === "working" ? doing(s) : headline(s)}</p>
    ${s.asks?.length > 0 && html`<${Ask} compact=${!phone} sheet=${phone} s=${s} a=${s.asks[0]} say=${say} />`}
    ${replyable(s) && html`<div class="ask"><${CardReplies} s=${s} /></div>`}
  </div>`;
  const body = html`
    ${wait.length > 0 && html`<h3 class="grp"><b>Waiting on you</b><span class="c">${wait.length}</span></h3>${wait.map(row)}`}
    ${work.length > 0 && html`<h3 class="grp"><b>Working</b><span class="c">${work.length}</span></h3>${work.map(row)}`}
    ${!mine.length && html`<p class="pkf"><span>Nothing running in ${bay}.</span></p>`}
    ${!every && html`<div class="pkf"><button class="kb" onClick=${() => { onClose(); goBay(bay, live); }}>Go to ${bay}</button><button class="kb" onClick=${() => { onClose(); BAY.set(bay); rememberBay(bay, { view: "board" }); go(null); }}>Its board</button></div>`}`;
  return phone
    ? html`<${Sheet} cls="peeksheet" title=${every ? "Every bay" : bay} onClose=${onClose}><div class="peek" ref=${box}>${body}</div><//>`
    : html`<div class="peek" ref=${box} role="dialog" aria-label=${`Peek at ${bay}`}>
        <div class="pkh"><b>${bay}</b><span>${wait.length ? `${wait.length} waiting on you` : ""}</span><span class="r"><button class="kb" onClick=${onClose}>Close <kbd aria-hidden="true">esc</kbd></button></span></div>
        ${body}
      </div>`;
}

const hubLine = (hub) => {
  if (!hub) return "Ask about or drive your sessions.";
  if (hub.state === "needs-you") return `Needs you${hub.activity ? `: ${oneLine(hub.activity)}` : ""}`;
  if (hub.state === "working") return oneLine(hub.activity) || "Working";
  return oneLine(hub.summary?.status) || oneLine(hub.lastReply) || "Waiting for you.";
};

function ConsoleAgents({ agents, runs }) {
  const last = (a) => Math.max(0, ...(runs || []).filter((x) => x.agent === a.name).map((x) => Date.parse(x.updated || 0) || 0));
  const list = (agents || []).filter((a) => !a.error).sort((a, b) => last(b) - last(a));
  const link = (a) => html`<a href="#" onClick=${(e) => { e.preventDefault(); AGENT_SHEET(a.name); }}>@<b>${a.name}</b></a>`;
  return html`<span class="agents">${list.slice(0, 4).map(link)}${list.length > 4 && html`<${Menu} cls="kb" up aria="Every agent" width=${220} label=${`+${list.length - 4}`}
    items=${list.slice(4).map((a) => ({ cls: "viewitem", label: `@${a.name}`, run: () => AGENT_SHEET(a.name) }))} />`}</span>`;
}

function Console({ hub, agents, runs, onTalk, onKeys }) {
  useCall();
  const docked = useCallDock();
  if (Call.live()) return html`<${CallLine} docked=${docked} />`;
  return html`
    <footer class="console" aria-label="Assistant">
      <button class="pr" onClick=${onTalk} aria-keyshortcuts=".">assistant<span>></span></button>
      <span class="last">${hubLine(hub)}</span>
      ${hub && html`<span class="ago">${ago(hub)}</span>`}
      <button class="type" onClick=${onTalk}>talk to the assistant</button>
      ${CAN_CALL && html`<button class="kb" onClick=${callAssistant}>Call</button>`}
      <${ConsoleAgents} agents=${agents} runs=${runs} />
      <button class="kb" onClick=${onKeys} aria-keyshortcuts="?">Keys <kbd aria-hidden="true">?</kbd></button>
    </footer>`;
}

function TabBar({ view, onTalk }) {
  const tab = (on, label, run) => html`<button class=${on ? "on" : ""} aria-current=${on ? "page" : null} onClick=${run}>${label}</button>`;
  return html`
    <nav class="tabbar" aria-label="Views">
      ${tab(view === "board", "Board", () => { rememberBay(BAY.only, { view: "board" }); go(null); })}
      ${tab(view === "pages", "Pages", () => (location.hash = pagesHash()))}
      ${tab(view === "assistant", "Assistant", onTalk)}
      ${tab(false, "Go", () => PALETTE_OPEN())}
    </nav>`;
}

const KEYMAP = [
  ["Views", [["s", "Session: the bay's last open one"], ["b", "Board"], ["g", "Pages"], [".", "Assistant; on a call, back to the call"]]],
  ["Bays", [["1..9", "That bay, as you left it; again: its next session"], ["shift alt 1..9", "Peek at that bay: answer without going there"], ["0", "Every bay"], ["n", "Next session waiting on you, any bay"]]],
  ["Sessions", [["q w e .. p", "The 1st to 10th session in the list, at once"], ["j k", "Next, previous session (on the board: the selection)"], ["enter", "On the board: open the selected session"], ["alt j k", "Next, previous session, even from a terminal"]]],
  ["Panes", [["[", "Sessions beside the transcript"], ["]", "Its page beside the transcript (board: the page index)"], ["\\", "State: now, running, made, the session's facts"]]],
  ["Session", [["enter", "Write to the session (on a stopped one: Resume)"], ["`", "Terminal, and back to the transcript"], ["x", "Session menu: park, stop, rename, delete"]]],
  ["Reading", [["J K", "Next, previous turn: your prompts and its replies"], ["space", "A screen down; with shift, up"], ["home end", "Top, end of the transcript"], ["N", "Next thing you have not seen here: the divider, then the question"], ["c", "Contents: every turn and heading"], ["l", "Outline, story, everything, in turn"], ["f", "Find in the session"]]],
  ["Assistant", [[".", "Tap: call it; hold: voice mode"], ["[", "Touched today and the agents"], ["esc", "Close the assistant"]]],
  ["Call", [["m", "Mute, unmute"], ["E", "End the call (shift e)"], [".", "Back to the call, from anywhere"], ["esc", "Minimize the call to the console line"]]],
  ["Voice", [["m", "Mute, unmute"], ["esc", "Leave voice mode"]]],
  ["Answer", [["1..9", "With the question focused (click it, tab into it, or N): that option"]]],
  ["Composer", [["enter", "Send; while it works, queue"], ["esc", "Empty box while it works: stop it (asks first)"], ["space", "Hold in an empty box: dictate"], ["/", "At the start: slash commands"]]],
  ["Pages", [["j k", "Next, previous page"], ["[", "The index"], ["0", "This bay or every bay"], ["q w e .. p", "The 1st to 10th page in the index"], ["\\", "The page beside its session"], ["enter", "Note: its session, at the composer"], ["d", "What changed, on an updated page"]]],
  ["Palette", [["↑ ↓", "Move (also ctrl j, ctrl k)"], ["enter", "Run it"], ["tab", "Preview it behind the palette"], ["1..9", "Alone: that bay"]]],
  ["Backlog", [["j k", "Next, previous task"], ["enter", "Start, take or open it"], ["d", "Done"], ["x", "Blocked, or unblock"], ["a", "The add box"]]],
  ["Agents", [["j k", "Next, previous agent"], ["enter", "Its conversation"]]],
  ["Anywhere", [["/", "Search and commands"], ["+", "New session"], [",", "Settings"], ["z", "Undo, while an Undo toast shows"], ["?", "These keys"], ["esc", "Close what is open"]]],
];

function KeysOverlay({ onClose }) {
  return html`
    <div class="keys-ov" onPointerDown=${onClose}>
      <div class="kp" role="dialog" aria-modal="true" aria-label="Keys" onPointerDown=${(e) => e.stopPropagation()}>
        <div class="kh"><b>Keys</b><span class="r"><button class="kb" onClick=${onClose}>Close <kbd aria-hidden="true">esc</kbd></button></span></div>
        <div class="kg">${KEYMAP.map(([group, keys]) => html`
          <section><h3>${group}</h3><dl>${keys.map(([k, what]) => html`<dt><kbd>${k}</kbd></dt><dd>${what}</dd>`)}</dl></section>`)}</div>
      </div>
    </div>`;
}

const GROUPS = [["pinned", "Pinned"], ["waiting", "Waiting on you"], ["working", "Working"], ["parked", "Parked"], ["earlier", "Earlier"]];
const QWERTY = "qwertyuiop";
const groupOf = (s) => (away(s) ? "parked" : s.pinned ? "pinned" : waiting(s) ? "waiting" : s.state === "working" ? "working" : "earlier");
const byUrgency = (a, b) => (a.state === "needs-you" ? 0 : 1) - (b.state === "needs-you" ? 0 : 1) || (Date.parse(b.updated || 0) || 0) - (Date.parse(a.updated || 0) || 0);
const doingLine = (s) => s.state === "working" ? doing(s) : s.state === "needs-you" && s.asks?.[0] ? oneLine(s.asks[0].questions?.[0]?.question || (s.asks[0].permission && `Wants to use ${s.asks[0].permission}`)) : "";
const runningOf = (s) => [s.background?.length > 0 && plural(s.background.length, "task"), ...(s.servers || []).slice(0, 2).map((p) => `:${p}`), s.tabs?.length > 0 && plural(s.tabs.length, "tab")].filter(Boolean);
const madeOf = (s) => [s.shown?.length > 0 && plural(s.shown.length, "page"), s.files > 0 && plural(s.files, "file")].filter(Boolean);

function useBayHistory(enabled, onPast) {
  const [hist, setHist] = useState(null);
  const [limit, setLimit] = useState(40);
  useEffect(() => {
    if (!enabled) return;
    const load = () => api(`/api/history?limit=${limit}`).then((l) => { setHist(l || []); onPast?.(l || []); }, () => setHist([]));
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60000);
    return () => clearInterval(t);
  }, [limit, enabled]);
  return [hist, () => setLimit(limit + 40), hist && hist.length >= limit];
}

const railRing = (by) => [...by.pinned, ...by.waiting, ...by.working];

function bayLists(live, hist, only) {
  const mine = (s) => (only ? bayOf(s) === only : true);
  const now = (live || []).filter(mine);
  const ids = new Set((live || []).map((s) => s.sessionId));
  const earlier = [...now.filter((s) => groupOf(s) === "earlier"), ...(hist || []).filter((s) => !ids.has(s.sessionId) && mine(s))]
    .sort((a, b) => (Date.parse(b.updated || b.startedAt || 0) || 0) - (Date.parse(a.updated || a.startedAt || 0) || 0));
  const by = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const s of now) if (groupOf(s) !== "earlier") by[groupOf(s)].push(s);
  for (const k in by) by[k].sort(byUrgency);
  by.pinned.sort(byStart);
  by.earlier = earlier;
  return by;
}

function BoardRow({ s, open, toggle, sel, cursor, rail, say, qk }) {
  const tap = rail ? null : () => toggle(s.sessionId);
  const { events } = useRowEvents(s, tap, !rail && s.state !== "past" && s.state !== "stopped");
  const on = sel?.sessionId === s.sessionId, run = runningOf(s), made = madeOf(s), g = s.pinned && waiting(s) ? "pinned waiting" : groupOf(s);
  const where = [MULTI && s.host, s.branch && !["HEAD", "main", "master"].includes(s.branch) && s.branch].filter(Boolean).join(" ");
  const status = (s.state === "needs-you" ? oneLine(s.summary?.status) || oneLine(s.lastReply) || "Needs you" : headline(s)) || WORD[s.state] || "";
  const second = doingLine(s);
  const fresh = unread(s);
  const cls = `brow ${g} ${on ? "sel" : ""} ${cursor === s.sessionId ? "cur" : ""} ${open ? "open" : ""} ${fresh ? "fresh" : ""}`;
  const title = html`<span class="t">${s.title || "Untitled"}</span>`;
  if (rail) return html`
    <button class=${cls} data-sid=${s.sessionId} aria-current=${on ? "true" : null} aria-description=${fresh ? "new since you looked" : null} ...${events}>
      <${StateBlock} s=${s} />
      <span class="c">${title}<span class="s">${status}</span>${s.state === "working" && html`<span class="s2 mono">${doing(s)}</span>`}</span>
      <span class="e"><span class="ago">${qk && html`<kbd class="qk" aria-hidden="true">${qk}</kbd>`}${ago(s)}</span>${made[0] && s.shown?.length > 0 && html`<b>${made[0]}</b>`}</span>
    </button>`;
  return html`
    <div class="bwrap ${open ? "open" : ""} ${g}">
      <div class=${cls} data-sid=${s.sessionId} role="button" tabindex="0" aria-expanded=${open} aria-description=${fresh ? "new since you looked" : null} ...${events}
        onDblClick=${() => go(keyOf(s))} onKeyDown=${(e) => e.target === e.currentTarget && (e.key === "Enter" ? go(keyOf(s)) : e.key === " " && (e.preventDefault(), toggle(s.sessionId)))}>
        <${StateBlock} s=${s} />
        <span class="ses"><a class="t" href=${`#/s/${keyOf(s)}`} onClick=${(e) => e.stopPropagation()}>${s.title || "Untitled"}</a>${where && html`<span class="w">${where}</span>`}</span>
        <span class="st"><span class="l1">${status}</span>${second && html`<span class="l2 ${s.state === "working" ? "mono" : ""}">${second}</span>`}</span>
        <span class="ctx">${s.context > 0 && html`<${CtxMeter} n=${s.context} /><span>${Math.round(s.context / 1000)}k</span>`}</span>
        <span class="stp">${s.steps > 0 && s.steps}${s.failed > 0 && html`<span class="f">${s.failed} failed</span>`}</span>
        <span class="mk">${run.length > 0 && html`<span class="run">${run.join(" ")}</span>`}${made.length > 0 && html`<span>${made.join(" ")}</span>`}</span>
        <span class="since">${fresh && html`<i class="dot" aria-hidden="true"></i>`}${ago(s)}${qk && html`<kbd class="qk" aria-hidden="true">${qk}</kbd>`}</span>
        <span class="chev" aria-hidden="true"></span>
      </div>
      ${open && html`<div class="bexp">
        <div class="gx">
          ${s.summary?.gist?.length > 0 && html`<ul>${s.summary.gist.map((x) => html`<li>${x}</li>`)}</ul>`}
          <p class="facts">${[engineTag(s) || (s.model && model(s.model)), s.permissionMode === "bypassPermissions" ? "no permission prompts" : s.permissionMode, tilde(s.cwd || "")].filter(Boolean).join(", ")}</p>
        </div>
        <div class="ax">
          ${s.asks?.length > 0 && html`<${Ask} compact s=${s} a=${s.asks[0]} say=${say} />`}
          ${replyable(s) && html`<${CardReplies} s=${s} />`}
          <div class="acts"><button class="btn" onClick=${() => go(keyOf(s))}>Open</button>
            ${s.shown?.length > 0 && html`<button class="btn" onClick=${() => (location.hash = pageLink(keyOf(s), s.shown[0].name))}>${pageTitle(s.shown[0])}</button>`}</div>
        </div>
      </div>`}
    </div>`;
}

function BoardView({ live, hist, more, only, sel, cursor, say, index, onPast }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (sid) => setOpen((o) => { const n = new Set(o); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });
  useEffect(() => {
    const k = (e) => {
      if (e.key !== " " || !cursor || e.target !== document.body || document.querySelector(".veil, .pghome, .keys-ov")) return;
      e.preventDefault(); toggle(cursor);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [cursor]);
  const by = bayLists(live, hist, only);
  let qn = 0;
  const letter = { waiting: ["N", "needs"], working: ["W", "working"], parked: ["P", "parked"] };
  const pinnedIn = { waiting: by.pinned.filter(waiting).length, working: by.pinned.filter((s) => s.state === "working").length };
  const counts = GROUPS.filter(([k]) => k in letter).map(([k]) => [k, by[k].length + (pinnedIn[k] || 0)]).filter(([, n]) => n > 0);
  const path = only && (live || []).find((s) => bayOf(s) === only);
  const [earlierAll, setEarlierAll] = useState(false);
  const shownEarlier = earlierAll ? by.earlier : by.earlier.filter((s) => Date.now() - (Date.parse(s.updated || s.startedAt || 0) || 0) < 2 * 86400000).slice(0, 12);
  const pages = index && (live || []).filter((s) => (only ? bayOf(s) === only : !homeless(s))).flatMap((s) => (s.shown || []).map((p) => ({ p, s })))
    .sort((a, b) => (Date.parse(b.p.updated || b.p.shown) || 0) - (Date.parse(a.p.updated || a.p.shown) || 0));
  return html`
    <div class="bview ${index ? "withindex" : ""}">
      <div class="bmain" id="bscroll">
        <div class="bhead">
          <div class="b1"><h1>${only || "Every bay"}</h1>${path && html`<span class="w">${tilde(baseDir(path.cwd))}</span>`}
            <span class="r"><${BacklogLine} only=${only} /><button class="kb" onClick=${() => PALETTE_OPEN()} aria-keyshortcuts="/">Search <kbd aria-hidden="true">/</kbd></button></span></div>
          <div class="b2">${counts.length ? counts.map(([k, n]) => html`<span class="cnt"><span class="sb mini ${letter[k][1]}" aria-hidden="true">${letter[k][0]}</span>${n} ${{ waiting: "waiting on you", working: "working", parked: "parked" }[k]}</span>`) : html`<span class="cnt">Nothing running${only ? ` in ${only}` : ""}.</span>`}</div>
        </div>
        <div class="bcols" aria-hidden="true"><span></span><span>Session</span><span>Status, and what it last said or is doing</span><span>Context</span><span>Steps</span><span>Running, made</span><span>Since</span><span></span></div>
        ${GROUPS.map(([k, title]) => {
          const list = k === "earlier" ? shownEarlier : by[k];
          if (!list.length) return null;
          return html`<section class="bgrp ${k}">
            <h2 class="grp"><b>${title}</b><span class="c">${k === "earlier" ? by.earlier.length : list.length}</span>${k === "earlier" && html`<span class="r">${earlierAll ? "all loaded" : "today and yesterday"}</span>`}</h2>
            ${list.map((s) => html`<${BoardRow} key=${s.sessionId} s=${s} open=${open.has(s.sessionId)} toggle=${toggle} sel=${sel} cursor=${cursor} say=${say} qk=${QWERTY[qn++]} />`)}
            ${k === "earlier" && (!earlierAll && by.earlier.length > shownEarlier.length
              ? html`<button class="kb bmore" onClick=${() => setEarlierAll(true)}>Show ${by.earlier.length - shownEarlier.length} older</button>`
              : earlierAll && more && html`<button class="kb bmore" onClick=${more}>Load more</button>`)}
          </section>`;
        })}
      </div>
      ${index && html`<aside class="pindex" aria-label="Pages">
        <div class="ph"><b>Pages</b><span>${pages.length ? `${plural(pages.length, "page")}, newest first` : "none yet"}</span></div>
        ${pages.map(({ p, s }) => html`<button class="pirow" onClick=${() => (location.hash = pageLink(keyOf(s), p.name))}>
          <span class="h"><b>${pageTitle(p)}</b><span class="ago">${ago({ updated: p.updated || p.shown })}</span></span>
          ${p.note && html`<span class="n">${p.note}</span>`}
          <span class="s">${s.title}</span>
        </button>`)}
      </aside>`}
    </div>`;
}

function RailList({ live, hist, only, sel, cursor }) {
  const by = bayLists(live, hist, only);
  const active = [...by.waiting, ...by.working];
  const earlier = by.earlier.slice(0, 8), np = by.pinned.length;
  return html`<div class="rail" id="rscroll">
    ${np > 0 && html`<h2 class="grp"><b>Pinned</b><span class="c">${np}</span></h2>
      ${by.pinned.map((s, i) => html`<${BoardRow} key=${s.sessionId} s=${s} rail sel=${sel} cursor=${cursor} qk=${QWERTY[i]} />`)}
      ${active.length > 0 && html`<h2 class="grp"><b>Now</b><span class="c">${active.length}</span></h2>`}`}
    ${active.map((s, i) => html`<${BoardRow} key=${s.sessionId} s=${s} rail sel=${sel} cursor=${cursor} qk=${QWERTY[np + i]} />`)}
    ${by.parked.length > 0 && html`<h2 class="grp"><b>Parked</b><span class="c">${by.parked.length}</span><span class="r">to resume later</span></h2>
      ${by.parked.map((s, i) => html`<${BoardRow} key=${s.sessionId} s=${s} rail sel=${sel} cursor=${cursor} qk=${QWERTY[np + active.length + i]} />`)}`}
    ${earlier.length > 0 && html`<h2 class="grp"><b>Earlier</b><span class="c">${by.earlier.length}</span></h2>
      ${earlier.map((s, i) => html`<${BoardRow} key=${s.sessionId} s=${s} rail sel=${sel} cursor=${cursor} qk=${QWERTY[np + active.length + by.parked.length + i]} />`)}`}
    ${!np && !active.length && !by.parked.length && !earlier.length && html`<p class="calm">Nothing here yet.</p>`}
  </div>`;
}



const byStart = (a, b) => (Date.parse(a.startedAt || 0) || 0) - (Date.parse(b.startedAt || 0) || 0) || a.sessionId.localeCompare(b.sessionId);
const pinnedOf = (list) => (list || []).filter((x) => x.pinned && !away(x)).sort(byStart);

function arrange(list) {
  const bay = (st) => (list || []).filter((x) => !x.pinned && !away(x) && x.state === st);
  return pinnedOf(list)
    .concat(["needs-you", "your-turn", "working"].flatMap(bay))
    .concat((list || []).filter((x) => away(x)))
    .concat(bay("stopped"));
}

const lineageOf = (s) => s && (s.root || s.sessionId);
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const touchedBy = (hub, live, since) => {
  const me = lineageOf(hub);
  return me ? (live || []).filter((s) => s.reportsTo === me && s.kind !== "hub" && (Date.parse(s.updated || s.startedAt || 0) || 0) >= since).sort(byRecent) : [];
};

function AssistantView({ hub, live, loaded, agents, say, panes, togglePane }) {
  const phone = usePhone();
  useCall();
  const docked = useCallDock() && Call.live() && !phone;
  const [voice, setVoice] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [leftCall, setLeftCall] = useState(false);
  const left = docked ? leftCall : panes.aleft;
  const asked = useRef(false), dot = useRef(null);
  useNow(30000);
  useEffect(() => {
    if (!loaded || hub || asked.current) return;
    asked.current = true;
    api("/api/assist", { method: "POST" }).catch((e) => say(`Could not start the assistant: ${e.message}`));
  }, [loaded, !!hub]);
  useKeyLayer((e) => {
    if (typingIn(e.target)) return false;
    if (e.key === "Escape") return !docked && (closeAssistant(), true);
    if (e.key === "[") return (docked ? setLeftCall((v) => !v) : togglePane("aleft")), true;
    if (e.key !== "." || Call.live()) return false;
    if (!e.repeat && !dot.current) dot.current = setTimeout(() => { dot.current = "held"; if (hub) setVoice(true); }, 350);
    return true;
  });
  useEffect(() => {
    const up = (e) => {
      if (e.key !== "." || !dot.current) return;
      if (dot.current !== "held") { clearTimeout(dot.current); CAN_CALL ? callAssistant() : say("Calls need atc's call line and a microphone."); }
      dot.current = null;
    };
    addEventListener("keyup", up);
    return () => removeEventListener("keyup", up);
  }, []);

  const touched = touchedBy(hub, live, startOfDay());
  const shown = (agents || []).filter((a) => !a.error && a.name !== "assistant");
  const runOf = (a) => live.filter((x) => x.agent === a.name).sort(byRecent)[0];
  const pane = html`<aside class="aleft" aria-label="Touched today">
    <h3 class="grp"><b>Touched today</b><span class="c">${touched.length}</span></h3>
    ${touched.length ? touched.map((s) => html`<a class="tr" href=${`#/s/${keyOf(s)}`} data-sid=${s.sessionId} onClick=${() => setSheet(false)}>
        <${StateBlock} s=${s} /><b>${s.title || "Untitled"}</b><span class="ago">${txClock(s.updated)}</span>
        <span class="l">${[bayOf(s), s.state === "working" ? doing(s) : headline(s)].filter(Boolean).join(", ")}</span></a>`)
      : html`<p class="none">Nothing yet today. Sessions it starts or tells show here.</p>`}
    <h3 class="grp"><b>Agents</b><span class="c">${shown.length}</span></h3>
    ${shown.map((a) => { const r = runOf(a); return html`<a class="tr ag" href=${`${AGENTS_ROUTE}/${encodeURIComponent(a.name)}`} onClick=${() => setSheet(false)}>
      <b>@${a.name}</b><span class="ago">${r?.updated ? txClock(r.updated) : ""}</span>
      <span class="l">${oneLine(r?.summary?.status) || oneLine(r?.lastReply) || a.title || ""}</span></a>`; })}
  </aside>`;

  const busy = touched.filter((s) => s.state === "working" || s.state === "needs-you").slice(0, 3);
  const strips = busy.length > 0 && html`<div class="alive" aria-label="What it set going">${busy.map((s) => html`
    <a class="ls ${s.state}" href=${`#/s/${keyOf(s)}`}><${StateBlock} s=${s} /><span class="ti">${s.title || "Untitled"}</span><span class="bayn">${bayOf(s) || ""}</span>
      <span class="now"><span>${s.state === "needs-you" ? doingLine(s) || "Waiting on you" : doing(s)}</span><span class="el">${s.promptAt ? txSpan(Date.now() - Date.parse(s.promptAt)) : ""}</span></span></a>`)}</div>`;
  const onCall = Call.live();
  const cmp = {
    prompt: onCall ? html`<span class="apr call"><${CallMark} />${!docked && html`<${Trace} />`}</span>` : html`<span class="apr">assistant<span>></span></span>`,
    hint: onCall ? "Type while you talk" : phone ? "Ask the assistant" : "Start, steer or ask about any session",
    doors: !onCall && html`<button class="kb vo" onClick=${() => setVoice(true)} title="Voice mode: talk with it and it answers aloud (hold .)">Voice</button>
      ${CAN_CALL && html`<button class="kb cl" onClick=${callAssistant} aria-keyshortcuts=".">Call <kbd aria-hidden="true">.</kbd></button>`}`,
    top: strips,
  };
  return html`<div class="shell assistv assist ${left && !phone ? "" : "noleft"}">
    ${left && !phone && pane}
    <main class="amain">
      <header class="ahd">
        ${hub ? html`<${StateBlock} s=${hub} />` : html`<span class="sb earlier" aria-hidden="true">E</span>`}
        <h1>Assistant</h1>
        <span class="r">${phone ? html`<button class="kb" onClick=${() => setSheet(true)}>Today</button>`
          : html`<button class="kb" onClick=${closeAssistant} aria-keyshortcuts="Escape">Close <kbd aria-hidden="true">esc</kbd></button>`}</span>
        <p class="stat">${hubLine(hub)}</p>
      </header>
      ${hub ? html`<${Transcript} key=${hub.sessionId} s=${hub} say=${say} voice=${voice} onVoiceOff=${() => setVoice(false)} cmp=${cmp} />`
        : html`<div class="blank">${loaded ? "Starting the assistant…" : "Opening…"}</div>`}
    </main>
    ${sheet && html`<${Sheet} cls="asheet" title="Today" onClose=${() => setSheet(false)}>${pane}<//>`}
  </div>`;
}

function useCall() {
  const [, tick] = useState(0);
  useEffect(() => Call.subscribe(() => tick((n) => n + 1)), []);
  return [Call.get(), Call.face()];
}
function useCallDock() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    addEventListener("atc-calldock", f);
    return () => removeEventListener("atc-calldock", f);
  }, []);
  return CALLDOCK.open;
}

const closeCall = () => (history.length > 1 ? history.back() : location.replace("#/"));
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const callDoing = (f) => ({
  hearing: "Hearing you",
  thinking: "Thinking",
  tool: `Using ${(f.tool.split("__").pop() || "a tool").replace(/_/g, " ")}`,
  speaking: "Speaking",
})[f.state] || "Listening";
const callWord = (st, f) => st.phase === "calling" ? "calling"
  : st.phase === "ended" ? `call ended${st.why ? `: ${st.why}` : ""}`
  : st.phase !== "active" ? (CAN_CALL ? "not on a call" : "calls need atc's call line and a microphone")
  : st.muted ? "muted" : ({ hearing: "hearing you", thinking: "thinking", tool: "working", speaking: "speaking, tap to stop it" })[f.state] || "listening";

/** The call's level, drawn by the "line" character (minimal.js) small and in the page's ink: a hairline that ripples with the voices. */
function Trace() {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    return minimal(cv, { style: "line" }, () => { const [you, it] = Call.levels(); return { state: Call.face().state, you, it }; }, { gain: 4.5, ink: () => getComputedStyle(cv).color });
  }, []);
  return html`<canvas class="ctrace" ref=${ref} aria-hidden="true"></canvas>`;
}

function CallMark() {
  useNow(1000);
  const st = Call.get();
  return html`<span class="oncall"><b>On a call</b><span class="tm">${st.phase === "active" ? clock(Date.now() - st.since) : "ringing"}</span></span>`;
}

function useCallKeys(onEsc, esc) {
  useKeyLayer((e) => {
    if (!Call.live() || typingIn(e.target)) return false;
    if (e.key === "m") return Call.mute(), true;
    if (e.key === "E") return Call.hangup(), true;
    if (e.key === ".") return returnToCall(), true;
    if (e.key === "Escape" && esc) return onEsc(), true;
    return false;
  });
}

/** The call itself: the persona, what it is doing now, captions when the conversation is not beside it, and the controls. */
function CallPanel({ hub, live, captions, full, onMin }) {
  const [st, f] = useCall();
  const look = usePersona();
  const [opts, setOpts] = useState(false);
  useNow(1000);
  const on = Call.live();
  const mine = on ? touchedBy(hub, live, st.since || Date.now()) : [];
  const now = st.phase === "calling" ? "Ringing the assistant" : f.state === "tool" ? callDoing(f) : hub?.state === "working" && hub.activity ? doing(hub) : callDoing(f);
  return html`<aside class="callp ${full ? "full" : ""} ${st.phase}" aria-label="Call with the assistant">
    <div class="cph">
      ${on ? html`<${CallMark} /><span class="w">assistant</span>` : html`<b>${st.phase === "ended" ? "Call ended" : "Call"}</b><span class="w">assistant</span>`}
      <span class="sp"></span>
      <button class="kb" onClick=${onMin} aria-keyshortcuts="Escape">${on ? "Minimize" : "Close"} <kbd aria-hidden="true">esc</kbd></button>
    </div>
    <div class="cpers">
      <div class="fr"><${Persona} look=${look} state=${f.state} on=${st.phase === "active"} onTap=${Call.interrupt} /></div>
      <p class="st" aria-live="polite">${callWord(st, f)}</p>
    </div>
    ${opts && html`<${CallPicks} look=${look} onClose=${() => setOpts(false)} />`}
    ${on && !opts && html`<div class="cnow">
      <div class="h">Doing now${mine.length > 0 && html`<span>${plural(mine.length, "session")} on this call</span>`}</div>
      <div class="d">${now}</div>
      ${mine.length > 0 && html`<ol class="plan">${mine.map((s, i) => html`<li class=${s.state === "working" ? "run" : ""}>
        <span>${i + 1}</span><a href=${`#/s/${keyOf(s)}`}>${s.title || "Untitled"}</a><em>${away(s) ? "parked" : WORD[s.state] || "earlier"}</em></li>`)}</ol>`}
    </div>`}
    ${captions && on && !opts && html`<div class="caps" aria-live="polite">
      ${(f.hearing || f.you) && html`<div class="cap you ${f.hearing ? "" : "old"}"><span class="w">you</span><p>${f.hearing || f.you}${f.hearing && html`<span class="caret"></span>`}</p></div>`}
      ${f.said && html`<div class="cap it"><span class="w">assistant</span><p>${f.said}${f.state === "speaking" && html`<span class="caret"></span>`}</p></div>`}
    </div>`}
    <div class="ctl">
      ${on ? html`
        <button class="btn ${st.muted ? "on" : ""}" aria-pressed=${st.muted} onClick=${Call.mute} aria-keyshortcuts="m">${st.muted ? "Unmute" : "Mute"} <kbd aria-hidden="true">m</kbd></button>
        <button class="btn ${opts ? "on" : ""}" aria-pressed=${opts} onClick=${() => setOpts(!opts)} title="The character on the call, and the assistant's voice">Character</button>
        <button class="btn end" onClick=${Call.hangup} aria-keyshortcuts="Shift+E">End <kbd aria-hidden="true">E</kbd></button>`
      : st.phase !== "ended" && html`${CAN_CALL && html`<button class="btn prime" onClick=${callAssistant}>Call the assistant</button>`}
        <button class="btn ${opts ? "on" : ""}" aria-pressed=${opts} onClick=${() => setOpts(!opts)}>Character</button>`}
    </div>
  </aside>`;
}

/** Desktop: the call docked on the right of whatever is open. Minimized, the console line carries it. */
function CallDock({ hub, live, assisting }) {
  const [st] = useCall();
  const open = useCallDock();
  const phone = usePhone();
  const [linger, setLinger] = useState(false);
  useEffect(() => {
    if (st.phase !== "ended") return;
    setLinger(true);
    const t = setTimeout(() => setLinger(false), 2500);
    return () => clearTimeout(t);
  }, [st.phase]);
  const show = !phone && open && (Call.live() || linger);
  useEffect(() => { document.body.classList.toggle("docked", show); }, [show]);
  useEffect(() => () => document.body.classList.remove("docked"), []);
  useCallKeys(() => CALLDOCK.set(false), show);
  return show ? html`<${CallPanel} hub=${hub} live=${live} captions=${!assisting} onMin=${() => CALLDOCK.set(false)} />` : null;
}

/** Phone: the call full screen, over everything but the tab bar. */
function CallScreen({ hub, live }) {
  const [st] = useCall();
  useEffect(() => {
    if (st.phase !== "ended") return;
    const t = setTimeout(() => location.hash === CALL && !Call.live() && closeCall(), 1500);
    return () => clearTimeout(t);
  }, [st.phase]);
  useCallKeys(closeCall, true);
  return html`<${CallPanel} full hub=${hub} live=${live} captions onMin=${closeCall} />`;
}

/** Phone: on a call and not on the call screen, a live row above the tab bar. */
function CallPill() {
  useCall();
  const phone = usePhone();
  if (!phone || !Call.live()) return null;
  return html`<div class="callpill" role="group" aria-label="Call">
    <button class="back" onClick=${returnToCall} aria-label="Back to the call"><${CallMark} /><${Trace} /><span class="w">assistant</span></button>
    <button class="btn end" onClick=${Call.hangup}>End</button>
  </div>`;
}

/** Desktop: the console line while on a call. The line moves only when the panel is minimized, since the persona moves otherwise. */
function CallLine({ docked }) {
  const f = Call.face();
  return html`<footer class="console callline" aria-label="Call">
    <button class="back" onClick=${returnToCall} aria-keyshortcuts="." title=${docked ? "The call" : "Back to the call"}>
      <${CallMark} />${!docked && html`<${Trace} />`}<span class="w">assistant</span><span class="said">${f.said || callDoing(f)}</span></button>
    ${!docked && html`<button class="kb" onClick=${returnToCall} tabindex="-1">Return <kbd aria-hidden="true">.</kbd></button>`}
    <button class="kb end" onClick=${Call.hangup} aria-keyshortcuts="Shift+E">End <kbd aria-hidden="true">E</kbd></button>
  </footer>`;
}

const ORB_LOOKS = {
  listening: [[.08, .25, .9], [.2, .75, 1], [.75, .5, 1]],
  hearing: [[.02, .42, .4], [.2, .95, .7], [.85, 1, .5]],
  thinking: [[.3, .1, .85], [.85, .3, .95], [.3, .75, 1]],
  tool: [[.8, .25, .05], [1, .65, .2], [1, .3, .5]],
  speaking: [[.12, .18, .95], [.35, .65, 1], [1, .45, .85]],
};
const ORB_SRC = `precision highp float;
uniform vec2 size; uniform float t, level, think, hear, speak, bg, rad, lift, spin, flow, wave; uniform vec3 c1, c2, c3;
float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hash2(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p) { float a = .5, s = 0.; for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.03 + 3.1; a *= .5; } return s; }
float blob(vec3 p, float lv) {
  float amp = .018 + .008 * think + lv * (.028 * speak + .022 * hear + .008);
  float d = sin(p.x * 2.1 + t * .5) * sin(p.y * 2.4 - t * .42) * sin(p.z * 1.9 + t * .35);
  d += .5 * sin(p.x * 3.6 - t * .7 + p.y * 1.7) * sin(p.z * 3.2 + t * .6);
  d += (.15 + .3 * think + .4 * speak * lv) * sin(dot(p, vec3(2.6, 3.4, 2.2)) + flow);
  return length(p) - (1. + .018 * sin(t * .55) + .04 * lv) - d * amp;
}
vec3 normalAt(vec3 p, float lv) {
  vec2 e = vec2(.003, -.003);
  return normalize(e.xyy * blob(p + e.xyy, lv) + e.yyx * blob(p + e.yyx, lv) + e.yxy * blob(p + e.yxy, lv) + e.xxx * blob(p + e.xxx, lv));
}
void main() {
  vec2 uv = (gl_FragCoord.xy - .5 * size) / min(size.x, size.y);
  float lv = min(level, 1.);
  vec2 ctr = vec2(0., lift + .008 * sin(t * .45));
  vec2 q = (uv - ctr) / rad;
  float dq = length(q);
  vec3 tint = mix(c1, c2, .55);
  vec3 col = vec3(0.);
  float a = 0.;
  if (bg > 0.) {
    float n1 = fbm(vec3(uv * 1.3, t * .04));
    float n2 = fbm(vec3(uv * 1.1 + n1 * 1.8 + vec2(t * .03, -t * .02), t * .05 + 5.));
    col = (vec3(.01, .013, .025) + c1 * .03) * (1.25 - .45 * length(uv * vec2(.8, .55)));
    col += mix(c1, c2, n1) * smoothstep(.38, .9, n2) * (.12 + .2 * lv) * smoothstep(2.2, .3, length(uv - ctr * .5));
    float ring = pow(.5 + .5 * sin(dq * 6. - wave), 6.);
    col += tint * ring * smoothstep(1., 1.3, dq) * exp(-(dq - 1.) * .9) * lv * (.16 * speak + .12 * hear);
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      vec2 g = uv * (11. + 9. * fi) + vec2(fi * 3.7, t * (.04 + .03 * fi));
      vec2 id = floor(g), f = fract(g) - .5;
      float h = hash2(id + fi * 7.1);
      vec2 off = vec2(hash2(id + 3.3), hash2(id + 9.7)) - .5;
      float s = smoothstep(.07, 0., length(f - off * .7)) * step(.82, h) * (.6 + .4 * sin(t * (.3 + .8 * h) + h * 40.));
      col += mix(c3, vec3(1.), .5) * s * (.25 + .35 * smoothstep(3., .8, dq) + .3 * lv);
    }
    a = 1.;
  }
  float glow = exp(-max(dq - 1., 0.) * (7. - 3. * lv)) * (.35 + .5 * lv) + exp(-max(dq - 1., 0.) * 1.6) * (.07 + .12 * lv);
  if (bg <= 0.) glow *= smoothstep(2.8, 1.2, dq);
  col += tint * glow;
  a += glow * .9;
  vec3 back = vec3(0.), front = vec3(0.);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float an = t * (.25 + .03 * fi) + fi * .698;
    float orbit = 1.32 + .08 * sin(t * .4 + fi * 2.3);
    vec2 pos = vec2(cos(an), sin(an) * .3) * orbit;
    pos = vec2(pos.x * .96 - pos.y * .28, pos.x * .28 + pos.y * .96);
    float sp = (exp(-length(q - pos) * 40.) * 2.5 + exp(-length(q - pos) * 12.) * .35) * think;
    if (sin(an) > 0.) back += c3 * sp; else front += c3 * sp;
  }
  col += back;
  a += length(back);
  if (dq < 1.45) {
    float cs = cos(spin), sn = sin(spin), tx = .2 * sin(t * .1);
    mat3 m = mat3(cs, 0., -sn, 0., 1., 0., sn, 0., cs) * mat3(1., 0., 0., 0., cos(tx), sin(tx), 0., -sin(tx), cos(tx));
    vec3 ro = vec3(0., 0., 4.), rd = normalize(vec3(q, -4.));
    vec3 rdo = m * rd;
    vec3 p = m * ro;
    float b = dot(p, rdo), c = dot(p, p) - 2.1, h = b * b - c;
    float dist = -b - sqrt(max(h, 0.)), best = 9.;
    vec3 near = p + rdo * dist;
    if (h > 0.) {
      for (int i = 0; i < 34; i++) {
        vec3 x = p + rdo * dist;
        float d = blob(x, lv);
        if (d < best) { best = d; near = x; }
        if (d < .001) break;
        dist += d * .55;
        if (dist > 7.) break;
      }
    }
    float cov = 1. - smoothstep(0., 2. / (min(size.x, size.y) * rad), best);
    if (cov > 0.) {
      vec3 no = normalAt(near, lv);
      vec3 n = no * m;
      vec3 v = -rd;
      float z = max(dot(n, v), 0.);
      float fres = pow(1. - z, 3.);
      float ph = dot(n, vec3(sin(t * .11), cos(t * .09), .5)) * 2.2 + fbm(no * 1.6 + t * .03) * 4. + t * .08;
      vec3 iri = mix(c1, c2, .5 + .5 * sin(ph * 2.2));
      iri = mix(iri, c3, smoothstep(.55, 1., sin(ph * 1.3 + 1.7)) * .6);
      vec3 ip = near + refract(rdo, no, .72) * .7;
      float sw = fbm(ip * 1.7 + vec3(0., flow * .06, t * .03));
      vec3 inner = mix(c1 * .12, c1, smoothstep(.25, .55, sw));
      inner = mix(inner, c2, smoothstep(.5, .75, sw)) + c3 * pow(smoothstep(.45, .85, sw), 2.) * (.4 + .9 * lv);
      inner += mix(c3, vec3(1.), .3) * pow(max(1. - abs(sw - .52) * 7., 0.), 3.) * (.35 + .7 * lv);
      vec3 sc = mix(inner, iri, .25 + .55 * fres);
      sc += mix(c2, c3, .4) * pow(z, 3.) * (.22 + .35 * lv);
      sc += fres * mix(c2, c3, .5 + .5 * sin(ph)) * .8;
      vec3 rf = reflect(rd, n);
      sc += pow(max(dot(rf, normalize(vec3(-.5, .7, .6))), 0.), 48.) * .7;
      sc += c2 * pow(max(dot(rf, normalize(vec3(.6, -.5, .4))), 0.), 6.) * .25;
      sc = 1. - exp(-sc * 1.5);
      col = mix(col, sc, cov);
      a = mix(a, 1., cov);
    }
  }
  col += front;
  a += length(front);
  if (bg <= 0.) {
    vec2 e = .5 * size / min(size.x, size.y);
    float keep = smoothstep(e.x, e.x - .12, abs(uv.x)) * smoothstep(e.y, e.y - .12, abs(uv.y));
    col *= keep; a *= keep;
  }
  a = clamp(a, 0., 1.);
  gl_FragColor = vec4(min(col, vec3(a)), a);
}`;

function orbGL(canvas) {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const sh = (type, src) => {
    const x = gl.createShader(type);
    gl.shaderSource(x, src);
    gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) console.warn("orb:", gl.getShaderInfoLog(x));
    return x;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }"));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, ORB_SRC));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const u = Object.fromEntries(["size", "t", "level", "think", "hear", "speak", "bg", "rad", "lift", "spin", "flow", "wave", "c1", "c2", "c3"].map((k) => [k, gl.getUniformLocation(prog, k)]));
  return (w, h, t, o) => {
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.size, w, h);
    gl.uniform1f(u.t, t);
    gl.uniform1f(u.level, Math.min(o.level, 1.2));
    gl.uniform1f(u.think, o.think);
    gl.uniform1f(u.hear, o.hear);
    gl.uniform1f(u.speak, o.speak);
    gl.uniform1f(u.spin, o.spin);
    gl.uniform1f(u.flow, o.flow);
    gl.uniform1f(u.wave, o.wave);
    const tall = h > w * 1.3;
    gl.uniform1f(u.bg, o.full ? 1 : 0);
    gl.uniform1f(u.rad, o.full ? (tall ? .27 : .19) : .22);
    gl.uniform1f(u.lift, o.full ? (tall ? .1 : .07) : .02);
    gl.uniform3fv(u.c1, o.c[0]);
    gl.uniform3fv(u.c2, o.c[1]);
    gl.uniform3fv(u.c3, o.c[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}

function orb2D(canvas) {
  const g = canvas.getContext("2d");
  const css = (c, al = 1) => `rgba(${c.map((v) => Math.round(v * 255)).join(",")},${al})`;
  return (w, h, t, o) => {
    g.clearRect(0, 0, w, h);
    if (o.full) { g.fillStyle = cssColors("dark", ["call-bg"])[0]; g.fillRect(0, 0, w, h); }
    const r = Math.min(w, h) * (.22 + .08 * Math.min(o.level, 1));
    let gr = g.createRadialGradient(w / 2, h / 2, r * .6, w / 2, h / 2, r * 1.6);
    gr.addColorStop(0, css(o.c[1], .45));
    gr.addColorStop(1, css(o.c[1], 0));
    g.fillStyle = gr;
    g.beginPath(); g.arc(w / 2, h / 2, r * 1.6, 0, 7); g.fill();
    gr = g.createRadialGradient(w / 2 - r * .3, h / 2 - r * .3, 0, w / 2, h / 2, r);
    gr.addColorStop(0, css(o.c[2]));
    gr.addColorStop(1, css(o.c[0]));
    g.fillStyle = gr;
    g.beginPath(); g.arc(w / 2, h / 2, r, 0, 7); g.fill();
  };
}

const PERSONAS = "/app/personas/";
const personaPick = {
  get: () => { try { return localStorage.getItem("atc.persona"); } catch { return null; } },
  set: (n) => { try { localStorage.setItem("atc.persona", n); } catch {} },
};

async function personaList() {
  const index = await (await fetch(PERSONAS + "index.json")).json();
  const all = index.personas || [];
  const kinds = await Promise.all(all.map(({ name }) => fetch(`${PERSONAS}${name}/persona.json`).then((r) => r.json()).then((p) => p.kind).catch(() => null)));
  const usable = all.map((p, i) => [p.name, kinds[i]]).filter(([, k]) => ["illustration", "footage", "rig", "minimal"].includes(k));
  return { names: ["orb", ...usable.map(([n]) => n)], kinds: Object.fromEntries(usable), def: index.default || "orb" };
}

/** Which character the call shows: the orb or one from /app/personas, the choice kept in this browser. */
function usePersona() {
  const [list, setList] = useState({ names: ["orb"], kinds: {}, def: "orb" });
  const [name, setName] = useState(personaPick.get);
  useEffect(() => { personaList().then(setList).catch(() => {}); }, []);
  const want = name ?? list.def;
  const shown = list.names.includes(want) ? want : "orb";
  const pick = (n) => { personaPick.set(n); setName(n); };
  return { names: list.names, kinds: list.kinds, shown, pick, framed: !["orb", "minimal"].includes(list.kinds[shown] || shown) };
}

/** The call's persona slot. Holding it (or a right click) switches to the next character. */
function Persona({ look, state, on, onTap }) {
  const { names, shown, pick, framed } = look;
  const [label, setLabel] = useState(null);
  const hold = useRef(null);
  const held = useRef(false);
  const next = (e) => {
    e?.preventDefault();
    const n = names[(names.indexOf(shown) + 1) % names.length];
    pick(n);
    setLabel(n);
    setTimeout(() => setLabel(null), 1200);
  };
  const down = () => { held.current = false; hold.current = setTimeout(() => { held.current = true; next(); }, 600); };
  const up = () => clearTimeout(hold.current);
  const tap = () => { if (!held.current) onTap(); };
  return html`<div class="orb persona ${framed ? "framed" : ""}" onPointerDown=${down} onPointerUp=${up} onPointerLeave=${up} onContextMenu=${next}>
    ${shown === "orb" ? html`<${Orb} full state=${state} on=${on} onTap=${tap} />` : html`<${Drawn} key=${shown} name=${shown} state=${state} on=${on} onTap=${tap} />`}
    ${label && html`<span class="personaname">${label}</span>`}
  </div>`;
}

const PERSONA_WORDS = { orb: "A glass sphere that swirls with the voices", line: "A hairline that ripples with the voices, quiet enough for a call in public", bars: "Four short bars, like a voice meter" };
const KIND_WORDS = { rig: "A drawn portrait that looks, nods and talks", illustration: "A drawn portrait", footage: "A filmed portrait", minimal: "A quiet mark that only moves with the voices" };
const VOICE_LANG = { tr: "Turkish", en: "English" };
const voiceName = (v) => v.replace(/^en_/, "").replace(/_/g, " ");

/** The character and the assistant's voice, inside the call panel: a character picked shows at once in the big frame
 *  above, a voice can be heard first (delta renders a sample once and keeps it), and a pick applies from its next reply. */
function CallPicks({ look, onClose }) {
  const [voices, setVoices] = useState(null);
  const [note, setNote] = useState("");
  const [playing, setPlaying] = useState(null);
  const audio = useRef(null);
  useEffect(() => {
    api("/api/call/voices").then(setVoices, () => setNote("The voices are not reachable."));
    return () => audio.current?.pause();
  }, []);
  useKeyLayer((e) => e.key === "Escape" && !typingIn(e.target) && (onClose(), true));
  const stop = () => { audio.current?.pause(); audio.current = null; setPlaying(null); };
  const play = async (lang, v) => {
    const k = `${lang}:${v}`;
    if (playing === k) return stop();
    stop();
    setPlaying(k);
    setNote("");
    try {
      const r = await fetch(`/api/call/voices/sample?${new URLSearchParams({ lang, voice: v, text: voices[lang].sample })}`);
      if (!r.ok) throw new Error(r.status === 409 ? "delta is on a call, and this sample renders after it" : "the sample did not come");
      const a = new Audio(URL.createObjectURL(await r.blob()));
      audio.current = a;
      a.onended = () => setPlaying((p) => (p === k ? null : p));
      await a.play();
    } catch (e) {
      setPlaying((p) => (p === k ? null : p));
      setNote(`Can't play ${voiceName(v)}: ${e.message}.`);
    }
  };
  const use = async (lang, v) => {
    setNote(`Switching to ${voiceName(v)}`);
    try { setVoices(await api("/api/call/voices", { method: "POST", body: { lang, voice: v } })); setNote(`${voiceName(v)} speaks from the assistant's next reply.`); }
    catch (e) { setNote(`Couldn't switch the voice: ${e.message}`); }
  };
  const langs = Object.keys(voices || {}).sort((a, b) => (a === "tr" ? -1 : b === "tr" ? 1 : a.localeCompare(b)));
  return html`<div class="picks" role="region" aria-label="Character and voice">
    <div class="pkh"><b>Character and voice</b><button class="kb" onClick=${onClose} aria-keyshortcuts="Escape">Done <kbd aria-hidden="true">esc</kbd></button></div>
    <h3 class="grp"><b>Character</b><span class="c">${look.names.length}</span></h3>
    <div role="radiogroup" aria-label="Character">${look.names.map((n) => html`
      <button class="pick ${n === look.shown ? "on" : ""}" role="radio" aria-checked=${n === look.shown} onClick=${() => look.pick(n)}>
        <b>${n}</b><span>${PERSONA_WORDS[n] || KIND_WORDS[look.kinds[n]] || ""}</span></button>`)}</div>
    ${langs.map((lang) => { const v = voices[lang]; return html`
      <h3 class="grp"><b>${VOICE_LANG[lang] || lang} voice</b><span class="c">${v.voices.length}</span></h3>
      ${v.voices.map((name) => { const on = name === v.current, k = `${lang}:${name}`; return html`
        <div class="vpick ${on ? "on" : ""}"><span class="nm">${voiceName(name)}</span>
          ${on ? html`<span class="use">in use</span>` : html`<button class="kb" onClick=${() => use(lang, name)}>Use</button>`}
          <button class="kb" aria-pressed=${playing === k} onClick=${() => play(lang, name)}>${playing === k ? "Stop" : "Play"}</button></div>`; })}`; })}
    ${!voices && !note && html`<p class="sub">Loading the voices</p>`}
    ${note && html`<p class="sub" role="status">${note}</p>`}
  </div>`;
}

function Drawn({ name, state, on, onTap }) {
  const ref = useRef(null);
  const now = useRef(state);
  now.current = state;
  useEffect(() => {
    let stop = null, gone = false;
    persona(ref.current, `${PERSONAS}${name}/`, () => { const [you] = Call.levels(), [it, lo, hi] = Call.speech(); return { state: now.current, you, it, lo, hi }; })
      .then((s) => (gone ? s() : (stop = s)))
      .catch((e) => console.warn("persona", name, e));
    return () => { gone = true; stop?.(); };
  }, [name]);
  return html`<canvas ref=${ref} class="orb ${on ? "" : "idle"}" onClick=${onTap} aria-label="The assistant. Tap to stop it while it speaks"></canvas>`;
}

function Orb({ state, on, onTap, full }) {
  const ref = useRef(null);
  const now = useRef(state);
  now.current = state;
  useEffect(() => {
    const cv = ref.current;
    const draw = orbGL(cv) || orb2D(cv);
    const o = { full, level: 0, think: 0, hear: 0, speak: 0, spin: 0, flow: 0, wave: 0, c: ORB_LOOKS.listening.map((c) => [...c]) };
    const start = performance.now();
    let raf, last = start;
    const frame = (ms) => {
      raf = requestAnimationFrame(frame);
      const t = (ms - start) / 1000, dt = Math.min((ms - last) / 1000, .1), st = now.current, look = ORB_LOOKS[st] || ORB_LOOKS.listening;
      last = ms;
      const ease = (v, to, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
      const [you, it] = Call.levels();
      const target = { speaking: .08 + .8 * it, hearing: .06 + .7 * you, thinking: .18, tool: .18 }[st] ?? .04 + you * .25;
      o.level = ease(o.level, target, target > o.level ? .18 : .5);
      o.think = ease(o.think, +(st === "thinking" || st === "tool"), 1.2);
      o.hear = ease(o.hear, +(st === "hearing"), 1.2);
      o.speak = ease(o.speak, +(st === "speaking"), 1.2);
      o.spin += dt * (.08 + .18 * o.think);
      o.flow += dt * (.5 + .9 * Math.min(o.level, 1));
      o.wave += dt * 1.4 * (o.speak - o.hear);
      look.forEach((c, i) => c.forEach((v, j) => (o.c[i][j] = ease(o.c[i][j], v, 1.4))));
      const k = Math.min(devicePixelRatio || 1, full ? 1.25 : 2), w = Math.round(cv.clientWidth * k), h = Math.round(cv.clientHeight * k);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      if (w && h) draw(w, h, t, o);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return html`<canvas ref=${ref} class="orb ${full ? "full" : ""} ${on ? "" : "idle"}" onClick=${onTap} aria-label="The assistant. Tap to stop it while it speaks"></canvas>`;
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

const entered = new Map();
const steady = (list) => {
  const phase = (st) => (st === "needs-you" || st === "your-turn" ? "wait" : st);
  for (const s of list) {
    const e = entered.get(s.sessionId);
    if (!e || e.phase !== phase(s.state)) entered.set(s.sessionId, { phase: phase(s.state), at: Date.parse(s.updated || 0) || 0 });
  }
  return [...list].sort((a, b) => entered.get(b.sessionId).at - entered.get(a.sessionId).at);
};

const byRecent = (a, b) => (Date.parse(b.updated || 0) || 0) - (Date.parse(a.updated || 0) || 0);

const LOCAL_SEEN = (() => { try { return JSON.parse(localStorage.getItem("atc.seen")) || {}; } catch { return {}; } })();
const seenFloor = () => Math.min(Date.now(), ...Object.values(SYNC.seen || {}).map((t) => Date.parse(t) || Infinity));
const unread = (s) => {
  if ((s.state !== "your-turn" && s.state !== "needs-you") || away(s) || !SYNC.seen) return false;
  const looked = Math.max(Date.parse(seenOf(s.sessionId) || 0) || 0, Date.parse(LOCAL_SEEN[s.sessionId] || 0) || 0);
  return Date.parse(s.updated || 0) > (looked || seenFloor());
};
const oneLine = (t) => (t || "").replace(/\*\*|__|`+|^#+\s*|^>\s*/gm, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();

const ICON = {
  phone: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.2 2.5h2l1 2.8-1.4 1.1a7 7 0 0 0 3.8 3.8l1.1-1.4 2.8 1v2c0 .6-.5 1.1-1.1 1.1A10.6 10.6 0 0 1 3.1 3.6c0-.6.5-1.1 1.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  chat: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  plus: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  search: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  pin: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1.5l5 5-2 .5-2.5 2.5.5 3-1.5 1.5L6 10l-3.5 3.5M6 10L2.5 6.5 4 5l3 .5L9.5 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  park: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  play: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>`,
  layout: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 2.5v11M8.5 6h3M8.5 9h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  globe: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.4 8h11.2M8 2.2c1.8 1.6 2.6 3.6 2.6 5.8S9.8 12.2 8 13.8C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 2.2z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  page: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2.5" y="2" width="11" height="12" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 5.5h6M5 8h6M5 10.5h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  list: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 4h7.5M6 8h7.5M6 12h7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.5 3.3l.8.8 1.4-1.6M2.5 7.3l.8.8 1.4-1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3.4" cy="12" r="1" fill="currentColor"/></svg>`,
  gear: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  more: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>`,
};

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
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

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

function useRowEvents(s, tap, swipes) {
  const press = useRef({ t: 0, fired: false, x: 0, y: 0 });
  const menu = (e) => { e?.preventDefault(); e?.stopPropagation(); QUICK(s, e?.currentTarget?.getBoundingClientRect()); };
  const hover = useRef(0);
  const swipe = useRef(null);
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
    onClick: (e) => { if (press.current.fired) { press.current.fired = false; return e.preventDefault(); } (tap || (() => go(keyOf(s))))(e); },
    onContextMenu: menu, onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up,
    onPointerEnter: (e) => { if (e.pointerType === "mouse") hover.current = setTimeout(() => prewarm(s), 150); },
    onPointerLeave: () => clearTimeout(hover.current),
  };
  return { events, menu };
}

function Pic({ src, alt = "", fallback }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  return !src || bad ? fallback : html`<img loading="lazy" src=${src} alt=${alt} onError=${() => setBad(true)} />`;
}

let QUICK = () => {};
let AGENT_SHEET = () => {};
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
    if (x.state === "past" || x.state === "stopped" || homeless(x)) continue;
    const n = project(x.cwd).name;
    if (!by.has(n)) by.set(n, { name: n, pips: [], own: false });
    const t = by.get(n);
    t.own ||= !x.agent;
    if (!away(x) && RANK[x.state] !== undefined) t.pips.push(x.state);
  }
  const tabs = [...by.values()].filter((t) => t.own || t.name === keep);
  if (keep && !by.has(keep)) tabs.push({ name: keep, pips: [] });
  for (const t of tabs) {
    t.pips.sort((a, b) => RANK[a] - RANK[b]);
    t.summary = Object.entries(t.pips.reduce((c, st) => ({ ...c, [st]: (c[st] || 0) + 1 }), {})).map(([st, n]) => `${n} ${WORD[st]}`).join(", ");
  }
  const key = (t) => (t.pips.length ? RANK[t.pips[0]] : 9);
  return tabs.sort((a, b) => key(a) - key(b) || b.pips.length - a.pips.length || a.name.localeCompare(b.name));
}

function ProjectTag({ path, full }) {
  const p = project(path);
  return html`<span class="projtag"><span class="proj" style=${`--ph: ${hueOf(p.name)}`} role="button" title=${`${tilde(path)}\nClick to go to the ${p.name} bay`}
    onClick=${(e) => { e.stopPropagation(); BAY.set(p.name); }}>${p.name}</span>${full && p.rest && html`<span class="rest">${p.rest}</span>`}</span>`;
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
  items.push({ label: "Rename", run: rename || (() => ask({ title: "Rename session", input: { value: s.title, placeholder: "Session name" }, ok: "Rename", busy: "Renaming…",
    run: (name) => name !== s.title && patch({ name }) }).then(after)) });
  items.push({ label: s.pinned ? "Unpin" : "Pin", run: run(() => patch({ pinned: !s.pinned })) });
  items.push({ label: s.parked ? "Unpark" : "Park", run: run(() => patch({ parked: !s.parked })) });
  items.push({ label: "Send to backlog", title: "Stop it and take it off the list; its backlog item resumes the same conversation. A working session stops when its turn ends", run: () => putAside(s, say).then(() => after && after()) });
  if (s.agent && s.state !== "past") items.push({ label: "Start over", title: "It writes a handover note and a new conversation starts from it", run: run(() => agentApi(s.agent, "reset"), () => say(`${s.title} is starting over.`)) });
  if (s.attachable) items.push({ label: "Stop", run: run(() => api(`/api/sessions/${s.id}/stop`, { method: "POST" }), () => say("Stopped. Resume it any time.")) });
  if (!s.attachable && s.kind !== "interactive")
    items.push({ label: "Resume", run: run(() => api(`/api/sessions/${s.sessionId}/resume`, { method: "POST" }), (r) => go(r.id)) });
  if (s.id)
    items.push({ label: "Delete", danger: true, run: () => ask({ title: `Delete “${s.title || "Untitled"}”?`, body: "Its conversation stays in history, where you can resume it.",
      ok: "Delete", busy: "Deleting…", danger: true, run: () => api(`/api/sessions/${s.id}`, { method: "DELETE" }) })
      .then((r) => { r && [s.id, s.sessionId].some((k) => location.hash.startsWith(`#/s/${k}`)) && location.replace("#/"); after && after(); }) });
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
  const box = useRef();
  useLayoutEffect(() => {
    const el = box.current;
    if (touch || !rect || !el) return;
    const h = el.offsetHeight, below = rect.bottom + 4, above = rect.top - 4 - h;
    el.style.top = `${Math.max(8, below + h <= innerHeight - 8 ? below : above >= 8 ? above : innerHeight - 8 - h)}px`;
    el.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 8 - el.offsetWidth))}px`;
  }, [rect]);
  const style = touch || !rect ? "" : "position: fixed; max-height: calc(100vh - 16px); overflow-y: auto";
  return html`
    <div class="veil quick ${touch ? "sheetish" : ""}" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet qmenu" ref=${box} style=${style}>
        <div class="qtitle">${s.title || "Untitled"}</div>
        ${items.map((it) => html`<button class="btn ${it.danger ? "danger" : ""}" onClick=${() => { onClose(); it.run(); }}>${it.label}</button>`)}
      </div>
    </div>
  `;
}

const PANE = "atc.pane", SESSION_PAGE = "atc.sessionPage";
function paneFor(s) {
  let p = null;
  try { p = localStorage.getItem(PANE); } catch {}
  if (p === "out") return p;
  return "chat";
}

const STATE_LETTER = { "needs-you": ["N", "needs"], "your-turn": ["T", "turn"], working: ["W", "working"] };
function StateBlock({ s, mini }) {
  const [l, c] = away(s) ? ["P", "parked"] : STATE_LETTER[s.state] || ["E", "earlier"];
  return html`<span class="sb ${c} ${mini ? "mini" : ""}" role="img" aria-label=${away(s) ? "parked" : WORD[s.state] || "earlier"}>${l}</span>`;
}
const CtxMeter = ({ n, max = n > 200000 ? 1000000 : 200000 }) => html`<span class="meter" aria-hidden="true"><i style=${`width:${Math.min(100, Math.round((n / max) * 100))}%`}></i></span>`;

function Session({ s, say, live, panes, togglePane }) {
  const canAttach = s.attachable;
  const hasTerm = s.kind !== "hub";
  const auto = useRef(AUTO_PANE);
  const shown = usePages(s);
  const [kept] = useState(() => { const n = !auto.current && !routePage() && stored(SESSION_PAGE, {})[s.sessionId]; return n && shown.some((p) => p.name === n) ? n : null; });
  const agentPage = !auto.current && !routePage() && !kept && !!s.agent && shown[0]?.name;
  const [mode, setMode] = useState(() => { AUTO_PANE = null; return auto.current || (routePage() || kept || agentPage ? "page" : paneFor(s)); });
  const [pg, setPg] = useState(() => splitRef(routePage())[0] || kept || agentPage);
  const [at, setAt] = useState(() => atOf(routePage()));
  const [split, setSplitRaw] = useState(() => { const v = AUTO_SPLIT || !!agentPage || stored(PAGE_SPLIT, true); AUTO_SPLIT = false; return v; });
  const setSplit = (v) => { setSplitRaw(v); store(PAGE_SPLIT, v); };
  const wideNow = useWide();
  const sideBySide = mode === "page" && split && wideNow && shown.length > 0;
  const base = () => location.hash.replace(/\/p\/.*$/, "");
  const keep = (name) => {
    const m = stored(SESSION_PAGE, {});
    delete m[s.sessionId];
    if (name) m[s.sessionId] = name;
    store(SESSION_PAGE, Object.fromEntries(Object.entries(m).slice(-100)));
  };
  const openPage = (ref) => { const [name] = splitRef(ref); setPg(name); setAt(atOf(ref)); setMode("page"); keep(name); history.replaceState(null, "", `${base()}/p/${encodeURIComponent(name)}`); };
  const leavePage = (m) => { setMode(m); keep(null); history.replaceState(null, "", base()); };
  useEffect(() => { if (kept || at) history.replaceState(null, "", `${base()}/p/${encodeURIComponent(pg)}`); }, []);
  const choose = (m) => { if (m === "page") return openPage(pg || shown[0]?.name); leavePage(m); try { localStorage.setItem(PANE, m); } catch {} };
  useEffect(() => { if (mode !== "chat" && !sideBySide) markLooked(s); }, [mode, sideBySide, s.updated]);
  useEffect(() => {
    const f = () => { const n = routePage(); if (n) openPage(n); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const known = useRef(null);
  useEffect(() => {
    const now = Object.fromEntries(shown.map((p) => [p.name, p.shown]));
    const prev = known.current;
    known.current = now;
    const p = prev && shown.find((x) => prev[x.name] !== x.shown);
    if (p && mode === "page" && pg === p.name && p.at) return setAt(atOf(pageRef(p)));
    if (!p || (mode === "page" && (pg === p.name || sideBySide))) return;
    const idle = Date.now() - LAST_KEY > 8000 && !document.activeElement?.closest?.("textarea, input, .xterm");
    if (idle && wideNow && split && mode !== "page" && p.kind !== "browser") openPage(pageRef(p));
    else say(p.kind === "browser" ? "It opened a browser tab. It's on the page button up top." : `Showing you “${pageTitle(p)}”. It's on the page button up top.`);
  }, [shown.map((p) => p.name + p.shown).join()]);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const voiceKey = `atc.voice.${s.sessionId}`;
  const [voice, setVoice] = useState(() => { const v = AUTO_VOICE && canAttach; if (v) AUTO_VOICE = false; return v || (canAttach && pref(voiceKey, "") === "on"); });
  useEffect(() => setPref(voiceKey, voice ? "on" : ""), [voice]);

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
    SESSION_API = { s, canAttach, mode: choose, page: openPage, pages: shown, voice: () => canAttach && setVoice((v) => (v || setMode("chat"), !v)), usage: () => setShowUse(true), rename: () => setRenaming(true) };
    return () => { SESSION_API = null; };
  });
  const use = useSessionUsage(s, showUse || s.state === "working" ? 15000 : 90000);
  const outCount = outs ? outs.servers.length + outs.files.filter((f) => f.kind !== "text").length + outs.links.length : 0;

  const renameBox = html`<input class="rn" ref=${focusOnMount} value=${s.title} aria-label="Session title" onKeyDown=${(e) => {
      if (e.key === "Enter") { patch({ name: e.target.value }); setRenaming(false); }
      if (e.key === "Escape") setRenaming(false);
    }} onBlur=${() => setRenaming(false)} />`;
  const [stateSheet, setStateSheet] = useState(false);
  const phoneNow = usePhone();
  const openState = () => (phoneNow ? setStateSheet(true) : togglePane("state"));
  const where = [MULTI && s.host, s.branch && s.branch !== "HEAD" && s.branch].filter(Boolean).join(" ");
  const running = outs?.servers.length || 0;
  useEffect(() => {
    const k = (e) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector(".veil, .pghome, .palone, .keys-ov")) return;
      if (e.key === "`" && hasTerm) { e.preventDefault(); choose(mode === "term" ? "chat" : "term"); }
      else if (e.key === "\\") { e.preventDefault(); openState(); }
      else if (e.key === "]" && shown.length) { e.preventDefault(); choose(mode === "page" ? paneFor(s) : "page"); }
      else if (e.key === "x") { e.preventDefault(); document.querySelector(".hd .more button")?.click(); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });
  const facts = [
    ["Context", s.context > 0 && `${Math.round(s.context / 1000)}k`],
    ["Cost", use?.total > 0 && html`<button class="link" onClick=${() => setShowUse(true)}>${usd(use.cost)}</button>`],
    ["Steps", s.steps > 0 && `${s.steps}${s.failed > 0 ? `, ${s.failed} failed` : ""}`],
    ["Model", engineTag(s) || (s.model && model(s.model))],
    ["Permissions", s.permissionMode === "bypassPermissions" ? "no prompts" : s.permissionMode],
    ["Host", s.host],
    ["Branch", s.branch !== "HEAD" && s.branch],
    ["Folder", s.cwd && tilde(s.cwd)],
    ["Started", s.startedAt && agoLong(s.startedAt)],
    ["Your last prompt", s.lastPrompt && oneLine(s.lastPrompt)],
    ["Reports to", s.reportsTo && (live?.find((x) => (x.root || x.sessionId) === s.reportsTo)?.title || "a session")],
    ["Pinned", s.pinned && "yes"],
  ].filter(([, v]) => v);
  const statePane = html`
    <div class="statep-in">
      <section><h3>Now</h3>
        <p class="now">${headline(s) || WORD[s.state] || s.state}</p>
        ${s.summary && html`<${SummaryParts} x=${s.summary} />`}
        ${replyable(s) && html`<${Replies} list=${s.summary.replies} pick=${(text) => api(`/api/sessions/${s.id}/send`, { method: "POST", body: { text, suggested: true } }).catch((e) => say(e.message))} />`}
        ${s.summary && html`<button class="kb" onClick=${() => api(`/api/sessions/${s.sessionId}/summary`, { method: "POST" }).then(() => say("Summarizing again…"), (e) => say(e.message))}>Summarize again</button>`}
      </section>
      <${Outputs} s=${s} data=${outs} pages=${shown} open=${openPage} />
      <section><h3>Session</h3><dl class="kv">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></section>
    </div>`;

  return html`
    <header class="hd">
      <div class="l1">
        <button class="kb back" onClick=${() => go(null)} aria-label="Back to the board">Back</button>
        <${StateBlock} s=${s} />
        ${renaming ? renameBox : html`<h1 onDblClick=${() => setRenaming(true)} title=${s.title}>${s.title || "Untitled"}</h1>`}
        ${where && html`<span class="where">${where}</span>`}
        <span class="r">
          ${shown.length > 0 && html`<${PagesButton} list=${shown} open=${openPage} on=${mode === "page"} />`}
          <button class="kb pin ${s.pinned ? "on" : ""}" aria-pressed=${!!s.pinned} aria-label=${s.pinned ? "Unpin" : "Pin"} title=${s.pinned ? "Pinned to the top of the bay; unpin" : "Pin to the top of the bay"}
            onClick=${() => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { pinned: !s.pinned } }).catch((e) => say(e.message))}>${ICON.pin}</button>
          ${VOICE.stt && html`<button class="kb ${voice ? "on" : ""}" aria-pressed=${voice}
            onClick=${() => canAttach ? (voice || setMode("chat"), setVoice(!voice))
              : say(s.kind === "interactive" ? "Voice needs a session atc can type into. This one runs in a terminal window; start one from atc, or resume this one after it ends." : "Resume this session first, then turn on voice.")}>Voice</button>`}
          ${hasTerm && html`<button class="kb ${mode === "term" ? "on" : ""}" aria-pressed=${mode === "term"} aria-keyshortcuts="\`" onClick=${() => choose(mode === "term" ? "chat" : "term")}>Terminal <kbd aria-hidden="true">\`</kbd></button>`}
          <div class="more"><${Menu} cls="kb" busy=${busy} aria="Session menu" label=${html`More <kbd aria-hidden="true">x</kbd>`}
            items=${[
              ...(phoneNow && hasTerm ? [{ label: mode === "term" ? "Transcript" : "Terminal", run: () => choose(mode === "term" ? "chat" : "term") }] : []),
              ...(phoneNow && VOICE.stt && canAttach ? [{ label: voice ? "Voice off" : "Voice", run: () => (voice || setMode("chat"), setVoice(!voice)) }] : []),
              ...(mode === "chat" || sideBySide ? [{ label: "Find in the transcript", run: () => TX_API?.find() }, { label: "Contents", run: () => TX_API?.contents() }, { label: "Outline, story or everything", run: () => TX_API?.level() }, { label: "Files, commits and deploys", run: () => TX_API?.results() }] : []),
              ...sessionActions(s, say, { rename: () => setRenaming(true), after: () => setBusy(false) }), { label: "State and outputs", run: openState }, { label: "Usage", run: () => setShowUse(true) }]} /></div>
        </span>
      </div>
      <div class="l2" role="button" tabindex="0" aria-label="State" aria-keyshortcuts="\\" onClick=${openState} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openState())}>
        <span class="stat">${headline(s) || WORD[s.state] || s.state}</span>
        ${(engineTag(s) || s.model) && html`<span class="rd">${engineTag(s) || model(s.model)}</span>`}
        ${s.context > 0 && html`<span class="rd"><${CtxMeter} n=${s.context} />${Math.round(s.context / 1000)}k</span>`}
        ${use?.total > 0 && html`<span class="rd">${usd(use.cost)}</span>`}
        ${s.steps > 0 && html`<span class="rd">${plural(s.steps, "step")}</span>`}
        ${running > 0 && html`<span class="rd run">${running} running</span>`}
        ${s.permissionMode === "bypassPermissions" && html`<span class="rd">no prompts</span>`}
      </div>
    </header>
    <div class="sbody ${panes?.state && !phoneNow ? "withstate" : ""}">
    <div class="smain">
    ${mode !== "chat" && !sideBySide && s.asks?.length > 0 && html`<div class="askstrip"><${Ask} compact s=${s} a=${s.asks[0]} say=${say} /></div>`}
    ${mode !== "chat" && !sideBySide && html`<${SummaryBar} s=${s} say=${say} onFull=${() => setMode("chat")} />`}
    ${mode === "page" && shown.length > 0
      ? (() => {
          const pane = html`<${PagePane} s=${s} list=${shown} cur=${pg} at=${at} pick=${openPage} split=${sideBySide} setSplit=${wideNow ? setSplit : null} say=${say}
            onClose=${() => leavePage(paneFor(s))} />`;
          return sideBySide
            ? html`<${PageSplit}><${Transcript} s=${s} say=${say} resume=${() => resume("chat")} busy=${busy} voice=${voice && canAttach} onVoiceOff=${() => setVoice(false)} />${pane}<//>`
            : pane;
        })()
    : mode === "term" && hasTerm
      ? canAttach
        ? html`<${Term} key=${s.id} s=${s} say=${say} voice=${voice} onVoiceOff=${() => setVoice(false)} />`
        : html`<div class="stage"><div class="cover">${Unattachable(s, () => resume(), busy, setMode)}</div></div>`
      : mode === "out" ? html`<${Outputs} s=${s} data=${outs} pages=${shown} open=${openPage} />` : html`<${Transcript} s=${s} say=${say} resume=${() => resume("chat")} busy=${busy} voice=${voice && canAttach} onVoiceOff=${() => setVoice(false)} />`}
    </div>
    ${panes?.state && !phoneNow && html`<aside class="statep" aria-label="State">${statePane}</aside>`}
    </div>
    ${stateSheet && html`<${Sheet} cls="statesheet" title="State" onClose=${() => setStateSheet(false)}>${statePane}<//>`}
    ${showUse && html`<${SessionUsage} s=${s} use=${use} onClose=${() => setShowUse(false)} />`}
  `;
}

const PAGE_SPLIT = "atc.pages.split", CHAT_W = "atc.pages.chatw";
function PageSplit({ children }) {
  const [w, setW] = useState(() => stored(CHAT_W, 400));
  const box = useRef();
  const drag = (e) => {
    e.preventDefault();
    const left = box.current.getBoundingClientRect().left, max = box.current.clientWidth * 0.6;
    const move = (ev) => setW(Math.round(Math.max(300, Math.min(max, ev.clientX - left))));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); box.current?.classList.remove("dragging"); setW((v) => (store(CHAT_W, v), v)); };
    box.current.classList.add("dragging");
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const [chat, pane] = children;
  return html`<div class="pgsplit" ref=${box} style=${`--chat: ${w}px`}><div class="pgchat">${chat}</div><div class="pggrip" onPointerDown=${drag} title="Drag to resize"></div>${pane}</div>`;
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

function Menu({ busy, items, render, label = "•••", cls = "icon", aria = "More actions", width = 190, left, up, sheetCls = "" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(), sheet = useRef();
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const r = el.getBoundingClientRect(), shift = r.left < 8 ? 8 - r.left : r.right > innerWidth - 8 ? innerWidth - 8 - r.right : 0;
    if (shift) el.style.transform = `translateX(${shift}px)`;
  }, [open]);
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
        <div ref=${sheet} class="sheet ${sheetCls}" style="position: absolute; ${left ? "left" : "right"}: 0; ${up ? "bottom" : "top"}: calc(100% + 6px); ${typeof width !== "number" ? `width: ${width}` : render ? `width: min(${width}px, calc(100vw - 16px))` : `width: max-content; min-width: min(${width}px, calc(100vw - 16px)); max-width: calc(100vw - 16px)`}; padding: 8px; display: flex; flex-direction: column; gap: 6px; z-index: 10">
          ${render ? render(() => setOpen(false)) : items.map((it) => {
            const b = html`<button class="btn ${it.danger ? "danger" : ""} ${it.cls || ""}" title=${it.title} disabled=${busy} onClick=${() => { setOpen(false); it.run(); }}>${it.label}</button>`;
            return it.side ? html`<div class="mrow">${b}${it.side}</div>` : b;
          })}
        </div>`}
    </div>
  `;
}

const TERM_COLORS = ["background", "foreground", "cursor", "cursorAccent", "selectionBackground",
  ...["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((c) => [c, `bright${c[0].toUpperCase()}${c.slice(1)}`])];
const TERM_THEMES = {};
const termTheme = () => {
  const key = `${CLAUDE_THEME} ${LOOK.theme}`;
  if (!TERM_THEMES[key]) {
    const v = cssColors(CLAUDE_THEME, TERM_COLORS.map((c) => `ansi-${c}`));
    TERM_THEMES[key] = Object.fromEntries(TERM_COLORS.map((c, i) => [c, v[i]]));
  }
  return TERM_THEMES[key];
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
  if (s?.attachable && s.kind !== "hub" && s.id && !DOCK.has(s.id)) dock(s);
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
    fontFamily: '"Recursive Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono", "Noto Sans Symbols 2", "Noto Sans Symbols", monospace',
    fontSize: touch ? 12.5 : 14,
    lineHeight: 1.1,
    theme: termTheme(),
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
  d.send = (data) => ws?.readyState === 1 && (ws.send(enc.encode(data)), true);
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
  const upload = useRef();
  upload.current = async (files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f, f.name || "pasted.png");
      try {
        const res = await fetch(`/api/sessions/${s.sessionId}/upload`, { method: "POST", body: fd });
        if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
        const { path } = await res.json();
        if (!api_.current.send?.(` \x1b[200~${/\s/.test(path) ? `"${path}"` : path}\x1b[201~`)) say(`Uploaded, but the terminal is not connected, so it did not get the path: ${path}`);
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
      paste: (files) => askAttach(files).then((ok) => (ok ? upload.current(files) : api_.current.focus?.())),
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
    <div class="stage ${dropping ? "dropping" : ""}" style=${`--term-bg: ${termTheme().background}`} ...${drop}>
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
      ${voice && !cover && html`<${VoiceBar} s=${s} say=${say} type=${(t) => { api_.current.send?.(t); setTimeout(() => api_.current.send?.("\r"), 150); }} press=${(k) => api_.current.send?.(k)} onClose=${onVoiceOff} />`}
      <div class="keys ${keyboard ? "show" : ""}" onPointerDown=${(e) => e.preventDefault()}>
        ${KEYS.map(([label, seq]) => html`<button class=${label === "ctrl" && ctrl ? "on" : ""} onClick=${() => key(label, seq)}>${label}</button>`)}
        <button onClick=${() => picker.current.click()}>file</button>
      </div>
    </div>
  `;
}

function askAttach(files) {
  const shown = files.map((f) => ({ name: f.name || "pasted.png", type: f.type, size: f.size, url: URL.createObjectURL(f) }));
  return ask({ title: `Attach ${files.length === 1 ? "this file" : `${files.length} files`} to the session?`, body: html`<${FileList} files=${shown} />`, ok: "Attach" })
    .finally(() => shown.forEach((f) => URL.revokeObjectURL(f.url)));
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
const VOICE_WORD = { starting: "starting", listening: "listening", hearing: "hearing you", thinking: "writing it down", holding: "keep talking", speaking: "speaking", muted: "mic off", error: "not available" };
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const transcribe = (wav) => fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });

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
  const who = s.kind === "hub" ? "the assistant" : s.harness || "Claude";
  const [phase, setPhase] = useState("starting");
  const [heard, setHeard] = useState(left.heard || "");
  const [spoken, setSpoken] = useState(left.spoken || "");
  const [muted, setMuted] = useState(() => pref(muteKey, "") === "on");
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
      const res = await transcribe(vad.utils.encodeWAV(audio));
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
    if (!live.current.muted) listen(true);
    setPhase("holding");
  };
  const dispatch = () => {
    clearTimeout(st.current.hold);
    const text = st.current.buf;
    st.current.buf = "";
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

  const toggleMute = () => {
    const m = !live.current.muted;
    setMuted(m);
    setPref(muteKey, m ? "on" : "");
    live.current.muted = m;
    if (m && st.current.speaking) stopSpeaking();
    listen(!m);
    setPhase(m ? "muted" : st.current.awaiting ? "waiting" : "listening");
  };
  const stopIt = () => { stopSpeaking(); rest(); };
  const pick = (v) => { setSource(v); setPref("atc.voicesrc", v); };
  const toggleBarge = () => { setBargeIn(!bargeIn); setPref("atc.bargein", bargeIn ? "off" : "on"); };
  useKeyLayer((e) => {
    if (typingIn(e.target)) return false;
    if (e.key === "m") return toggleMute(), true;
    if (e.key === "Escape") return onClose(), true;
    return false;
  });

  const word = muted ? "mic off" : phase === "waiting" ? `${who} is working` : VOICE_WORD[phase];
  const hint = muted ? "" : phase === "speaking" ? (bargeIn ? "Talk to cut in; it stops at once." : "Stop it, or say something when it ends.")
    : phase === "holding" ? "Keep talking, or send it now." : phase === "waiting" ? "It answers out loud when it is done."
    : phase === "listening" || phase === "hearing" ? (touch ? "A pause sends it." : "A pause sends it. Esc leaves voice mode.") : "";
  const cap = muted ? html`<span class="int">Muted. It hears nothing until you unmute.</span>`
    : phase === "speaking" && spoken ? spoken
    : heard ? html`${heard}${(phase === "holding" || phase === "hearing") && html` <span class="int">…</span>`}`
    : html`<span class="int">${phase === "error" ? "Voice is not available here." : `Say what you want ${who} to do.`}</span>`;
  const more = [
    { label: "Read the last reply again", run: replay },
    { label: "Read the reply before", run: earlier },
    VOICE.condense && { label: "Read it short", run: short },
    VOICE.tts && { label: source === "mine" ? "Use this device's voice" : "Use the server's voice", run: () => pick(source === "mine" ? "device" : "mine") },
    { label: bargeIn ? "Talking over a reply: on" : "Talking over a reply: off", run: toggleBarge },
  ].filter(Boolean);
  return html`
    <div class="voicebar" role="region" aria-label="Voice"><div class="cols"><div class="cx">
      ${top}
      <div class="vstrip ${muted ? "muted" : phase}" role="group" aria-label="Voice mode">
        <span class="vs"><b>Voice</b><span class="w">${word}</span>${!muted && (phase === "listening" || phase === "hearing") && html`<span class="lvl" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`}</span>
        <div class="vcap ${phase === "speaking" && !muted ? "said" : ""}" aria-live="polite">${cap}</div>
        ${hint && html`<div class="hint">${hint}</div>`}
        <span class="vb">
          ${phase === "speaking" && !muted && html`<button class="kb" onClick=${stopIt}>Stop it</button>`}
          ${phase === "holding" && html`<button class="kb" onClick=${dispatch}>Send now</button>`}
          ${phase === "waiting" && html`<button class="kb" onClick=${() => press("\x1b")} title=${`Send Esc to ${who} (or say stop)`}>Stop ${who}</button>`}
          <button class="kb" onClick=${toggleMute} aria-pressed=${muted} aria-keyshortcuts="m">${muted ? "Unmute" : "Mute"} <kbd aria-hidden="true">m</kbd></button>
          <${Menu} cls="kb" label="More" aria="More voice options" up width=${250} items=${more} />
          <button class="kb" onClick=${onClose} aria-keyshortcuts="Escape">Leave <kbd aria-hidden="true">esc</kbd></button>
        </span>
      </div>
    </div></div></div>
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
const resetDay = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const useSessionUsage = (s, every) => useUsage(`/api/sessions/${s.sessionId}/usage`, every);

function useUsage(path, every) {
  const [data, setData] = useState(null);
  useEffect(() => setData(null), [path]);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () => loadWindows().then((u) => {
      const q = [["week", winOf(u, "weekly_all")], ["fiveHour", winOf(u, "session")]].filter(([, w]) => w).map(([k, w]) => `${k}=${Math.floor(Date.parse(w.from) / 1000)}`);
      return api(`${path}${q.length ? `?${q.join("&")}` : ""}`);
    }).then((d) => live && setData({ ...d, wins: WINS }), () => live && setData((d) => d || { failed: true }));
    load();
    const t = setInterval(load, every);
    return () => { live = false; clearInterval(t); };
  }, [path, every]);
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

function Dialogs() {
  const [queue, setQueue] = useState([]);
  useEffect(() => {
    ASK = (d) => setQueue((q) => [...q, d]);
    return () => { ASK = null; };
  }, []);
  const d = queue[0];
  return d ? html`<${Dialog} key=${d.id} d=${d} onGone=${() => setQueue((q) => q.slice(1))} />` : null;
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea, select, a[href], [tabindex]:not([tabindex='-1'])";

function Dialog({ d, onGone }) {
  const { id, title, body, input, ok = "OK", busy: busyLabel, danger, run, done } = d;
  const [val, setVal] = useState(input?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef(), first = useRef(), ended = useRef(false), busyNow = useRef(false);
  busyNow.current = busy;
  const end = (r) => {
    if (ended.current) return;
    ended.current = true;
    const finish = () => { removeEventListener("popstate", finish); clearTimeout(t); onGone(); done(r); };
    let t;
    if (history.state?.atcDialog === id) {
      addEventListener("popstate", finish);
      t = setTimeout(finish, 400);
      history.back();
    } else finish();
  };
  const cancel = () => !busyNow.current && end(null);
  useEffect(() => {
    const from = document.activeElement;
    history.pushState({ ...history.state, atcDialog: id }, "");
    const back = () => { if (!ended.current && history.state?.atcDialog !== id) busyNow.current ? history.pushState({ ...history.state, atcDialog: id }, "") : end(null); };
    const key = (e) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      cancel();
    };
    addEventListener("popstate", back);
    addEventListener("keydown", key, true);
    requestAnimationFrame(() => {
      first.current?.focus({ preventScroll: true });
      input && first.current?.select();
    });
    return () => {
      removeEventListener("popstate", back);
      removeEventListener("keydown", key, true);
      if (from?.isConnected && !document.querySelector(".dlgveil")) from.focus?.({ preventScroll: true });
    };
  }, []);
  const trap = (e) => {
    if (e.key !== "Tab") return;
    const els = [...box.current.querySelectorAll(FOCUSABLE)];
    const i = els.indexOf(document.activeElement), n = els.length;
    if (!n) return;
    e.preventDefault();
    els[(i + (e.shiftKey ? -1 : 1) + n) % n].focus();
  };
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const v = input ? val.trim() : true;
    if (input && !v) return;
    if (!run) return end(v);
    setBusy(true);
    setErr("");
    try {
      await run(v);
      end(v);
    } catch (x) {
      setErr(x.message || String(x));
      setBusy(false);
    }
  };
  return html`
    <div class="veil dlgveil" onPointerDown=${(e) => e.target === e.currentTarget && cancel()}>
      <form class="sheet dlg" ref=${box} role="alertdialog" aria-modal="true" aria-labelledby=${`dlg${id}`} aria-describedby=${body ? `dlg${id}b` : undefined}
        aria-busy=${busy} onSubmit=${submit} onKeyDown=${trap}>
        <h3 id=${`dlg${id}`}>${title}</h3>
        ${body && html`<div class="dbody" id=${`dlg${id}b`}>${body}</div>`}
        ${input && html`<input class="dinput" ref=${first} value=${val} placeholder=${input.placeholder || ""} aria-label=${title} disabled=${busy}
          autocomplete="off" enterkeyhint="done" onInput=${(e) => { setVal(e.target.value); setErr(""); }} />`}
        ${err && html`<p class="err" role="alert">${err}</p>`}
        <div class="actions">
          <button type="button" class="btn" onClick=${cancel} disabled=${busy}>Cancel</button>
          <button class="btn ${danger ? "danger solid" : "primary"}" ref=${input ? undefined : first} disabled=${busy || (input && !val.trim())}>
            ${busy ? html`<span class="spin" aria-hidden="true"></span>${busyLabel || ok}` : ok}</button>
        </div>
      </form>
    </div>`;
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

const dayOf = (d, o) => new Date(d + "T12:00").toLocaleDateString([], o);

const RANGES = [["24h", "24h", "the last 24 hours", "hours=24"], ["7d", "7d", "the last 7 days", "days=7"], ["30d", "30d", "the last 30 days", "days=30"], ["90d", "90d", "the last 90 days", "days=90"], ["all", "All", "all time", "days=all"]];
const REPORTS = {};

function useReport(q) {
  const [rep, setRep] = useState(REPORTS[q] || null);
  useEffect(() => {
    let live = true;
    const load = () => api(`/api/usage/report?${q}`).then((r) => { REPORTS[q] = r; live && setRep(r); }, () => live && setRep((x) => (x && !x.failed ? x : { days: [], sessions: [], failed: true })));
    setRep(REPORTS[q] ? { ...REPORTS[q], loading: true } : null);
    load();
    const t = setInterval(load, 120000);
    return () => { live = false; clearInterval(t); };
  }, [q]);
  return rep;
}

const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const whenAt = (t) => new Date(t).toDateString() === new Date().toDateString() ? hhmm(t) : `${new Date(t).toLocaleDateString([], { weekday: "short" })} ${hhmm(t)}`;

function limitRow(w, x) {
  const from = Date.parse(x?.from), end = Date.parse(w.resetsAt), now = Date.now();
  const gone = from && end > from ? Math.min(1, Math.max(0, (now - from) / (end - from))) : null;
  const name = w.key === "session" ? "This 5-hour window" : w.label;
  const reset = w.key === "session" && from ? `${hhmm(from)} to ${hhmm(end)}` : `resets ${resetDay(end)}`;
  const r = { w, name, reset, used: Math.min(100, w.percent), pace: gone != null ? gone * 100 : null };
  if (gone == null || gone < 0.03 || w.percent < 1) {
    r.say = gone == null ? resetText(w.resetsAt) : w.percent < 1 ? "Nothing used yet." : "Too early in the window to tell a pace.";
    r.why = { used: `${Math.round(w.percent)}% of ${name.toLowerCase()} used.`, proj: r.say };
    return r;
  }
  const perHour = w.percent / ((now - from) / 3.6e6);
  r.proj = Math.min(100, w.percent / gone);
  r.hit = w.percent / gone >= 100 && w.percent < 100;
  const at100 = from + ((now - from) * 100) / w.percent;
  r.say = w.percent >= 100 ? html`<b>Used up.</b> ${resetText(w.resetsAt)}.`
    : r.hit ? html`Runs out <b>about ${whenAt(at100)}</b>, ${span((end - at100) / 1000)} before it resets.`
    : html`Lasts to the reset at this rate, about ${Math.round(r.proj)}% by ${resetDay(end)}.`;
  r.when = r.hit && whenAt(at100);
  r.left = r.hit && span((end - at100) / 1000);
  r.why = {
    used: `${Math.round(w.percent)}% of ${name.toLowerCase()}, since ${resetDay(from)}${x?.cost > 0 ? `; about ${usd(x.cost)} at API prices` : ""}. Anthropic reports whole percents.`,
    pace: `Even pace: ${Math.round(gone * 100)}% of the window has passed, so ${Math.round(gone * 100)}% used would last exactly to the reset.`,
    proj: `The average since the window opened is ${perHour.toFixed(1)}% an hour${r.hit ? `; the remaining ${Math.round(100 - w.percent)}% lasts until ${whenAt(at100)}` : `, about ${Math.round(r.proj)}% by the reset`}.`,
  };
  return r;
}

function X({ why, label, xp }) {
  return html`<button type="button" class="x" aria-expanded=${xp.at?.why === why} onPointerEnter=${(e) => matchMedia("(hover: hover)").matches && xp.show(e.currentTarget, why)}
    onPointerLeave=${() => matchMedia("(hover: hover)").matches && xp.hide()} onFocus=${(e) => xp.show(e.currentTarget, why)} onBlur=${xp.hide}
    onClick=${(e) => { e.stopPropagation(); xp.show(e.currentTarget, why, true); }}>${label}</button>`;
}

function useExplain() {
  const [at, setAt] = useState(null);
  useEffect(() => {
    if (!at?.pin) return;
    const f = () => setAt(null);
    addEventListener("pointerdown", f);
    return () => removeEventListener("pointerdown", f);
  }, [at]);
  const show = (el, why, pin) => { const r = el.getBoundingClientRect(); setAt({ why, pin, x: r.left, top: r.top, bottom: r.bottom }); };
  return { at, show, hide: () => setAt((a) => (a?.pin ? a : null)) };
}

function Explain({ at }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${at.bottom + el.offsetHeight + 12 > innerHeight ? at.top - el.offsetHeight - 6 : at.bottom + 6}px`;
  }, [at]);
  return at && html`<div class="xp" role="tooltip" ref=${ref}>${at.why}</div>`;
}

const USAGE_COLS = [["title", "Session", ""], ["bay", "Bay", "c-bay"], ["model", "Model", "c-m"], ["msgs", "Replies", "n c-st"], ["cost", "Cost", "n"], ["share", "Share", "c-sh"], ["last", "Last", "n"]];
const MODEL_ORDER = ["opus", "fable", "sonnet", "haiku"];
const modelFamily = (m) => MODEL_ORDER.find((f) => m.includes(f)) || "other";
const modelColor = (m) => `var(--um-${modelFamily(m)})`;
const modelRank = (m) => (MODEL_ORDER.indexOf(modelFamily(m)) + 5) % 5;
const KINDS = ["Input", "Output", "Cache reads", "Cache writes"];
const SHOWN_ROWS = 10;

const bucketDate = (k) => new Date(k.length > 10 ? `${k}:00` : `${k}T12:00`);
const bucketName = (k) => k.length > 10
  ? `${bucketDate(k).toLocaleDateString([], { weekday: "short" })} ${k.slice(11)}:00`
  : dayOf(k, { weekday: "short", day: "numeric", month: "short" });
const bucketTick = (k, n) => k.length > 10 ? `${k.slice(11)}` : n <= 7 ? dayOf(k, { weekday: "short" }) : dayOf(k, { day: "numeric", month: "short" });
const tickEvery = (hourly, n) => (hourly ? 6 : n <= 7 ? 1 : n <= 16 ? 2 : n <= 40 ? 7 : 14);

function PickRows({ rows, total, on, onPick, name = (r) => r.name, sub, color }) {
  const [all, setAll] = useState(false);
  const top = all ? rows : rows.slice(0, 8);
  return html`
    <div class="upicks">
      ${top.map((r) => html`<button class="upick" aria-pressed=${on === r.name} onClick=${() => onPick(on === r.name ? null : r.name)}>
        <span class="nm">${color && html`<i class="umsw" style=${`background:${color(r.name)}`}></i>`}${name(r)}${sub && html`<small>${sub(r)}</small>`}</span>
        <span class="v">${dollars(r.cost)}<small>${Math.round((r.cost / (total || 1)) * 100)}%</small></span>
        <i class="b" style=${`width:${total > 0 ? Math.max(0.5, (r.cost / total) * 100) : 0}%`}></i></button>`)}
      ${rows.length > 8 && html`<button class="clr" onClick=${() => setAll(!all)}>${all ? "Show fewer" : `Show all ${rows.length}`}</button>`}
    </div>`;
}

function SpendBars({ days, data, models, sel, hourly, onPick, onPickModel, partial }) {
  const [hover, setHover] = useState(null);
  const box = useRef();
  const n = days.length;
  const top = niceMax(Math.max(0, ...days.map((d) => data.buckets[d]?.cost || 0)));
  const every = tickEvery(hourly, n);
  const focusAt = days.includes(sel.bucket) ? days.indexOf(sel.bucket) : n - 1;
  const move = (e) => {
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const btns = [...box.current.querySelectorAll(".ucol")];
    btns[Math.min(n - 1, Math.max(0, btns.indexOf(document.activeElement) + dir))]?.focus();
  };
  const at = hover || sel.bucket;
  const b = at && data.buckets[at];
  return html`
    <div class="ubars" onKeyDown=${move} onPointerLeave=${() => setHover(null)}>
      <div class="uplot">
        <div class="uaxis"><span>${dollars(top)}</span><span>${dollars(top / 2)}</span><span></span></div>
        <div class=${`ucols ${sel.bucket ? "has" : ""}`} ref=${box} role="group" aria-label="Spend per ${hourly ? "hour" : "day"}. Pick one to see its sessions.">
          ${days.map((d, i) => {
            const x = data.buckets[d], parts = Object.entries(x?.models || {}).sort((p, q) => modelRank(p[0]) - modelRank(q[0]));
            return html`<button class="ucol ${sel.bucket === d ? "on" : ""} ${d === partial ? "now" : ""}" tabindex=${i === focusAt ? 0 : -1} aria-pressed=${sel.bucket === d}
              aria-label=${`${bucketName(d)}, ${dollars(x?.cost || 0)}`} onClick=${() => onPick(sel.bucket === d ? null : d)}
              onPointerEnter=${() => matchMedia("(hover: hover)").matches && setHover(d)} onFocus=${() => setHover(d)} onBlur=${() => setHover(null)}>
              <span class="st" style=${`height:${x ? Math.max(1, (x.cost / top) * 100) : 0}%`}>${parts.map(([m, c]) => html`<i style=${`flex-grow:${c};background:${modelColor(m)}`}></i>`)}</span></button>`;
          })}
        </div>
      </div>
      <div class="uticks" aria-hidden="true">${days.map((d, i) => html`<span>${(n - 1 - i) % every === 0 ? html`<em class=${d === partial ? "now" : ""}>${bucketTick(d, n)}</em>` : ""}</span>`)}</div>
      ${models.length > 1 && html`<div class="ulegend">${models.map((m) => html`<button aria-pressed=${sel.model === m.name} onClick=${() => onPickModel(sel.model === m.name ? null : m.name)}><i class="umsw" style=${`background:${modelColor(m.name)}`}></i>${modelName(m.name)}</button>`)}</div>`}
      <div class="ro" aria-live="polite">${at
        ? html`<span>${bucketName(at)}${at === partial ? ", so far" : ""}</span><b>${b ? dollars(b.cost) : "nothing"}</b>
            ${b && html`<span>${plural(b.sessions, "session")}</span><span class="wide">${Object.entries(b.models).filter(([, c]) => c >= 0.005).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([m, c]) => `${modelName(m)} ${dollars(c)}`).join(", ")}</span>`}`
        : html`<span>${touch ? "Tap" : "Pick"} a ${hourly ? "bar for that hour's" : "bar for that day's"} biggest sessions</span>`}</div>
    </div>`;
}

function HoursMap({ days, hourly, range, filtered }) {
  const [cell, setCell] = useState(null);
  useEffect(() => setCell(null), [range]);
  if (hourly || !days.length) return null;
  const byDay = days.length <= 7;
  const rows = byDay ? days.map((d) => ({ key: d.day, label: dayOf(d.day, { weekday: "short" }), long: dayOf(d.day, { weekday: "short", day: "numeric", month: "short" }), hours: d.hours || Array(24).fill(0) }))
    : [1, 2, 3, 4, 5, 6, 0].map((wd) => {
      const hours = Array(24).fill(0);
      for (const d of days) if (new Date(`${d.day}T12:00`).getDay() === wd) (d.hours || []).forEach((c, h) => (hours[h] += c));
      const label = new Date(2024, 0, 7 + wd).toLocaleDateString([], { weekday: "short" });
      return { key: `w${wd}`, label, long: `${label}s`, hours };
    });
  const hmax = Math.max(0.01, ...rows.flatMap((r) => r.hours));
  const nowH = new Date().getHours(), todayKey = new Date().toLocaleDateString("en-CA"), todayW = `w${new Date().getDay()}`;
  const isNow = (r) => r.key === todayKey || r.key === todayW;
  const fut = (r, h) => r.key === todayKey && h > nowH;
  const lvl = (c) => (c > 0 ? [0.14, 0.3, 0.5, 0.7, 0.9][Math.min(4, Math.floor((c / hmax) * 5))] : 0);
  const at = cell || [rows.findIndex(isNow), nowH];
  const atRow = rows[at[0]], atCost = atRow?.hours[at[1]];
  const moveCell = (e) => {
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    let [d, h] = at;
    if (e.key === "ArrowLeft") h = Math.max(0, h - 1);
    if (e.key === "ArrowRight") h = Math.min(23, h + 1);
    if (e.key === "ArrowUp") d = Math.max(0, d - 1);
    if (e.key === "ArrowDown") d = Math.min(rows.length - 1, d + 1);
    if (!fut(rows[d], h)) setCell([d, h]);
  };
  return html`
    <section class="sec"><div class="sh"><h2>Hours</h2><span class="n">cost per hour${byDay ? "" : ", by weekday"}${filtered ? ". Every bay and model, not just your selection" : ""}</span></div>
      <div class="hm" tabindex="0" role="grid" aria-label="Cost per hour. Arrow keys move; the line below reads the cell." onKeyDown=${moveCell}
        onPointerLeave=${() => matchMedia("(hover: hover)").matches && setCell(null)}>
        ${rows.map((r, di) => html`<span class="dl ${isNow(r) ? "today" : ""}">${r.label}</span>${r.hours.map((c, h) => html`
          <i class="${fut(r, h) ? "fut" : !c ? "z" : ""} ${at[0] === di && at[1] === h ? "on" : ""} ${r.key === todayKey && h === nowH ? "nowc" : ""}" style=${`--o:${lvl(c)}`}
            onPointerEnter=${() => !fut(r, h) && matchMedia("(hover: hover)").matches && setCell([di, h])} onClick=${() => !fut(r, h) && setCell([di, h])}></i>`)}`)}
      </div>
      <div class="hx"><span></span>${["0", "6", "12", "18"].map((t) => html`<span>${t}</span>`)}</div>
      ${atRow && html`<div class="ro" aria-live="polite"><span>${atRow.long}, ${String(at[1]).padStart(2, "0")}:00 to ${String((at[1] + 1) % 24).padStart(2, "0")}:00${atRow.key === todayKey && at[1] === nowH ? ", so far" : ""}</span>
        <b>${atCost > 0 ? usd(atCost) : "nothing"}</b>
        <span class="scale">less ${[0.14, 0.3, 0.5, 0.7, 0.9].map((o) => html`<i style=${`opacity:${o}`}></i>`)} more, max ${usd(hmax)} an hour</span></div>`}
    </section>`;
}

function UsagePage({ limits, live, down, onOpen }) {
  useNow(60000);
  const [u, setU] = useState(WINS);
  useEffect(() => { loadWindows(true).then(setU); }, []);
  const [v, setV] = useState(() => {
    const x = { sort: "cost", dir: -1, q: "", range: "7d", ...stored("atc.usage", {}) };
    return USAGE_COLS.some(([k]) => k === x.sort) ? x : { ...x, sort: "cost", dir: -1 };
  });
  const set = (p) => setV((x) => { const n = { ...x, ...p }; store("atc.usage", n); return n; });
  const [sel, setSel] = useState({});
  const [more, setMore] = useState(false);
  const pickSel = (p) => { setSel((x) => ({ ...x, ...p })); setMore(false); };
  const rangeDef = RANGES.find((r) => r[0] === v.range) || RANGES[1];
  const rep = useReport(rangeDef[3]);
  const xp = useExplain();
  const scroll = useRef(), sessionsRef = useRef();
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = stored("atc.usage.scroll", 0); }, [!!rep]);

  const ws = limits?.windows || [];
  const rows = ws.map((w) => limitRow(w, winOf(u, w.key)));
  const hit = rows.find((r) => r.hit);
  const isDown = (h) => down.some((p) => p.name === h);
  const status = !limits ? "Checking the limits…" : !ws.length ? `Limits are not available here${limits.error ? `: ${limits.error}` : ""}`
    : hit ? `${hit.name} runs out ${hit.when} at this rate, ${hit.left} before the reset` : "Every limit lasts to its reset at this rate";
  const src = limits && (limits.source === "live" ? `checked ${agoLong(limits.fetchedAt)}` : limits.source === "cached" ? `from Claude Code's last check, ${agoLong(limits.fetchedAt)}` : limits.source === "statusline" ? `from Claude Code's status line, ${agoLong(limits.fetchedAt)}` : "");

  const hourly = rangeDef[0] === "24h";
  const todayKey = new Date().toLocaleDateString("en-CA");
  const sessions = useMemo(() => (rep?.sessions || []).map((x) => ({ ...x, bay: project(x.cwd).name || "other" })), [rep]);
  const data = useMemo(() => cube(sessions, sel), [sessions, sel]);
  const liveBy = new Map(live.map((x) => [x.sessionId, x]));
  const shownDays = (rep?.days || []).filter((d) => !rep.first || d.day.slice(0, 10) >= rep.first);
  const dayKeys = shownDays.map((d) => d.day);
  const partial = hourly ? `${todayKey}T${String(new Date().getHours()).padStart(2, "0")}` : todayKey;
  const todayCost = rep?.days ? rep.days.filter((d) => d.day.startsWith(todayKey)).reduce((a, d) => a + d.cost, 0) : null;
  const week = u?.week;
  const trimmed = rep?.days && shownDays.length < rep.days.length;
  const span = rep?.first && rangeDef[0] !== "24h" && rangeDef[0] !== "7d" && (trimmed || rangeDef[0] === "all");

  const chips = [
    sel.bucket && ["bucket", bucketName(sel.bucket)],
    sel.bay && ["bay", sel.bay],
    sel.model && ["model", modelName(sel.model)],
    sel.host && ["host", sel.host],
  ].filter(Boolean);
  const filtered = chips.length > 0;

  const unit = hourly ? "hour" : "day";
  const active = Object.values(data.buckets).filter((b) => b.cost > 0);
  const perUnit = active.length ? active.reduce((a, b) => a + b.cost, 0) / active.length : 0;
  const busiest = Object.entries(data.buckets).sort((a, b) => b[1].cost - a[1].cost)[0];
  const sinceFrom = rep?.days?.[0] && bucketDate(rep.days[0].day).getTime();
  const prevStart = sinceFrom && new Date(sinceFrom - (Date.now() - sinceFrom)).toLocaleDateString("en-CA");
  const delta = !filtered && rep?.previous > 0 && rep.first && prevStart >= rep.first ? (data.total - rep.previous) / rep.previous : null;
  const top5 = data.rows.slice(0, 5).reduce((a, r) => a + r.cost, 0);
  const kpis = [
    { l: filtered ? "In this selection" : "Spent", v: dollars(data.total),
      s: filtered ? `${pct(data.range > 0 ? (data.total / data.range) * 100 : 0)} of ${dollars(data.range)}`
        : delta != null ? `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}% from the ${rangeDef[2].replace("the last", "previous")} (${dollars(rep.previous)})`
        : rangeDef[2], big: true },
    sel.bucket
      ? { l: `Against the average ${unit}`, v: perUnit > 0 ? `${(data.total / perUnit).toFixed(1)}×` : "0", s: `average ${dollars(perUnit)} a ${unit}` }
      : { l: `Per active ${unit}`, v: dollars(perUnit), s: busiest && busiest[1].cost > 0 ? `busiest ${bucketName(busiest[0])}, ${dollars(busiest[1].cost)}` : "" },
    { l: "Sessions", v: data.rows.length.toLocaleString("en-US"), s: data.rows.length > 5 ? `the top 5 took ${Math.round((top5 / (data.total || 1)) * 100)}%` : data.rows.length ? `${dollars(data.total / data.rows.length)} each` : "" },
    { l: "Replies", v: data.msgs.toLocaleString("en-US"), s: data.msgs ? `${dollars(data.total / data.msgs)} each` : "" },
    { l: "Tokens", v: tokens(data.tokens), s: data.tokens ? `${dollars(data.total / (data.tokens / 1e6))} a million` : "" },
  ];

  const key = (r, k) => k === "title" ? (r.title || "").toLowerCase() : k === "last" ? -Date.parse(r.last || 0) : k === "share" ? r.cost : k === "bay" || k === "model" ? r[k] || "" : r[k];
  const ql = v.q.trim().toLowerCase();
  const matched = data.rows.filter((r) => !ql || `${r.title} ${r.bay}`.toLowerCase().includes(ql))
    .sort((a, b) => { const A = key(a, v.sort), B = key(b, v.sort); return (A > B ? 1 : A < B ? -1 : 0) * v.dir; });
  const shown = more ? matched : matched.slice(0, SHOWN_ROWS);
  const sortBy = (k) => set({ sort: k, dir: v.sort === k ? -v.dir : ["title", "bay", "model", "last"].includes(k) ? 1 : -1 });
  const sumShown = (k) => matched.reduce((a, r) => a + (r[k] || 0), 0);
  const maxRow = Math.max(0.01, ...matched.map((r) => r.cost));
  const pickThenShow = (p) => { pickSel(p); if (innerWidth < 900) requestAnimationFrame(() => sessionsRef.current?.scrollIntoView({ block: "start" })); };
  const pickBucket = (d) => { pickSel({ bucket: d }); if (d && innerWidth < 900) requestAnimationFrame(() => sessionsRef.current?.scrollIntoView({ block: "nearest" })); };
  const sliceName = chips.length ? chips.map((c) => c[1]).join(", ") : rangeDef[2];
  const empty = rep && !rep.failed && !sessions.length;
  return html`
    <section class="scrpane usage" aria-label="Usage">
      <header class="hd">
        <div class="l1"><h1>Usage</h1><span class="where">Claude Code${MULTI ? " on every host" : ""}${limits?.plan ? `, ${limits.plan} plan` : ""}</span></div>
        <div class="l2 no-block"><span class="stat">${status}</span>
          ${todayCost != null && html`<span class="rd"><span class="l">today</span>${dollars(todayCost)}</span>`}
          ${week && html`<span class="rd"><span class="l">week</span>${dollars(week.cost)}</span>`}
          ${src && html`<span class="rd"><span class="l">limits</span>${src}</span>`}</div>
      </header>
      <div class="scroll" ref=${scroll} onScroll=${(e) => store("atc.usage.scroll", e.currentTarget.scrollTop)}>
        <div class="ubody">
          <section class="sec" aria-labelledby="u-lim">
            <div class="sh"><h2 id="u-lim">Limits</h2><span class="n">${ws.length ? `Claude Code${MULTI ? ", every host" : ""}. ${touch ? "Tap" : "Point at"} a number for how it is worked out.` : ""}</span></div>
            ${!ws.length && html`<p class="none">${limits ? `Limits are not available here${limits.error ? `: ${limits.error}` : "."}` : "Checking…"}</p>`}
            ${rows.map((r) => html`
              <div class="lim ${r.hit ? "hit" : ""}">
                <div class="nm"><b>${r.name}</b><span>${r.reset}</span></div>
                <div class="gauge" role="img" aria-label=${`${Math.round(r.used)}% used${r.pace != null ? `; even pace ${Math.round(r.pace)}%` : ""}${r.proj != null ? `; ${r.hit ? "projected to run out" : `about ${Math.round(r.proj)}% at the reset`}` : ""}`}>
                  <span class="tr"></span><span class="used" style=${`width:${r.used}%`}></span>
                  ${r.proj > r.used && html`<span class="prj" style=${`left:${r.used}%;width:${r.proj - r.used}%`}></span>`}
                  <span class="ticks"></span>
                  ${r.pace != null && html`<span class="pace" style=${`left:calc(${r.pace}% - 1px)`} data-l=${`pace ${Math.round(r.pace)}%`}></span>`}
                </div>
                <div class="pct"><${X} xp=${xp} why=${r.why.used} label=${html`${Math.round(r.w.percent)}<small>%</small>`} /></div>
                <div class="say"><${X} xp=${xp} why=${r.why.proj} label=${r.say} /></div>
              </div>`)}
            ${rows.length > 0 && html`<div class="legend"><span><i class="u"></i>used</span><span><i class="p"></i>at this rate, by the reset</span><span><i class="t"></i>even pace: where you would be if it lasted exactly</span></div>`}
          </section>
          <div class="uspend ${rep?.loading ? "loading" : ""}">
            <div class="ubar">
              <div class="sh"><h2>Spend</h2><span class="n">API prices; a plan is not billed per token</span>
                <span class="r"><span class="seg" role="group" aria-label="Range">${RANGES.map((r) => html`<button aria-pressed=${r[0] === rangeDef[0]} aria-label=${r[2]} onClick=${() => { set({ range: r[0] }); pickSel({ bucket: null }); }}>${r[1]}</button>`)}</span></span></div>
              ${chips.length > 0 && html`<div class="uchips">
                ${chips.map(([k, l]) => html`<button class="uchip" aria-label=${`Remove ${l}`} onClick=${() => pickSel({ [k]: null })}>${l}<span aria-hidden="true">×</span></button>`)}
                ${chips.length > 1 && html`<button class="clr" onClick=${() => setSel({})}>Clear all</button>`}</div>`}
            </div>
            ${span && html`<p class="ufloor">Transcripts go back to ${dayOf(rep.first, { day: "numeric", month: "short" })}. Claude Code deletes older ones, so there is nothing further to add up.</p>`}
            ${!rep ? html`<p class="none">Adding up the transcripts…</p>` : rep.failed ? html`<p class="none">Couldn't add up the transcripts.</p>`
            : empty && rangeDef[0] === "all" ? html`
              <div class="uempty"><h2>No usage yet</h2><p>atc reads usage from Claude Code once a session has run. Spend per day, bay, model and session fill in from the first session on.</p>
                <button class="btn primary" onClick=${() => NEW_SESSION()}>New session</button></div>`
            : empty ? html`<p class="none">Nothing ran in ${rangeDef[2]}.</p>`
            : html`
            <div class="ukpis">${kpis.map((k) => html`<div class="ukpi ${k.big ? "big" : ""}"><span class="l">${k.l}</span><b>${k.v}</b><span class="s">${k.s}</span></div>`)}</div>
            <${SpendBars} days=${dayKeys} data=${data} models=${data.models} sel=${sel} hourly=${hourly} partial=${partial} onPick=${pickBucket} onPickModel=${(m) => pickSel({ model: m })} />
            <div class="ugrid">
              <section class="sec usess" ref=${sessionsRef}><div class="sh"><h2>Biggest sessions</h2><span class="n">${sliceName}</span>
                <span class="r tools"><input class="filt" type="search" placeholder="Filter sessions" aria-label="Filter sessions" value=${v.q} onInput=${(e) => set({ q: e.target.value })} /></span></div>
                <table><thead><tr>${USAGE_COLS.map(([k, n, c]) => html`<th class=${c} aria-sort=${v.sort === k ? (v.dir > 0 ? "ascending" : "descending") : "none"}><button class="sort" onClick=${() => sortBy(k)}>${n}</button></th>`)}</tr></thead>
                  <tbody>${shown.map((r) => { const ls = liveBy.get(r.sessionId); return html`<tr>
                    <td class="t"><span class="uses">${ls ? html`<${StateBlock} s=${ls} />` : html`<span class="sb earlier" role="img" aria-label="earlier">E</span>`}
                      <a href=${`#/s/${r.sessionId}`} onClick=${(e) => { e.preventDefault(); onOpen(r); }}>${r.title || r.sessionId.slice(0, 8)}</a><span class="bay2">${r.bay}${r.model ? `, ${modelName(r.model)}` : ""}</span></span></td>
                    <td class="c-bay">${r.bay}</td><td class="m c-m">${r.model ? modelName(r.model) : ""}</td><td class="n c-st">${r.msgs.toLocaleString("en-US")}</td>
                    <td class="n">${dollars(r.cost)}</td>
                    <td class="c-sh"><span class="wb" style=${`width:${Math.round((r.cost / maxRow) * 70)}%`}></span><span class="dim">${Math.round((r.cost / (data.total || 1)) * 100)}%</span></td>
                    <td class="n m">${isDown(r.host) ? html`<span class="stale" title=${`${r.host} is unreachable; this is what it used until then`}>${ago({ updated: r.last })}</span>` : ago({ updated: r.last })}</td></tr>`; })}
                    ${!shown.length && html`<tr><td colspan="7" class="none">No session matches${ql ? ` “${v.q}”` : ""}. <button class="clr" onClick=${() => { setSel({}); set({ q: "" }); }}>Clear the filter</button></td></tr>`}</tbody>
                  <tfoot><tr><td>${plural(matched.length, "session")}</td><td class="c-bay"></td><td class="c-m"></td><td class="n c-st">${sumShown("msgs").toLocaleString("en-US")}</td><td class="n">${dollars(sumShown("cost"))}</td><td class="c-sh"></td><td></td></tr></tfoot></table>
                ${matched.length > SHOWN_ROWS && html`<button class="btn umore" onClick=${() => setMore(!more)}>${more ? "Show fewer" : `Show all ${matched.length}`}</button>`}
              </section>
              <div class="ubreak">
                <section class="sec"><div class="sh"><h2>Per bay</h2></div>
                  <${PickRows} rows=${data.bays} total=${data.bays.reduce((a, b) => a + b.cost, 0)} on=${sel.bay} onPick=${(b) => pickThenShow({ bay: b })} sub=${(r) => plural(r.sessions, "session")} /></section>
                <section class="sec"><div class="sh"><h2>Per model</h2></div>
                  <${PickRows} rows=${data.models} total=${data.models.reduce((a, b) => a + b.cost, 0)} on=${sel.model} onPick=${(m) => pickThenShow({ model: m })} name=${(r) => modelName(r.name)} color=${modelColor} /></section>
                ${data.hosts.length > 1 || sel.host ? html`<section class="sec"><div class="sh"><h2>Per host</h2></div>
                  <${PickRows} rows=${data.hosts} total=${data.hosts.reduce((a, b) => a + b.cost, 0)} on=${sel.host} onPick=${(h) => pickThenShow({ host: h })} sub=${(r) => plural(r.sessions, "session")} /></section>` : ""}
                <section class="sec"><div class="sh"><h2>What it paid for</h2></div>
                  <div class="upicks">${KINDS.map((k, i) => [k, data.kinds[i]]).sort((a, b) => b[1] - a[1]).map(([k, c]) => html`<div class="upick flat">
                    <span class="nm">${k}</span><span class="v">${dollars(c)}<small>${Math.round((c / (data.total || 1)) * 100)}%</small></span>
                    <i class="b" style=${`width:${data.total > 0 ? Math.max(0.5, (c / data.total) * 100) : 0}%`}></i></div>`)}</div></section>
              </div>
            </div>
            <${HoursMap} days=${shownDays} hourly=${hourly} range=${rangeDef[0]} filtered=${filtered} />`}
          </div>
          <p class="unote">${ESTIMATE()} ${RATE}</p>
        </div>
      </div>
      <${Explain} at=${xp.at} />
    </section>`;
}

function SessionUsage({ s, use, onClose, agent }) {
  const sub = use?.subagents;
  const convs = use?.conversations || [];
  const what = agent ? "agent" : "session";
  const day = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
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
      ${!use ? html`<p class="note">Reading the transcript${agent ? "s" : ""}…</p>` : use.failed ? html`<p class="note">Couldn't read this ${what}'s usage.</p>` : html`
        <div class="tiles">
          ${sh.map((x) => html`<div>
            <span class="n">${x.p != null ? approx(x.p) : `${usd(x.cost)}`}</span>
            <span class="l">of this ${x.name}${x.p != null ? ` · ${usd(x.cost)}` : ""}</span>
            <span class="l faint">${x.name === "week" ? `at ${Math.round(x.w.percent)}%, resets ${resetDay(x.w.resetsAt)}` : `at ${Math.round(x.w.percent)}%, resets in ${span((Date.parse(x.w.resetsAt) - Date.now()) / 1000)}`}</span>
          </div>`)}
          <div>
            <span class="n">${usd(use.cost)}</span>
            <span class="l">${agent ? `all ${convs.length} conversation${convs.length === 1 ? "" : "s"}` : "whole session"}${asPct(use.cost, week) != null ? `, ${approx(asPct(use.cost, week))} of a week` : ""}</span>
            <span class="l faint">${tokens(use.total)} tokens</span>
          </div>
          <div>
            <span class="n">${span(use.activeSeconds)}</span>
            <span class="l">${s.harness || "Claude"} working</span>
            ${use.activeSeconds > 60 && use.cost > 0 && html`<span class="l faint">${usd(use.cost / (use.activeSeconds / 3600))} per working hour</span>`}
          </div>
        </div>
        ${use.local?.length > 0 && html`<p class="quiet">${use.local.join(", ")} is not Claude: its part costs nothing and doesn't count toward your plan.</p>`}
        ${convs.length > 1 && html`
          <h4>Conversations</h4>
          <${ShareRows} w=${week} total=${Math.max(...convs.map((c) => c.cost))} onPick=${(r) => { onClose(); go(r.id); }}
            rows=${convs.map((c) => ({ id: c.sessionId, label: c.title || "Untitled", cost: c.cost,
              sub: [c.start && (c.end && day(c.end) !== day(c.start) ? `${day(c.start)} to ${day(c.end)}` : day(c.start)), `${c.turns} turns`, `${tokens(c.total)} tokens`].filter(Boolean).join(" · ") }))} />`}
        ${kinds && use.cost > 0 && html`
          <h4>Where the cost goes</h4>
          <${ShareRows} w=${week} total=${Math.max(...kinds.map((k) => k.cost))} rows=${kinds} />`}
        ${use.models?.length > 0 && html`
          <h4>Models</h4>
          <${ShareRows} w=${week} total=${use.models[0].cost}
            rows=${use.models.map((m) => ({ label: modelName(m.model), sub: `${tokens(m.total)} tokens · ${m.messages} replies`, cost: m.cost }))} />`}
        <h4>Activity</h4>
        <dl class="facts">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        ${!agent && s.agent && AGENT_INFO[s.agent] && html`<button class="btn" onClick=${() => { onClose(); AGENT_SHEET(s.agent, "usage"); }}>All of ${agentLabel(AGENT_INFO[s.agent])}'s conversations</button>`}
        <p class="note">The share of a limit counts this ${what}'s spend since that window opened. ${RATE} ${ESTIMATE(use.pricesAsOf)}${use.unpriced?.length ? ` No price known for ${use.unpriced.join(", ")}, so it counts as $0.` : ""} Working time adds up the gaps between messages in each turn, at most 10 minutes per gap.</p>`}
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
const KIND_LABEL = { browser: "Browser", table: "Table", image: "Image", html: "Page", markdown: "Notes", pdf: "PDF", video: "Video", audio: "Audio", text: "File" };
const baseName = (p) => p.split("/").pop();
const dirName = (p) => tilde(p.slice(0, p.lastIndexOf("/")) || "/");

function Outputs({ s, data, pages = [], open: openPage }) {
  const [open, setOpen] = useState(null);
  if (!data) return html`<div class="outputs"><p class="empty">Looking through this session…</p></div>`;
  const made = data.files.filter((f) => f.kind !== "text");
  const code = data.files.filter((f) => f.kind === "text");
  const viewable = [...made, ...code];
  const nothing = !pages.length && !data.servers.length && !data.links.length && !data.files.length;
  return html`
    <div class="outputs">
      <div class="inner">
        ${nothing && html`<div class="none">
          <p>${data.failed ? "Couldn't read this session's outputs." : "Nothing here yet."}</p>
          <p class="sub">Pages it shows you, files it writes and servers it starts show up here as it works.</p>
        </div>`}
        ${pages.length > 0 && html`
          <section>
            <h4>Pages it showed you</h4>
            <div class="cards">${pages.map((p) => html`<${PageCard} key=${pkey(p)} p=${p} onOpen=${() => openPage(p.name)} />`)}</div>
          </section>`}
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
  return html`
    <div class="viewer" role="dialog" aria-label=${baseName(f.path)}>
      <header>
        <button class="icon" onClick=${onClose} aria-label="Close">✕</button>
        <div class="who"><div class="n">${baseName(f.path)}</div><div class="d">${dirName(f.path)}</div></div>
        <button class="icon" disabled=${at === 0} onClick=${() => setAt(at - 1)} aria-label="Previous">‹</button>
        <button class="icon" disabled=${at === list.length - 1} onClick=${() => setAt(at + 1)} aria-label="Next">›</button>
        <button class="btn" onClick=${() => openOut(f.url)}>${APP ? "Open outside" : "New tab"}</button>
      </header>
      <${FileBody} f=${f} />
    </div>`;
}

function FileBody({ f, frame }) {
  const [text, setText] = useState(null);
  const textual = f.kind === "markdown" || f.kind === "text" || f.kind === "table";
  useEffect(() => {
    if (!textual) return;
    if (f.size > 2 << 20) return setText({ big: true });
    let live = true;
    fetch(f.url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status === 410 ? "This link expired. Close and reopen." : r.statusText))))
      .then((t) => live && setText({ t }), (e) => live && setText({ err: e.message }));
    return () => { live = false; };
  }, [f.url]);
  const pdfInline = f.kind === "pdf" && !APP;
  return html`
    <div class="fbody ${f.kind}">
      ${f.kind === "image" ? html`<img src=${f.url} alt=${baseName(f.path)} />`
        : f.kind === "html" ? frame || html`<iframe src=${f.url} sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>`
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
    </div>`;
}

const PSEEN_KEY = "atc.pages.seen";
let PSEEN = null;
const pkey = (p) => `${p.session}/${p.name}`;
const pageAt = (p) => Math.max(Date.parse(p.updated || 0) || 0, Date.parse(p.shown || 0) || 0);
const pseen = () => {
  if (PSEEN) return PSEEN;
  PSEEN = stored(PSEEN_KEY, {});
  if (!PSEEN[""]) { PSEEN[""] = Date.now() - 86400000; store(PSEEN_KEY, PSEEN); }
  return PSEEN;
};
const pageStatus = (p) => {
  if (p.gone) return "";
  const m = pseen(), seen = m[pkey(p)];
  return seen ? (pageAt(p) > seen ? "updated" : "") : pageAt(p) > m[""] ? "unseen" : "";
};
const pageFresh = (p) => !!pageStatus(p);
const pageTitle = (p) => p.title || p.name;
const pageSrc = (p) => p.url && `${p.url}?v=${pageAt(p)}`;
const pageInfo = (p) => p.gone ? "file is gone" : `${KIND_LABEL[p.kind] || "Page"} · updated ${agoLong(p.updated || p.shown)}`;
const pageLink = (sid, name) => `#/s/${sid}/p/${encodeURIComponent(name)}`;
const aloneLink = (sid, name) => `#/p/${sid}/${encodeURIComponent(name)}`;
const linkSlug = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const unstamped = (t) => linkSlug(t).replace(/-\d\d-\d\d-\d\d-\d\d$/, "");
const ownerRef = (p, s) => (p.session.startsWith("@") ? p.session : linkSlug(s?.title || p.of) || p.session);
const idRef = (r) => r.startsWith("@") || /^[0-9a-f]{8}(-[0-9a-f-]*)?$/.test(r);
const splitRef = (r) => { const i = (r || "").indexOf("#"); return i < 0 ? [r, null] : [r.slice(0, i), r.slice(i + 1)]; };
const pageRef = (p) => (p.at ? `${p.name}#${p.at}` : p.name);
let AT_SEQ = 0;
const atOf = (ref) => { const [name, id] = splitRef(ref); return id ? { name, id, seq: ++AT_SEQ } : null; };
const atcRoute = (href) => { const u = new URL(href, location.href); return u.origin === location.origin && u.pathname === "/" && u.hash ? u.hash : null; };
const routePage = () => { const m = location.hash.match(/^#\/s\/[^/]+\/p\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; };
let LAST_KEY = 0;
addEventListener("keydown", () => { LAST_KEY = Date.now(); }, true);

function markPage(p) {
  const m = pseen();
  if (!p || p.gone || (m[pkey(p)] || 0) >= pageAt(p)) return;
  m[pkey(p)] = pageAt(p);
  store(PSEEN_KEY, m);
  dispatchEvent(new Event("atc-pseen"));
}

function useSeenTick() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    addEventListener("atc-pseen", f);
    return () => removeEventListener("atc-pseen", f);
  }, []);
}

function usePages(s) {
  const past = s.state === "past";
  const [got, setGot] = useState(null);
  useEffect(() => {
    if (!past) return;
    let live = true;
    const load = () => api(`/api/sessions/${s.sessionId}/pages`).then((l) => live && setGot(l || []), () => {});
    load();
    const t = setInterval(load, 10000);
    return () => { live = false; clearInterval(t); };
  }, [s.sessionId, past]);
  const list = past ? got || [] : s.shown || [];
  const b = browserPage(s);
  return b ? [...list, b] : list;
}

const askTakeDown = (p) => ask({ title: `Take down “${pageTitle(p)}”?`, body: "It leaves atc's pages. The file stays where it is.",
  ok: "Take down", busy: "Taking down…", danger: true, run: () => api(`/api/sessions/${p.session}/pages/${encodeURIComponent(p.name)}${p.host ? `?host=${p.host}` : ""}`, { method: "DELETE" }) });
async function takeDown(p, say) {
  try {
    await api(`/api/sessions/${p.session}/pages/${encodeURIComponent(p.name)}${p.host ? `?host=${p.host}` : ""}`, { method: "DELETE" });
    say?.(`Took down “${pageTitle(p)}”.`);
    return true;
  } catch (e) { say?.(e.message); return false; }
}

function PageFrame({ p, at, onSend, say, changes }) {
  const src = pageSrc(p);
  const [cur, setCur] = useState(src);
  const [next, setNext] = useState(null);
  const frames = useRef({});
  const scroll = useRef(0);
  useEffect(() => { if (src !== cur) setNext(src); }, [src]);
  useEffect(() => {
    const base = `/api/sessions/${p.session}/pages/${encodeURIComponent(p.name)}`, q = hostQ(p.host, HERE);
    const ops = {
      "state.get": () => api(`${base}/state${q}`),
      "state.set": (v) => api(`${base}/state${q}`, { method: "PUT", body: v }).then(() => null),
      run: (a) => api(`${base}/run${q}`, { method: "POST", body: a }),
      copy: (t) => { copyText(t); say(t.length < 60 ? `Copied “${t}”.` : "Copied."); },
      copyImage: (u) => (APP?.copyImage ? APP.copyImage(u) : copyImage(u).then(() => say("Image copied."))),
      open: (u) => { const h = atcRoute(u); h ? (location.hash = h) : openOut(u); },
      send: (t) => onSend(t),
      key: (k) => { document.body.dispatchEvent(new KeyboardEvent("keydown", { ...k, bubbles: true, cancelable: true })); },
    };
    const f = (e) => {
      const m = e.data;
      if (!m || m.atc !== 1 || !Object.values(frames.current).some((w) => w && w.contentWindow === e.source)) return;
      if (m.op === "hello") {
        e.source.postMessage({ atc: 1, op: "changes", on: !!changesRef.current }, "*");
        return e.source.postMessage({ atc: 1, op: "scroll", y: scroll.current }, "*");
      }
      if (m.op === "at") { scroll.current = m.arg; return; }
      const op = ops[m.op];
      Promise.resolve().then(() => (op ? op(m.arg) : Promise.reject(new Error(`atc has no ${m.op}`))))
        .then((value) => e.source.postMessage({ atc: 1, id: m.id, value: value ?? null }, "*"),
          (err) => e.source.postMessage({ atc: 1, id: m.id, error: err.message || String(err) }, "*"));
    };
    addEventListener("message", f);
    return () => removeEventListener("message", f);
  }, [p.session, p.name, p.host, onSend]);
  const changesRef = useRef(changes);
  useEffect(() => {
    changesRef.current = changes;
    for (const w of Object.values(frames.current)) w?.contentWindow?.postMessage({ atc: 1, op: "changes", on: !!changes }, "*");
  }, [changes]);
  const jump = useRef(null);
  useEffect(() => {
    if (!at) return;
    const id = (jump.current = encodeURIComponent(at.id));
    for (const [u, el] of Object.entries(frames.current)) if (el) el.src = `${u}#${id}`;
    const t = setTimeout(() => jump.current === id && (jump.current = null), 3000);
    return () => clearTimeout(t);
  }, [at?.seq]);
  useEffect(() => {
    if (p.stateAt) for (const w of Object.values(frames.current)) w?.contentWindow?.postMessage({ atc: 1, op: "state" }, "*");
  }, [p.stateAt]);
  const frame = (u, hidden) => html`<iframe key=${u} ref=${(el) => { frames.current[u] = el; }} src=${hidden && jump.current ? `${u}#${jump.current}` : u} class=${hidden ? "next" : ""}
    sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
    onLoad=${hidden ? () => { delete frames.current[cur]; setCur(u); setNext(null); } : null}></iframe>`;
  return html`<div class="pframe">${frame(cur, false)}${next && frame(next, true)}</div>`;
}

function PageBody({ p, at, onSend, say, changes }) {
  if (p.kind === "browser") return html`<${BrowserView} p=${p} say=${say} />`;
  if (p.gone) return html`<div class="fbody"><div class="none"><p>The file behind this page is gone.</p><p class="sub">${tilde(p.path)}</p></div></div>`;
  return html`<${FileBody} f=${{ ...p, url: pageSrc(p) }} frame=${p.kind === "html" && html`<${PageFrame} key=${pkey(p)} p=${p} at=${at} onSend=${onSend} say=${say} changes=${changes} />`} />`;
}

const BROWSER_KEYS = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

function browserPage(s) {
  const tabs = s.tabs || [];
  if (!tabs.length) return null;
  const at = tabs.reduce((m, t) => (t.opened > m ? t.opened : m), "");
  return { session: s.sessionId, name: "browser", title: tabs.length > 1 ? `Browser · ${tabs.length} tabs` : "Browser", kind: "browser", path: "", shown: at, updated: at, tabs };
}

function useTab(sid, tab, stage) {
  const [frame, setFrame] = useState(null);
  const [info, setInfo] = useState(null);
  const [gone, setGone] = useState(false);
  const sock = useRef(null);
  const calls = useRef({ n: 0, wait: {} });
  useEffect(() => {
    if (!tab) return;
    let live = true, ws, retry;
    setFrame(null); setInfo(null); setGone(false);
    const open = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/sessions/${sid}/tabs/${tab}/view`);
      sock.current = ws;
      ws.onopen = start;
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === "frame") setFrame(m);
        else if (m.t === "info") setInfo({ title: m.title, url: m.url });
        else if (m.t === "gone") { live = false; setGone(true); }
        else if (m.t === "r") { const f = calls.current.wait[m.id]; delete calls.current.wait[m.id]; f && f(m); }
      };
      ws.onclose = () => { if (live) retry = setTimeout(open, 1000); };
    };
    const start = () => {
      const box = stage.current?.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      const cw = Math.round(box?.width || 800), ch = Math.round(box?.height || 600);
      if (PHONE.matches) send("Emulation.setDeviceMetricsOverride", { width: cw, height: ch, deviceScaleFactor: dpr, mobile: true });
      send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: Math.min(1600, cw * dpr), maxHeight: Math.min(1600, ch * dpr), everyNthFrame: 1 });
    };
    let resized;
    const ro = new ResizeObserver(() => { clearTimeout(resized); resized = setTimeout(() => sock.current?.readyState === 1 && start(), 300); });
    stage.current && ro.observe(stage.current);
    open();
    return () => { live = false; clearTimeout(retry); clearTimeout(resized); ro.disconnect(); ws && ws.close(); sock.current = null; };
  }, [sid, tab]);
  const send = useCallback((m, p) => new Promise((done) => {
    const ws = sock.current;
    if (!ws || ws.readyState !== 1) return done({ e: "not connected" });
    const id = ++calls.current.n;
    calls.current.wait[id] = done;
    ws.send(JSON.stringify({ id, m, p }));
  }), []);
  return { frame, info, gone, send };
}

function BrowserView({ p, say }) {
  const tabs = p.tabs || [];
  const [cur, setCur] = useState(null);
  const tab = tabs.find((t) => t.id === cur) || tabs.reduce((a, t) => (!a || t.opened > a.opened ? t : a), null);
  const known = useRef(null);
  useEffect(() => {
    const ids = tabs.map((t) => t.id), fresh = known.current && ids.find((id) => !known.current.includes(id));
    known.current = ids;
    fresh && setCur(fresh);
  }, [tabs.map((t) => t.id).join()]);
  const stage = useRef(), img = useRef(), keys = useRef(), drag = useRef(null);
  const { frame, info, gone, send } = useTab(p.session, tab?.id, stage);
  const url = info?.url ?? tab?.url ?? "";
  const [typed, setTyped] = useState(null);
  const at = (e) => {
    const r = img.current.getBoundingClientRect(), meta = frame.meta;
    return { x: ((e.clientX - r.left) * meta.deviceWidth) / r.width, y: ((e.clientY - r.top) * meta.deviceHeight) / r.height };
  };
  const mouse = (type, e, extra = {}) => frame && send("Input.dispatchMouseEvent", { type, ...at(e), modifiers: mods(e), ...extra });
  const down = (e) => {
    if (!frame) return;
    if (e.pointerType === "touch") { drag.current = { x: e.clientX, y: e.clientY, moved: false }; return; }
    keys.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    const button = ["left", "middle", "right"][e.button] || "left";
    mouse("mouseMoved", e);
    mouse("mousePressed", e, { button, buttons: e.buttons, clickCount: e.detail || 1 });
  };
  const move = (e) => {
    const d = drag.current;
    if (e.pointerType === "touch") {
      if (!d) return;
      const dx = d.x - e.clientX, dy = d.y - e.clientY;
      if (!d.moved && Math.hypot(dx, dy) < 8) return;
      d.moved = true; d.x = e.clientX; d.y = e.clientY;
      const k = frame.meta.deviceWidth / img.current.getBoundingClientRect().width;
      return mouse("mouseWheel", e, { deltaX: dx * k, deltaY: dy * k });
    }
    if (e.buttons || (e.timeStamp - (move.last || 0) > 60)) { move.last = e.timeStamp; mouse("mouseMoved", e, { buttons: e.buttons, button: e.buttons ? "left" : "none" }); }
  };
  const up = (e) => {
    if (e.pointerType === "touch") {
      const d = drag.current;
      drag.current = null;
      if (d && !d.moved) { mouse("mouseMoved", e); mouse("mousePressed", e, { button: "left", buttons: 1, clickCount: 1 }); mouse("mouseReleased", e, { button: "left", clickCount: 1 }); }
      return;
    }
    mouse("mouseReleased", e, { button: ["left", "middle", "right"][e.button] || "left", clickCount: e.detail || 1 });
  };
  const wheel = (e) => { e.preventDefault(); mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY }); };
  const key = (e) => {
    const code = BROWSER_KEYS[e.key];
    const combo = (e.ctrlKey || e.metaKey) && e.key.length === 1;
    if (!code && !combo) return;
    e.preventDefault();
    const base = { key: e.key, code: e.code, windowsVirtualKeyCode: code || e.key.toUpperCase().charCodeAt(0), modifiers: mods(e) };
    send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(e.key === "Enter" ? { text: "\r" } : {}) });
    send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const text = (e) => { const t = e.target.value; e.target.value = ""; t && send("Input.insertText", { text: t }); };
  const nav = async (step) => {
    const r = await send("Page.getNavigationHistory");
    const h = r.r, entry = h && h.entries[h.currentIndex + step];
    entry && send("Page.navigateToHistoryEntry", { entryId: entry.id });
  };
  const go = (e) => {
    e.preventDefault();
    let u = (typed ?? url).trim();
    if (!u) return;
    if (!/^[a-z]+:/i.test(u)) u = (/^[^\s]+\.[^\s]+$/.test(u) ? "https://" : "https://www.google.com/search?q=") + (u.includes(".") ? u : encodeURIComponent(u));
    setTyped(null);
    send("Page.navigate", { url: u }).then((r) => r.e && say(r.e));
  };
  if (!tab) return html`<div class="fbody"><div class="none"><p>This session has no tabs open.</p></div></div>`;
  return html`
    <div class="bview">
      ${tabs.length > 1 && html`<div class="btabs" role="tablist">${tabs.map((t) => html`<button role="tab" aria-selected=${t === tab} class="ptab ${t === tab ? "on" : ""}" title=${t.url} onClick=${() => setCur(t.id)}><span>${t.title || t.url || "New tab"}</span></button>`)}</div>`}
      <form class="bbar" onSubmit=${go}>
        <button type="button" class="icon" title="Back" aria-label="Back" onClick=${() => nav(-1)}>←</button>
        <button type="button" class="icon wide" title="Forward" aria-label="Forward" onClick=${() => nav(1)}>→</button>
        <button type="button" class="icon" title="Reload" aria-label="Reload" onClick=${() => send("Page.reload")}>⟳</button>
        <input class="burl" value=${typed ?? url} onInput=${(e) => setTyped(e.target.value)} onFocus=${(e) => e.target.select()} onBlur=${() => setTyped(null)} spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-label="Address" />
        <button type="button" class="icon" title="Type into the page" aria-label="Keyboard" onClick=${() => keys.current?.focus()}>⌨</button>
      </form>
      <div class="bstage" ref=${stage}>
        ${frame
          ? html`<img ref=${img} src=${`data:image/jpeg;base64,${frame.data}`} alt=${info?.title || tab.title} draggable="false"
              onMouseDown=${(e) => e.preventDefault()} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${() => (drag.current = null)} onWheel=${wheel} onContextMenu=${(e) => e.preventDefault()} />`
          : html`<p class="sub">${gone ? "This tab is closed." : "Connecting to the tab…"}</p>`}
        <textarea ref=${keys} class="bkeys" aria-label="Type into the page" autocapitalize="off" autocomplete="off" spellcheck="false" onKeyDown=${key} onInput=${text}></textarea>
      </div>
    </div>`;
}

async function sendNote(s, p, note, say) {
  const text = `On the page “${pageTitle(p)}”:\n${note}`;
  try {
    await deliver(s, text);
  } catch (e) { say(e.message); throw e; }
  say(`Sent to ${s.title || "the session"}.`);
  return true;
}

async function deliver(s, text) {
  if (s.agent && !s.attachable) await api(`/api/agents/${encodeURIComponent(s.agent)}/message`, { method: "POST", body: { text, user: true } });
  else {
    let id = s.id || s.sessionId;
    if (!s.attachable) id = (await api(`/api/sessions/${s.sessionId}/resume`, { method: "POST" })).id;
    await api(`/api/sessions/${id}/send`, { method: "POST", body: { text } });
  }
}

function PagePane({ s, list, cur, at, pick, split, setSplit, onClose, say, alone }) {
  useNow(15000);
  useSeenTick();
  const p = list.find((x) => x.name === cur) || list[0];
  const [nonce, setNonce] = useState(0);
  const tabs = useRef(null);
  useEffect(() => {
    const box = tabs.current, on = box?.querySelector(".pgtab.on");
    if (!on) return;
    const l = on.offsetLeft - box.offsetLeft, r = l + on.offsetWidth;
    if (l < box.scrollLeft) box.scrollLeft = l;
    else if (r > box.scrollLeft + box.clientWidth) box.scrollLeft = r - box.clientWidth;
  }, [p && pkey(p)]);
  const onSend = useMemo(() => p && ((t) => sendNote(s, p, t, say)), [p && pkey(p), p?.title, s.id, s.sessionId, s.attachable]);
  useEffect(() => {
    const f = () => p && document.visibilityState === "visible" && markPage(p);
    f();
    addEventListener("visibilitychange", f);
    return () => removeEventListener("visibilitychange", f);
  }, [p && pkey(p), p && pageAt(p)]);
  if (!p) return html`<div class="ppane"><div class="fbody"><p class="empty">No pages.</p></div></div>`;
  const full = () => APP ? (location.hash = aloneLink(ownerRef(p, s), p.name)) : openOut(`/${aloneLink(ownerRef(p, s), p.name)}`);
  const bay = bayOf(s) || (s.cwd && project(s.cwd).name) || null;
  return html`
    <div class="ppane">
      <div class="pbar">
        ${list.length > 1
          ? html`<div class="pgtabs" role="tablist" ref=${tabs}>
              ${list.map((x) => html`<button role="tab" aria-selected=${x === p} class="pgtab ${x === p ? "on" : ""} ${x.gone ? "gone" : ""}" title=${`${pageTitle(x)}\n${pageInfo(x)}`} onClick=${() => pick(x.name)}>
                ${x !== p && pageFresh(x) && html`<i class="pgdot"></i>`}<span>${pageTitle(x)}</span></button>`)}
            </div>`
          : html`<span class="pgone"><span class="kind">${(KIND_LABEL[p.kind] || "Page").toLowerCase()}</span><b title=${pageTitle(p)}>${pageTitle(p)}</b></span>`}
        <span class="pupd" title=${tilde(p.path)}>${p.gone ? "gone" : clockAt(pageAt(p))}</span>
        ${setSplit && html`<button class="kb" onClick=${() => setSplit(!split)}>${split ? "Page only" : "Side by side"}</button>`}
        ${p.kind !== "browser" && html`<button class="kb" onClick=${() => (location.hash = pagesHash(bay, p.session, p.name))} title="This page in the Pages view">In Pages</button>
        <${Menu} cls="kb" label="More" aria="Page actions" items=${[
          { label: "Reload", run: () => setNonce((n) => n + 1) },
          !alone && { label: "Open full page", run: full },
          { label: "Open the file in a new tab", run: () => openOut(p.url) },
          { label: "Copy link", run: () => copyPageLink(p, say, s) },
          !APP && { label: "On phone", run: () => pageToPhone(p, say) },
          { label: "Take down", danger: true, run: () => askTakeDown(p).then((ok) => ok && say(`Took down “${pageTitle(p)}”.`)) },
        ].filter(Boolean)} />`}
        ${onClose && html`<button class="kb" onClick=${onClose}>Close</button>`}
      </div>
      ${p.note && html`<div class="pnote">${p.note}</div>`}
      <${PageBody} key=${`${pkey(p)}:${nonce}`} p=${p} at=${at?.name === p.name ? at : null} onSend=${onSend} say=${say} />
    </div>`;
}

function PagesButton({ list, open, on }) {
  useSeenTick();
  const top = list[0], fresh = list.some(pageFresh);
  const face = html`<span class="t">${list.length === 1 ? pageTitle(top) : plural(list.length, "page")}</span>${fresh && html`<i class="pgdot" aria-label="new"></i>`} <kbd aria-hidden="true">p</kbd>`;
  if (list.length === 1) return html`<button class="kb pgbtn ${on ? "on" : ""}" aria-pressed=${on} aria-keyshortcuts="]" title=${`${pageTitle(top)}\n${pageInfo(top)}`} onClick=${() => open(top.name)}>${face}</button>`;
  return html`<${Menu} cls=${`kb pgbtn ${on ? "on" : ""}`} aria="Pages" width="min(320px, calc(100vw - 24px))" label=${face}
    items=${list.map((p) => ({ cls: "pgitem", title: tilde(p.path), run: () => open(p.name),
      label: html`<i class="pgdot ${pageFresh(p) ? "" : "off"}"></i><span class="tx"><b>${pageTitle(p)}</b><small>${pageInfo(p)}</small></span>` }))} />`;
}

function PageThumb({ p }) {
  const u = pageSrc(p);
  return p.gone ? html`<span class="ext">gone</span>`
    : p.kind === "html" ? html`<iframe src=${u} sandbox="allow-scripts" loading="lazy" tabindex="-1" aria-hidden="true"></iframe>`
    : p.kind === "image" ? html`<${Pic} src=${u} fallback=${html`<span class="ext">img</span>`} />`
    : p.kind === "markdown" || p.kind === "table" ? html`<${FilePeek} f=${{ ...p, url: u }} ext=${p.kind} />`
    : html`<span class="ext">${(p.path.split(".").pop() || "").slice(0, 4)}</span>`;
}

function PageCard({ p, onOpen, sub, onDown }) {
  return html`
    <div class="card pcard ${p.kind}">
      <button class="pv" onClick=${onOpen} title=${tilde(p.path)}><${PageThumb} p=${p} /></button>
      <button class="cap" onClick=${onOpen}>
        <span class="n">${pageFresh(p) && html`<i class="dot"></i>`}${pageTitle(p)}</span>
        <span class="m">${sub ? html`${sub} · ` : ""}${pageInfo(p)}</span>
      </button>
      ${onDown && html`<button class="icon down" title="Take down" aria-label="Take down" onClick=${onDown}>✕</button>`}
    </div>`;
}

const ownerOf = (p, live) => live.find((x) => x.sessionId === p.session) || (p.session.startsWith("@") && live.find((x) => x.agent === p.session.slice(1) && x.kind !== "hub")) || null;
const ownerStub = (p) => ({ sessionId: p.session, title: p.of || "", state: "past", agent: p.session.startsWith("@") ? p.session.slice(1) : undefined });
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const clockAt = (t) => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? hm(t) : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm(t)}`; };
const pageDay = (t) => { const n = new Date(); n.setHours(0, 0, 0, 0); return t >= +n ? "Today" : t >= n - 86400000 ? "Yesterday" : "Earlier"; };
const focusComposer = (n = 0) => { const t = document.querySelector(".composer textarea"); t ? t.focus() : n < 30 && setTimeout(() => focusComposer(n + 1), 100); };
const pageToPhone = (p, say) => api("/api/pages/phone", { method: "POST", body: { session: p.session, name: p.name, title: pageTitle(p) } }).then(() => say("Sent to your phone."), (e) => say(e.message));
const copyPageLink = (p, say, s) => { copyText(`${location.origin}/${aloneLink(ownerRef(p, s), p.name)}`); say("Link copied."); };

function usePageList(live, say) {
  const [list, setList] = useState(null);
  const load = useCallback(() => api("/api/pages").then((l) => setList(l || []), (e) => { say(e.message); setList((x) => x || []); }), []);
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 10000);
    return () => clearInterval(t);
  }, []);
  if (!list) return [null, load];
  const by = new Map(list.map((p) => [pkey(p), p]));
  for (const s of live) for (const q of s.shown || []) by.set(pkey(q), { ...by.get(pkey(q)), ...q, cwd: by.get(pkey(q))?.cwd || s.cwd, of: s.title });
  return [[...by.values()], load];
}

function PagesView({ at, live, bays, say, index }) {
  useSeenTick();
  useNow(30000);
  const phone = usePhone();
  const [list, load] = usePageList(live, say);
  useEffect(() => {
    if (BAY.only !== at.bay) BAY.set(at.bay);
    if (at.bay) rememberBay(at.bay, { view: "pages" });
  }, [at.bay]);
  const rows = (list || []).map((p) => {
    const s = ownerOf(p, live);
    return { p, s, bay: s ? bayOf(s) : p.cwd ? project(p.cwd).name : null };
  }).sort((a, b) => pageAt(b.p) - pageAt(a.p));
  const scoped = at.bay ? rows.filter((x) => x.bay === at.bay) : rows;
  const names = bays.map((b) => b.name);
  const groups = at.bay
    ? ["Today", "Yesterday", "Earlier"].map((d) => ({ name: d, rows: scoped.filter((x) => pageDay(pageAt(x.p)) === d) }))
    : [...names, ...new Set(rows.map((x) => x.bay).filter((b) => b && !names.includes(b))), null].map((b) => ({ name: b || "No bay", bay: true, rows: scoped.filter((x) => x.bay === b) }));
  const shown = groups.filter((g) => g.rows.length);
  const order = shown.flatMap((g) => g.rows);
  const cur = at.sid ? rows.find((x) => x.p.session === at.sid && x.p.name === at.name) : phone ? null : scoped[0];
  const ck = cur && pkey(cur.p);
  const opened = useRef({});
  if (cur && opened.current.key !== ck) opened.current = { key: ck, st: pageStatus(cur.p), seen: pseen()[ck], changes: true };
  const op = cur ? opened.current : {};
  const [, redraw] = useState(0);
  const [jump, setJump] = useState(at.at);
  useEffect(() => setJump(at.at), [at.at]);
  const lastAt = useRef(null);
  useEffect(() => {
    if (!cur) return;
    const was = lastAt.current;
    lastAt.current = { ck, at: pageAt(cur.p) };
    if (was?.ck === ck && was.at !== pageAt(cur.p) && cur.p.at) setJump(atOf(pageRef(cur.p)));
    const f = () => document.visibilityState === "visible" && markPage(cur.p);
    f();
    addEventListener("visibilitychange", f);
    return () => removeEventListener("visibilitychange", f);
  }, [ck, cur && pageAt(cur.p)]);
  const pick = (x) => { const h = pagesHash(at.bay, x.p.session, x.p.name); phone ? (location.hash = h) : location.replace(h); };
  const back = () => location.replace(pagesHash(at.bay));
  const p = cur?.p, s = cur?.s;
  const onSend = useMemo(() => p && ((t) => sendNote(s || ownerStub(p), p, t, say)), [ck, s?.id, s?.attachable]);
  const act = {
    changes: () => { op.changes = !op.changes; redraw((n) => n + 1); },
    beside: () => { if (!s) return say("Its session is not running."); AUTO_SPLIT = true; location.hash = pageLink(keyOf(s), p.name); },
    note: () => { if (!s) return say("Its session is not running."); AUTO_PANE = "chat"; go(keyOf(s)); focusComposer(); },
    phone: () => pageToPhone(p, say),
    copy: () => copyPageLink(p, say, s),
    down: () => askTakeDown(p).then((ok) => {
      if (!ok) return;
      say(`Took down “${pageTitle(p)}”.`);
      load();
      const i = order.indexOf(cur), next = order[i + 1] || order[i - 1];
      phone || !next ? back() : pick(next);
    }),
  };
  const keys = useRef();
  keys.current = { order, cur, pick, act, back, phone, op };
  useEffect(() => {
    const k = (e) => {
      const t = e.target, r = keys.current;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector(".veil, .palone, .keys-ov, .sheet")) return;
      const step = { j: 1, k: -1 }[e.key];
      if (step) { const n = r.order[Math.max(0, Math.min(r.order.length - 1, r.order.indexOf(r.cur) + step))]; n && n !== r.cur && r.pick(n); }
      else if (!r.cur) return;
      else if (QWERTY.includes(e.key) && !e.shiftKey) { const n = r.order[QWERTY.indexOf(e.key)]; if (n) r.pick(n); }
      else if (e.key === "\\") r.act.beside();
      else if (e.key === "Enter" && !t.closest("button, a, [role=button]")) r.act.note();
      else if (e.key === "d" && r.op.st === "updated") r.act.changes();
      else if (e.key === "Escape" && r.phone) r.back();
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  useEffect(() => { if (!phone && ck) document.querySelector(`.pgi[data-pk="${CSS.escape(ck)}"]`)?.scrollIntoView({ block: "nearest" }); }, [ck]);
  const counts = (l) => {
    const n = l.filter((x) => pageStatus(x.p) === "unseen").length, u = l.filter((x) => pageStatus(x.p) === "updated").length;
    return [n && `${n} new`, u && `${u} updated`].filter(Boolean).join(", ");
  };
  const scopeLink = () => { location.hash = pagesHash(at.bay ? null : PAGES_FROM || names[0] || null); PAGES_FROM = at.bay || PAGES_FROM; };
  const row = (x) => {
    const st = pageStatus(x.p), on = cur === x && !phone;
    return html`<button class="pgi ${st} ${on ? "sel" : ""}" data-pk=${pkey(x.p)} aria-current=${on ? "page" : null} onClick=${() => pick(x)}>
      <span class="t">${st === "unseen" && html`<span class="sr">Unseen: </span>`}${pageTitle(x.p)}</span>
      <span class="ag">${st === "updated" && html`<span class="upd">updated</span>`}${ago({ updated: x.p.updated || x.p.shown })}</span>
      <span class="ss">${x.s ? html`<${StateBlock} s=${x.s} mini />` : html`<span class="sb mini earlier" aria-hidden="true">E</span>`}<span>${x.s?.title || x.p.of || "Earlier session"}</span></span>
      ${x.p.note && html`<span class="ld">${x.p.note}</span>`}
    </button>`;
  };
  const empty = html`<div class="pgnone">
    <h2>${list ? `No pages in ${at.bay || "any bay"} yet.` : "Loading pages…"}</h2>
    ${list && html`<p>Agents show pages with <code>atc show</code>: a report, a dashboard, a handover. They land here and beside the session that made them.</p>
    ${at.bay && html`<button class="kb" onClick=${scopeLink}>Pages in every bay <kbd aria-hidden="true">alt 0</kbd></button>`}`}
  </div>`;
  const kb = (label, key, run, extra = {}) => html`<button class="kb ${extra.on ? "on" : ""} ${extra.cls || ""}" aria-pressed=${extra.on === undefined ? null : extra.on}
    aria-keyshortcuts=${key || null} title=${extra.title || ""} onClick=${run}>${label}${key && html` <kbd aria-hidden="true">${key}</kbd>`}</button>`;
  const upd = op.st === "updated";
  const header = p && html`
    <header class="hd pghd">
      <div class="l1">
        <button class="kb back" onClick=${back} aria-label="Back to the pages">Back</button>
        ${s ? html`<${StateBlock} s=${s} />` : html`<span class="sb earlier" role="img" aria-label="ended">E</span>`}
        <h1 title=${pageTitle(p)}>${pageTitle(p)}</h1>
        <span class="where">${(KIND_LABEL[p.kind] || "Page").toLowerCase()}  ${p.name}</span>
        <span class="r">
          ${upd && html`${kb("Changes", "d", act.changes, { on: op.changes, title: "Mark what changed since you saw it" })}<span class="div"></span>`}
          ${kb("Beside its session", "\\", act.beside, { title: s ? "The page beside its conversation" : "Its session is not running", cls: s ? "" : "off" })}
          ${!APP && kb("On phone", null, act.phone, { title: "Push this page to your phone" })}
          ${kb("Copy link", null, act.copy)}
          ${kb("Note", "enter", act.note, { title: s ? "Write to its session about this page" : "Its session is not running", cls: s ? "" : "off" })}
          <span class="div"></span>
          ${kb("Take down", null, act.down, { cls: "danger" })}
          <div class="more"><${Menu} cls="kb" aria="Page actions" label="Actions" items=${[
            upd && { label: op.changes ? "Hide what changed" : "Show what changed", run: act.changes },
            s && { label: "Note to its session", run: act.note },
            s && { label: "Open its session", run: () => go(keyOf(s)) },
            { label: "Copy link", run: act.copy },
            { label: "Take down", danger: true, run: act.down },
          ].filter(Boolean)} /></div>
        </span>
      </div>
      <div class="l2">
        ${s ? html`<button class="sl" onClick=${() => go(keyOf(s))} title="Open the session">${s.title || "Untitled"}</button>` : html`<span class="sl off">${p.of || "Earlier session"}</span>`}
        ${cur.bay && cur.bay !== at.bay && html`<span>in ${cur.bay}</span>`}
        <span class="mono">${p.gone ? "file is gone" : upd && op.seen ? `updated ${hm(pageAt(p))}, seen ${hm(op.seen)}` : clockAt(pageAt(p))}</span>
        ${op.st === "unseen" && html`<span class="new">new</span>`}
      </div>
    </header>`;
  const missing = at.sid && !cur && html`<div class="pgnone"><h2>${list ? "This page was taken down." : "Loading…"}</h2>
    ${list && html`<button class="kb" onClick=${back}>Every page in ${at.bay || "every bay"}</button>`}</div>`;
  const quiet = names.filter((b) => !rows.some((x) => x.bay === b));
  return html`
    <div class="pgv ${index || phone ? "" : "noindex"} ${phone && at.sid ? "full" : ""}">
      <aside class="pgidx" aria-label="Pages index">
        <div class="ph"><b>${at.bay || "All bays"}</b><span>${list ? [plural(scoped.length, "page"), counts(scoped)].filter(Boolean).join(", ") : "Loading…"}</span>
          <span class="r"><button class="kb ${at.bay ? "" : "on"}" aria-pressed=${!at.bay} onClick=${scopeLink}>All bays</button></span></div>
        <div class="pgscroll">
          ${shown.map((g) => html`<section>
            <h2 class="grp"><b>${g.name}</b><span class="c">${g.rows.length}</span>${g.bay && counts(g.rows) && html`<span class="r">${counts(g.rows)}</span>`}</h2>
            ${g.rows.map(row)}
          </section>`)}
          ${!at.bay && list && quiet.length > 0 && html`<p class="none">${quiet.join(", ")}: no pages</p>`}
          ${!order.length && (phone ? empty : html`<p class="none">${list ? "Nothing here yet." : "Loading…"}</p>`)}
        </div>
      </aside>
      <section class="pgread" aria-label="Page">
        ${cur ? html`${header}<div class="pgbody2"><${PageBody} key=${ck} p=${p} at=${jump?.name === p.name ? jump : null} onSend=${onSend} say=${say} changes=${upd && op.changes} /></div>`
          : missing || empty}
      </section>
    </div>`;
}

const BACKLOG = "#/backlog";
const itemQ = (it) => hostQ(it.host, HERE);
const itemRun = (it, live) => it.session && live.find((s) => (it.sid && s.sessionId === it.sid) || s.id === it.session);
const suggested = (it) => !!it.by && !it.accepted;
const itemTitle = (it) => it.title || (it.prompt || "").split("\n")[0];
const itemStage = (it) => it.status === "done" ? "done" : suggested(it) ? "suggested" : it.status === "ready" && it.session && !it.aside ? "started" : it.status;
const putAside = (s, say) => api(`/api/sessions/${s.sessionId}/aside${hostQ(s.host, HERE)}`, { method: "POST", body: { title: s.title } }).then(() => {
  loadBacklog();
  say(s.attachable && s.state !== "working" ? "On the backlog, and stopped. Resume it from there." : "On the backlog. It stops when its turn ends; resume it from there.");
}, (e) => say(e.message));
const STAGES = [
  ["started", "Started"],
  ["ready", "Ready"],
  ["blocked", "Blocked"],
  ["suggested", "Suggested by agents"],
  ["done", "Done"],
];
const baseDir = (d) => (d || "").replace(/\/\.claude\/worktrees\/[^/]+$/, "");
const here = (sel, live) => {
  if (sel?.cwd) return { dir: baseDir(sel.cwd), host: sel.host };
  const s = BAY.only && live?.find((x) => x.cwd && project(x.cwd).name === BAY.only);
  if (!s) return true;
  const { rest } = project(s.cwd), dir = baseDir(s.cwd);
  return { dir: rest ? dir.slice(0, -rest.length - 1) : dir, host: s.host };
};
let BL = null, blTimer = 0;
const blSubs = new Set();
const loadBacklog = (onErr) => api("/api/backlog").then((l) => { BL = l || []; blSubs.forEach((f) => f(BL)); },
  (e) => { if (!BL) { BL = []; blSubs.forEach((f) => f(BL)); } onErr?.(e); });
function useBacklog() {
  const [list, set] = useState(BL);
  useEffect(() => {
    blSubs.add(set);
    if (!BL) loadBacklog();
    blTimer ||= setInterval(() => document.visibilityState === "visible" && loadBacklog(), 20000);
    return () => { blSubs.delete(set); if (!blSubs.size) blTimer = clearInterval(blTimer) || 0; };
  }, []);
  return list;
}
const backlogCounts = (items, only) => {
  const n = {};
  for (const it of items || []) if (!only || project(it.dir).name === only) n[itemStage(it)] = (n[itemStage(it)] || 0) + 1;
  return STAGES.filter(([k]) => k !== "done" && n[k]).map(([k]) => `${n[k]} ${k}`).join(" · ");
};

function BacklogLine({ only }) {
  const counts = backlogCounts(useBacklog(), only);
  return html`<button class="blline" onClick=${() => (location.hash = BACKLOG)} title="Open the backlog"><span class="mi">${ICON.list}</span>Backlog${counts ? `: ${counts}` : ""}</button>`;
}

const BK_FILTERS = [
  ["open", "Open", (st) => st !== "done"],
  ["ready", "Ready", (st) => st === "ready"],
  ["started", "Started", (st) => st === "started"],
  ["blocked", "Blocked", (st) => st === "blocked"],
  ["suggested", "Suggested", (st) => st === "suggested"],
  ["done", "Done", (st) => st === "done"],
  ["all", "All", () => true],
];
const BK_ORDER = ["started", "ready", "blocked", "suggested", "done"];

function BacklogPage({ live, say, onAdd, only }) {
  useNow(30000);
  const list = useBacklog();
  const [scope, setScope] = useState(only ? "bay" : "all");
  const bay = scope === "bay" ? only : null;
  const [v, setV] = useState(() => ({ f: "open", sort: "stage", ...stored("atc.backlog", {}) }));
  const set = (p) => setV((x) => { const n = { ...x, ...p }; store("atc.backlog", n); return n; });
  const [sel, setSel] = useState(null);
  const [edit, setEdit] = useState(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const load = () => loadBacklog((e) => say(e.message));
  useEffect(() => { load(); }, []);
  const call = (it, method, body, sub = "") => api(`/api/backlog/${it.id}${sub}${itemQ(it)}`, { method, body });
  const all = list || [];
  const scoped = all.filter((it) => !bay || project(it.dir).name === bay);
  const n = (st) => scoped.filter((it) => itemStage(it) === st).length;
  const keep = BK_FILTERS.find((f) => f[0] === v.f) || BK_FILTERS[0];
  const shown = scoped.filter((it) => keep[2](itemStage(it))).sort((a, b) =>
    v.sort === "new" ? Date.parse(b.created) - Date.parse(a.created)
    : v.sort === "bay" ? project(a.dir).name.localeCompare(project(b.dir).name) || Date.parse(b.created) - Date.parse(a.created)
    : BK_ORDER.indexOf(itemStage(a)) - BK_ORDER.indexOf(itemStage(b)) || Date.parse(a.created) - Date.parse(b.created));
  const cur = shown.find((it) => it.id === sel) || shown[0];

  const patch = async (it, body, verb, back) => {
    try {
      await call(it, "PATCH", body);
      load();
      say(`${verb}: ${itemTitle(it)}`, back && { undo: () => call(it, "PATCH", back).then(load, (e) => say(e.message)) });
    } catch (e) { say(`Not ${verb.toLowerCase()}: ${e.message}`); }
  };
  const remove = async (it) => { try { await call(it, "DELETE"); load(); say(`Deleted: ${itemTitle(it)}`); } catch (e) { say(e.message); } };
  const start = async (it) => { try { go((await call(it, "POST", undefined, "/start")).id); say(it.aside ? "Resumed." : "Session started."); load(); } catch (e) { say(e.message); } };
  const run = (it) => itemRun(it, live);
  const primary = (it) => {
    const st = itemStage(it), r = run(it);
    if (st === "suggested") return patch(it, { accepted: true }, "Taken");
    if (st === "started") return r && r.state !== "stopped" ? go(keyOf(r)) : null;
    if (st === "done") return patch(it, { status: "ready" }, "Reopened", { status: "done" });
    return start(it);
  };
  const done = (it) => itemStage(it) !== "done" && patch(it, { status: "done" }, "Done", { status: it.status });
  const block = (it) => {
    const st = itemStage(it);
    if (st === "done" || st === "suggested") return;
    if (st === "blocked") return patch(it, { status: "ready" }, "Unblocked", { status: "blocked", why: it.why || "" });
    setEdit({ id: it.id, mode: "why", why: "", title: "", prompt: "" });
  };
  const known = [...all.map((it) => ({ dir: it.dir, host: it.host })), ...live.filter((s) => s.cwd).map((s) => ({ dir: baseDir(s.cwd), host: s.host }))];
  const where = bay && known.find((x) => project(x.dir).name === bay && !project(x.dir).rest);
  const addIt = async () => {
    const t = text.trim();
    if (!t) return;
    if (!where) return onAdd({ later: true, title: t, dir: undefined });
    setAdding(true);
    try {
      await api(`/api/backlog${hostQ(where.host, HERE)}`, { method: "POST", body: { dir: where.dir, title: t } });
      setText("");
      await load();
      set({ f: v.f === "done" ? "open" : v.f });
    } catch (e) { say(`Not added: ${e.message}`); }
    setAdding(false);
  };
  const keys = useRef();
  keys.current = { shown, cur, primary, done, block, edit };
  useEffect(() => {
    const k = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector(".nsveil, .pal, .veil, .keys-ov")) return;
      const { shown, cur, primary, done, block, edit } = keys.current, i = shown.indexOf(cur);
      const f = {
        j: () => shown[i + 1] && setSel(shown[i + 1].id), ArrowDown: () => shown[i + 1] && setSel(shown[i + 1].id),
        k: () => i > 0 && setSel(shown[i - 1].id), ArrowUp: () => i > 0 && setSel(shown[i - 1].id),
        Enter: () => cur && !edit && primary(cur), d: () => cur && done(cur), x: () => cur && block(cur),
        a: () => document.getElementById("bk-add")?.focus(),
      }[e.key];
      if (f) { e.preventDefault(); f(); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  useEffect(() => { document.querySelector(".bk-it.sel")?.scrollIntoView({ block: "nearest" }); }, [cur?.id]);

  const seg = (opts, key, label) => html`<span class="seg" role="group" aria-label=${label}>${opts.map(([k, name, f]) =>
    html`<button aria-pressed=${v[key] === k} onClick=${() => set({ [key]: k })}>${name}${f && key === "f" && html`<span class="c">${scoped.filter((it) => f(itemStage(it))).length}</span>`}</button>`)}</span>`;
  const counts = !list ? "Loading…" : BK_ORDER.filter((k) => k !== "done" && n(k)).map((k) => `${n(k)} ${k}`).join(", ") || (scoped.length ? "Nothing open" : "Empty");
  return html`
    <section class="scrpane backlogv" aria-label="Backlog">
      <header class="hd">
        <div class="l1"><h1>${bay ? "Backlog" : "Backlog, all bays"}</h1><span class="where">${bay ? `${bay}${where ? `, ${tilde(where.dir)}` : ""}` : plural(new Set(all.map((it) => project(it.dir).name)).size, "bay")}</span>
          <span class="r">${only && html`<button class="kb ${scope === "all" ? "on" : ""}" aria-pressed=${scope === "all"} onClick=${() => setScope(scope === "all" ? "bay" : "all")}>All bays</button>`}</span></div>
        <div class="l2 no-block"><span class="stat">${counts}</span><span class="rd"><span class="l">done</span>${n("done")}</span><span class="rd"><span class="l">from agents</span>${scoped.filter((it) => it.by && it.status !== "done").length}</span></div>
      </header>
      <div class="scroll"><div class="bk ${bay ? "single" : ""}">
        <div class="bk-bar">
          <form class="bk-add" onSubmit=${(e) => { e.preventDefault(); addIt(); }}><span class="pr" aria-hidden="true">add</span>
            <input id="bk-add" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === "Escape" && e.target.blur()} autocomplete="off"
              placeholder=${`${bay ? `A task for ${bay}` : "A task; you pick its folder next"}${touch ? "" : ", enter adds it"}`} aria-label=${`Add a task to ${bay || "the"} backlog`} />
            <button class="btn" disabled=${adding || !text.trim()}>${adding ? "Adding…" : "Add"}</button></form>
          ${seg(BK_FILTERS, "f", "Show")}${seg([["stage", "Stage"], ["new", "Newest"], ...(bay ? [] : [["bay", "Bay"]])], "sort", "Order")}
        </div>
        <div class="bk-h" role="presentation"><span>Stage</span><span>Task</span><span class="c-bay">Bay</span><span class="c-by">Added by</span><span class="n">Age</span><span></span></div>
        <div role="grid" aria-label="Backlog">
          ${list && !scoped.length && html`<div class="bk-empty"><b>Nothing on ${bay ? `${bay}'s` : "the"} backlog</b><p>Add a task above and it waits here until you start it. Agents add to it too: tell the assistant <code>later: …</code> from anywhere, and what they add waits under Suggested until you take it.</p></div>`}
          ${list && scoped.length > 0 && !shown.length && html`<div class="bk-empty"><b>No ${keep[1].toLowerCase()} tasks${bay ? ` in ${bay}` : ""}</b><p>${scoped.filter((it) => itemStage(it) !== "done").length} open in other stages.</p><button class="btn" onClick=${() => set({ f: "open" })}>Show open</button></div>`}
          ${shown.map((it) => html`<${BacklogRow} key=${it.id} it=${it} stage=${itemStage(it)} run=${run(it)} sel=${cur === it} tag=${!bay}
            select=${() => setSel(it.id)} primary=${primary} done=${done} block=${block} patch=${patch} remove=${remove}
            edit=${edit?.id === it.id ? edit : null} setEdit=${setEdit} />`)}
          ${v.f === "done" && n("done") > 0 && html`<button class="btn bk-clear" onClick=${() => ask({ title: `Delete ${plural(n("done"), "finished item")}?`, body: "They leave the backlog for good.", ok: "Delete", busy: "Deleting…", danger: true,
            run: () => Promise.all(scoped.filter((it) => itemStage(it) === "done").map((it) => call(it, "DELETE"))) }).then((ok) => ok && (say("Cleared."), load()))}>Clear done</button>`}
        </div>
        <div class="bk-f"><span><kbd>j</kbd><kbd>k</kbd>move</span><span><kbd>enter</kbd>start, take or open</span><span><kbd>d</kbd>done</span><span><kbd>x</kbd>blocked</span><span><kbd>a</kbd>add</span><span>with Undo, <kbd>z</kbd></span></div>
      </div></div>
    </section>`;
}

function BacklogRow({ it, stage, run, sel, tag, select, primary, done, block, patch, remove, edit, setEdit }) {
  const head = itemTitle(it);
  const ended = stage === "started" && (!run || run.state === "stopped");
  const save = () => {
    if (edit.mode === "why") patch(it, { status: "blocked", why: edit.why }, "Blocked", { status: it.status, why: it.why || "" });
    else if (edit.title.trim() || edit.prompt.trim()) patch(it, { title: edit.title, prompt: edit.prompt }, "Saved");
    setEdit(null);
  };
  const note = it.why ? `Waiting on ${it.why}` : run || it.aside ? null : it.title && it.prompt && it.prompt !== it.title ? oneLine(it.prompt) : "";
  const by = it.by ? html`<span class="by" role=${it.from ? "link" : null} onClick=${it.from ? (e) => { e.stopPropagation(); go(it.from); } : null} title=${it.from ? "Open the session that added it" : ""}>@${it.by}</span>` : html`<span class="by you">you</span>`;
  const act = (label, key, f, prime) => html`<button class="btn ${prime ? "primary" : ""}" onClick=${(e) => { e.stopPropagation(); f(it); }} aria-keyshortcuts=${key || null}>${label}${key && html` <kbd aria-hidden="true">${key === "Enter" ? "enter" : key}</kbd>`}</button>`;
  const menu = [
    { label: "Edit", run: () => setEdit({ id: it.id, mode: "text", title: it.title || "", prompt: it.prompt || "" }) },
    !it.session && stage !== "done" && { label: it.worktree ? "Start in the folder itself" : "Start in a git worktree", run: () => patch(it, { worktree: !it.worktree }, it.worktree ? "Starts in the folder" : "Starts in a worktree") },
    { label: "Delete", danger: true, run: () => ask({ title: "Delete this item?", body: head, ok: "Delete", danger: true }).then((ok) => ok && remove(it)) },
  ].filter(Boolean);
  return html`
    <div class="bk-it ${stage} ${sel ? "sel" : ""}" role="row" aria-selected=${sel} tabindex=${sel ? 0 : -1} onClick=${select}>
      <span class="stg ${stage}">${stage}</span>
      <span class="ti">
        ${edit ? html`<form class="bk-edit" onSubmit=${(e) => { e.preventDefault(); save(); }} onClick=${(e) => e.stopPropagation()}>
            ${edit.mode === "why"
              ? html`<input value=${edit.why} onInput=${(e) => setEdit({ ...edit, why: e.target.value })} placeholder="Blocked: waiting on what? (optional, enter saves)" ref=${focusOnMount}
                  onKeyDown=${(e) => e.key === "Escape" && (e.stopPropagation(), setEdit(null))} />`
              : html`<input value=${edit.title} onInput=${(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Title: what the backlog shows" ref=${focusOnMount} />
                <textarea rows="4" value=${edit.prompt} onInput=${(e) => setEdit({ ...edit, prompt: e.target.value })} placeholder="Prompt: the session's first message. Empty: the title."
                  onKeyDown=${(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && save()}></textarea>`}
            <span class="acts2"><button type="button" class="btn" onClick=${() => setEdit(null)}>Cancel</button><button class="btn primary">${edit.mode === "why" ? "Mark blocked" : "Save"}</button></span>
          </form>`
        : html`<b>${head}</b>
          ${note ? html`<span class="nt">${note}</span>`
            : run || it.aside ? html`<span class="nt">${run && html`<${StateBlock} s=${run} /> `}<a href=${`#/s/${run ? keyOf(run) : it.sid}`} onClick=${(e) => e.stopPropagation()}>${run?.title && run.title !== head ? run.title : "its session"}</a>, ${it.aside ? "put aside" : ended ? "ended" : WORD[run.state] || run.state}</span>` : ""}`}
        <span class="meta2">${[tag && project(it.dir).name, it.by ? `@${it.by}` : "you", agoLong(stage === "done" ? it.updated : it.created)].filter(Boolean).join(", ")}</span>
      </span>
      <span class="bayn">${project(it.dir).name}${MULTI && it.host ? html` <span class="dim">${it.host}</span>` : ""}</span>
      <span class="byc">${by}</span>
      <span class="ag">${ago({ updated: stage === "done" ? it.updated : it.created })}${it.worktree && !it.session ? html`<span class="wt" title="Starts in its own worktree">wt</span>` : ""}</span>
      <span class="acts" onClick=${(e) => e.stopPropagation()}>
        ${stage === "suggested" ? html`${act("Take it", "Enter", primary, true)}${act("Dismiss", "", remove)}`
          : stage === "done" ? act("Reopen", "Enter", primary)
          : stage === "started" ? html`${!ended && run ? act("Open", "Enter", primary, true) : ""}${act("Done", "d", done, ended)}`
          : html`${act(it.aside ? "Resume" : "Start", "Enter", primary, stage === "ready")}${act("Done", "d", done)}${act(stage === "blocked" ? "Unblock" : "Blocked", "x", block)}`}
        <${Menu} items=${menu} cls="btn" label="More" aria="More for this task" />
      </span>
    </div>`;
}

let AGENT_INFO = {};
const away = (s) => !!s.parked && s.state !== "needs-you";
const homeless = (s) => !!s.agent && !AGENT_INFO[s.agent]?.dir;
const GUESTS = "guests";
const guestWork = (s) => s.agent === GUESTS || project(s.cwd).name === GUESTS;
const hiddenRun = (s) => (s.kind === "hub" || (!!s.agent && !!s.parked)) && s.state !== "needs-you";
const agentApi = (a, what, body) => api(`/api/agents/${encodeURIComponent(a)}/${what}`, { method: "POST", body });
const mins = (ns) => Math.round(ns / 6e10);
const spanOf = (ns) => { const m = mins(ns); return m % 60 ? (m > 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`) : `${m / 60}h`; };
const ktok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const soon = (at) => {
  const t = new Date(at), m = Math.round((t - Date.now()) / 6e4);
  if (m < 60) return `in ${Math.max(1, m)}m`;
  const hm = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return t.toDateString() === new Date().toDateString() ? hm : `${t.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${hm}`;
};

function AgentTag({ s }) {
  const a = AGENT_INFO[s.agent] || { name: s.agent };
  return html`<span class="agenttag" role="button" title=${`${agentLabel(a)}: details`}
    onClick=${(e) => { e.stopPropagation(); AGENT_SHEET(a.name); }}><${AppTile} a=${a} size=${14} />${agentLabel(a)}</span>`;
}

const AGENTS_ROUTE = "#/agents";
const agentRoute = () => { const m = location.hash.match(/^#\/agents(?:\/([^/?]+))?$/); return m ? decodeURIComponent(m[1] || "") : null; };
const monogram = (n) => { const w = n.split(/[-_ ]+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : n.slice(0, 2)).toUpperCase(); };

function AgentMark({ a, lg }) {
  return html`<span class="am ${lg ? "lg" : ""}" data-ag=${a.name === "assistant" ? "assistant" : null} style=${`--am-c: ${appColor(a)}`} aria-hidden="true">${monogram(a.name)}</span>`;
}

const agentRun = (live, name) => live.filter((v) => v.agent === name).sort((p, q) => Date.parse(q.startedAt || 0) - Date.parse(p.startedAt || 0))[0];
const agentBadge = (a) => { const b = a.badge == null ? null : typeof a.badge === "object" ? a.badge.n ?? a.badge.count ?? a.badge.text : a.badge; return b == null || b === "" ? null : String(b); };
const agentKeeps = (a) => a.headline || (agentBadge(a) ? `${agentBadge(a)} on its page` : "");
const agentWakes = (a) => a.every ? `every ${a.every}${a.from ? ` from ${a.from.replace("T", " ")}` : ""}` : "when messaged";

function AgentsPage({ name, agents, live, say, reload }) {
  useNow(30000);
  const wide = useWide();
  const list = (agents || []).filter((a) => a.name);
  const cur = list.find((a) => a.name === name) || (wide && !name ? list.find((a) => a.name === stored("atc.agentsel", "")) || list[0] : null);
  useEffect(() => { if (cur) store("atc.agentsel", cur.name); }, [cur?.name]);
  const keys = useRef();
  keys.current = { list, cur };
  useEffect(() => {
    const k = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector(".nsveil, .pal, .veil, .keys-ov")) return;
      const { list, cur } = keys.current, i = list.indexOf(cur);
      const to = (a) => a && location.replace(`${AGENTS_ROUTE}/${encodeURIComponent(a.name)}`);
      const f = { j: () => to(list[i + 1]), k: () => to(list[i - 1]), ArrowDown: () => to(list[i + 1]), ArrowUp: () => to(list[i - 1]),
        Enter: () => document.querySelector(".agd .conv")?.click() }[e.key];
      if (f) { e.preventDefault(); f(); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return html`
    <section class="scrpane agentsv ${cur ? "has-a" : "no-a"}" aria-label="Agents">
      <aside class="agl" aria-label="Agents">
        <div class="ph"><b>Agents</b><span>${list.length}</span></div>
        <div class="scroll" role="listbox" aria-label="Agents">
          ${!agents && html`<p class="none">Loading…</p>`}
          ${agents && !list.length && html`<p class="none">No standing agents. An agent is a folder with a brief under ~/.config/atc/agents.</p>`}
          ${list.map((a) => { const x = agentRun(live, a.name), keeps = agentKeeps(a); return html`
            <a class="ar ${a === cur ? "sel" : ""}" role="option" aria-selected=${a === cur} href=${`${AGENTS_ROUTE}/${encodeURIComponent(a.name)}`}
              onClick=${(e) => { e.preventDefault(); const to = `${AGENTS_ROUTE}/${encodeURIComponent(a.name)}`; wide ? location.replace(to) : (location.hash = to); }}>
              <${AgentMark} a=${a} /><b>${a.name === "assistant" ? "Assistant" : `@${a.name}`}${x?.parked && html`<span class="pz">parked</span>`}</b>
              <span class="ago">${a.last ? ago({ updated: a.last }) : ""}</span>
              <span class="k ${keeps ? "" : "none"}">${a.error ? "Can't start: see why" : keeps || "Keeps nothing"}</span>
              <span class="l">${oneLine(x?.summary?.status || x?.lastReply) || `wakes ${agentWakes(a)}`}</span></a>`; })}
        </div>
      </aside>
      ${cur ? html`<${AgentDetail} key=${cur.name} a=${cur} live=${live} say=${say} reload=${reload} />` : html`<section class="agd"></section>`}
    </section>`;
}

function AgentDetail({ a, live, say, reload }) {
  const [busy, setBusy] = useState(false);
  const [use, setUse] = useState(false);
  const x = agentRun(live, a.name);
  const title = a.name === "assistant" ? "Assistant" : `@${a.name}`;
  const act = (fn, done) => async () => {
    setBusy(true);
    try { const r = await fn(); done && done(r); reload(); } catch (e) { say(e.message); }
    setBusy(false);
  };
  const conv = x ? () => go(keyOf(x)) : a.sessionId ? () => go(a.sessionId) : act(() => agentApi(a.name, "message"), (r) => go(r.id));
  const keeps = agentKeeps(a);
  const said = oneLine(x?.summary?.status || x?.lastReply);
  const rule = a.rule && `${spanOf(a.rule.Quiet)} quiet past ${ktok(a.rule.Small)} tokens, or ${spanOf(a.rule.CapQuiet)} quiet past ${ktok(a.rule.Cap)}`;
  const status = a.error ? `Can't start: ${a.error}` : x ? `${WORD[x.state] || x.state}${x.parked ? ", parked" : ""}${x.state === "working" && x.activity ? `: ${oneLine(x.activity)}` : ""}` : "No conversation running";
  const right = html`
    ${a.prompt && x && html`<button class="btn" disabled=${busy || x.state === "working"} title=${a.prompt} onClick=${act(() => agentApi(a.name, "message"), () => say(`Woke ${title}.`))}>Wake now</button>`}
    ${x && html`<button class="btn" disabled=${busy} onClick=${act(() => api(`/api/sessions/${x.sessionId}`, { method: "PATCH", body: { parked: !x.parked } }), () => say(x.parked ? `Unparked ${title}.` : `Parked ${title}.`))}>${x.parked ? "Unpark" : "Park"}</button>`}
    ${x && x.state !== "past" && html`<button class="btn" disabled=${busy || x.state === "working"} onClick=${act(() => agentApi(a.name, "reset"), () => say(`${title} is starting over.`))}>Start over</button>`}
    <button class="btn primary conv" disabled=${busy || (!x && !a.sessionId && !!a.error)} onClick=${conv} aria-keyshortcuts="Enter">Conversation <kbd aria-hidden="true">enter</kbd></button>`;
  const facts = [
    ["Host", a.host],
    ["Folder", tilde(a.folder || a.dir || "")],
    ["Wakes", agentWakes(a)],
    a.next && ["Next", soon(a.next)],
    a.check && ["Only if", html`<code>${a.check}</code> prints something`],
    a.prompt && ["Prompt", a.prompt],
    rule && ["Starts over", rule],
    a.lastReset && ["Last started over", agoLong(a.lastReset)],
    x?.context && ["Context", `${ktok(x.context)} tokens`],
  ].filter(Boolean);
  return html`
    <section class="agd">
      <header class="hd">
        <div class="l1"><a class="back kb" href=${AGENTS_ROUTE}>Agents</a><${AgentMark} a=${a} /><h1>${title}</h1><span class="where">${[a.host, tilde(a.folder || a.dir || "")].filter(Boolean).join(" ")}</span>
          <span class="r">${right}</span></div>
        <div class="l2"><span class="stat">${status}</span><span class="rd"><span class="l">wakes</span>${agentWakes(a)}</span>${a.next && html`<span class="rd"><span class="l">next</span>${soon(a.next)}</span>`}</div>
      </header>
      <div class="scroll"><div class="agbody">
        <div class="acts-ph">${right}</div>
        <section class="sec"><div class="sh"><h2>Keeps</h2><span class="n">${keeps ? "its own state, from its page" : ""}</span></div>
          ${keeps ? html`<div class="keeps">${agentBadge(a) && html`<b>${agentBadge(a)}</b>`}<p>${a.headline || "the count on its page"}</p></div>` : html`<div class="nothing"><b>${title} keeps nothing</b><p>It writes no state of its own: it acts when asked. What it did is in its conversation and in what it said below.</p></div>`}
        </section>
        <section class="sec"><div class="sh"><h2>Said</h2><span class="n">${x ? ago(x) : ""}</span></div>
          ${said ? html`<div class="said"><time>${x?.updated ? hhmm(x.updated) : ""}</time><p>${said}</p></div>` : html`<div class="nothing"><p>Nothing yet in this conversation.</p></div>`}
        </section>
        <section class="sec links"><div class="sh"><h2>Pages</h2><span class="n">${plural(a.pages?.length || 0, "page")}</span></div>
          ${a.pages?.length ? a.pages.map((p) => html`<a href=${aloneLink(p.session, p.name)}><b>${pageTitle(p)}</b><span>${ago({ updated: p.updated || p.shown })}</span></a>`) : html`<div class="nothing"><p>No pages yet.</p></div>`}
        </section>
        <section class="sec"><div class="sh"><h2>Where it lives</h2><span class="r"><button class="kb" onClick=${() => setUse(true)}>Usage</button></span></div>
          <dl class="kv">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        </section>
      </div></div>
      ${use && html`<${AgentUsage} name=${a.name} onClose=${() => setUse(false)} />`}
    </section>`;
}

function AgentUsage({ name, onClose }) {
  const use = useUsage(`/api/agents/${encodeURIComponent(name)}/usage`, 15000);
  const a = AGENT_INFO[name] || { name };
  return html`<${SessionUsage} s=${{ title: `${agentLabel(a)}, every conversation` }} use=${use} agent onClose=${onClose} />`;
}
const SourceTag = ({ s, full }) => (s.agent ? html`<${AgentTag} s=${s} />` : html`<${ProjectTag} path=${s.cwd} full=${full} />`);

const APP_ICONS = {
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 13.8c2.1.8 3.5 2.9 3.5 5.2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  present: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8M7 12l3-3 2 2 4-4"/>',
  lira: '<path d="M9 4v14.5c4.5 0 8-3 8-7.5"/><path d="M5.5 10.5 13 7M5.5 14.5 13 11"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5.5 5h13L21 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V13z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4m0 0 2.5-2.5M11 6l2.5 2.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  chat: '<path d="M4 5.5h16v10H10l-4.5 3.5v-3.5H4z"/>',
  doc: '<path d="M7 3h7l5 5v11.5A1.5 1.5 0 0 1 17.5 21h-10A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
};
const APP_COLORS = ["blue", "amber", "violet", "green", "red", "teal", "pink", "orange", "slate"];
const appColor = (a) => /^#[0-9a-f]{3,8}$/i.test(a.color || "") ? a.color
  : `var(--app-${APP_COLORS.includes(a.color) ? a.color : APP_COLORS[[...a.name].reduce((h, c) => h + c.charCodeAt(0), 0) % APP_COLORS.length]})`;

function AppTile({ a, size = 32, dot }) {
  const svg = APP_ICONS[a.icon];
  return html`<span class="atile" style=${`--a: ${appColor(a)}; --s: ${size}px`}>
    ${svg ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: svg }}></svg>` : html`<span class="aglyph">${a.icon || a.name[0].toUpperCase()}</span>`}
    ${dot && html`<i class="adot ${dot}"></i>`}
  </span>`;
}

const agentLabel = (a) => a.title || a.name.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

function PageAlone({ sid: ref, name, at, live, say }) {
  const [hit, setHit] = useState(null);
  useEffect(() => {
    if (idRef(ref)) return;
    api("/api/pages").then((l) => {
      const slug = linkSlug(ref), exact = (p) => linkSlug(p.of) === slug;
      const p = (l || []).filter((p) => p.name === name && (exact(p) || unstamped(p.of) === slug))
        .sort((a, b) => !!a.gone - !!b.gone || exact(b) - exact(a) || new Date(b.shown) - new Date(a.shown))[0];
      setHit(p ? p.session : ref);
    }, () => setHit(ref));
  }, [ref, name]);
  const byId = idRef(ref) && (live.find((x) => x.sessionId === ref) || live.find((x) => x.sessionId.startsWith(ref)));
  const sid = byId ? byId.sessionId : idRef(ref) ? ref : hit;
  return sid ? html`<${PageOf} key=${sid} sid=${sid} via=${ref} name=${name} at=${at} live=${live} say=${say} />`
    : html`<div class="palone"><div class="fbody"><p class="empty">Loading…</p></div></div>`;
}

function PageOf({ sid, via, name, at, live, say }) {
  const [got, setGot] = useState(null);
  const s = live.find((x) => x.sessionId === sid);
  useEffect(() => {
    if (s) return;
    const load = () => api(`/api/sessions/${sid}/pages`).then((l) => setGot(l || []), (e) => setGot({ err: e.message }));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [sid, !!s]);
  const list = s ? [browserPage(s), ...(s.shown || [])].filter(Boolean) : Array.isArray(got) ? got : [];
  const owner = s || { sessionId: list[0]?.session || sid, title: list[0]?.of || "", state: "past" };
  const back = () => (s ? (location.hash = pageLink(sid, name)) : (location.hash = pagesHash()));
  return html`
    <div class="palone">
      ${got?.err ? html`<div class="fbody"><p class="empty">${got.err}</p></div>`
        : !s && !got ? html`<div class="fbody"><p class="empty">Loading…</p></div>`
        : list.some((p) => p.name === name) ? html`<${PagePane} s=${owner} list=${list} cur=${name} at=${at} pick=${(n) => location.replace(aloneLink(via, n))} say=${say} onClose=${back} alone />`
        : html`<div class="fbody"><div class="none"><p>This page was taken down.</p><button class="btn" onClick=${() => (location.hash = pagesHash())}>All pages</button></div></div>`}
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

const TX_FACES = {
  lit: { name: "Literata", css: "Literata, Georgia, serif", sizes: [16, 17.5, 19], lh: 1.62 },
  sans: { name: "Recursive", css: "var(--sans)", sizes: [15, 16, 17.5], lh: 1.62 },
};
const txStore = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`atc.tx.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(`atc.tx.${k}`) : localStorage.setItem(`atc.tx.${k}`, JSON.stringify(v)); } catch {} },
};
const txPrefs = {
  get: () => ({ face: "lit", size: 1, width: 1, ...txStore.get("prefs", {}) }),
  set(p) {
    const v = { ...txPrefs.get(), ...p };
    txStore.set("prefs", v);
    dispatchEvent(new CustomEvent("atc-txprefs", { detail: v }));
  },
};
const TX_MEASURES = [600, 650, 740];

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
  const tail = items.slice(last + 1).filter((it) => it.t === "text"), answer = tail.map((it) => it.text).join("\n\n");
  const work = items.slice(0, last + 1).concat(items.slice(last + 1).filter((it) => it.t === "event" || it.t === "note"));
  const user = msgs.find((m) => m.role === "user");
  return { items: work, answer, answerAt: tail[0]?.time, images: user?.images || [], prompt: user?.text, cost, ms };
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
  const i = s.input, at = (k) => s._lines?.[k] || 0;
  if (s.tool === "MultiEdit") return (i.edits || []).map((e, k) => ({ old: e.old_string || "", new: e.new_string || "", line: at(k) }));
  return [{ old: i.old_string || "", new: i.new_string || "", line: at(0) }];
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

// numberEdits finds where each edit sits in its file, from what the turn read of that file before it:
// a Read's cat -n lines, kept current through the edits and writes that follow. Unknown stays 0.
function numberEdits(items) {
  const seen = new Map();
  for (const it of items) {
    if (it.t !== "step" || it.out?.error) continue;
    const path = it.input?.file_path;
    if (it.tool === "Read" && path && it.out?.text && !it.out.more) {
      const ls = it.out.text.split("\n").map((l) => l.match(/^\s*(\d+)\t(.*)$/));
      if (ls.length && ls.every(Boolean)) seen.set(path, { start: +ls[0][1], lines: ls.map((m) => m[2]) });
    } else if (it.tool === "Write" && path) seen.set(path, { start: 1, lines: (it.input.content || "").split("\n") });
    else if (/^(Edit|MultiEdit)$/.test(it.tool) && path) {
      const es = it.tool === "MultiEdit" ? it.input.edits || [] : [it.input];
      it._lines = es.map((e) => {
        const w = seen.get(path), text = w?.lines.join("\n"), old = e.old_string || "", at = text && old ? text.indexOf(old) : -1;
        if (!w || at < 0 || e.replace_all || text.indexOf(old, at + 1) >= 0) { seen.delete(path); return 0; }
        w.lines = (text.slice(0, at) + (e.new_string || "") + text.slice(at + old.length)).split("\n");
        return w.start + text.slice(0, at).split("\n").length - 1;
      });
    }
  }
  return items;
}

function squash(badges) {
  const out = [], seen = new Set();
  const last = (kind) => badges.findLast((b) => b.kind === kind);
  const test = last("test"), build = last("build");
  if (test) out.push(test);
  if (build && !build.ok) out.push(build);
  for (const b of badges) {
    if (b.kind === "test" || b.kind === "build") continue;
    const key = b.kind + (b.kind === "commit" ? b.ref : b.text + (b.ref || ""));
    if (!seen.has(key)) { seen.add(key); out.push(b); }
  }
  return out;
}

const badgeLabel = (b) => b.kind === "deploy" ? (b.ok ? `Deployed ${b.ref}` : b.text) : b.kind === "test" && b.ref ? `${b.text}, ${b.ref}` : b.text;
function BadgeChip({ b }) {
  const chip = html`<span class="badge ${b.ok ? "ok" : "bad"}" title=${b.ref || badgeLabel(b)}>${b.kind === "commit" && html`<code>${b.ref}</code>`}<span class="l">${badgeLabel(b)}</span></span>`;
  if (b.kind === "show") return html`<span class="chiplink" role="link" onClick=${(e) => { e.stopPropagation(); SESSION_API?.page(b.ref); }}>${chip}</span>`;
  return chip;
}

function Clip({ out, bad, n = 8 }) {
  const [all, setAll] = useState(false);
  if (!out?.text) return null;
  const lines = out.text.split("\n");
  const hidden = (all ? 0 : Math.max(0, lines.length - n)) + (out.more || 0);
  return html`<pre class="tpre out ${bad ? "bad" : ""}">${all ? out.text : lines.slice(0, n).join("\n")}</pre>${hidden > 0 && !all && html`<button class="more-lines" onClick=${() => setAll(true)}>Show ${hidden} more line${hidden > 1 ? "s" : ""}</button>`}${all && out.more > 0 && html`<p class="more-lines">${out.more} more lines were not kept</p>`}`;
}

function wordMarks(a, b, side) {
  const parts = diffWords(a, b), changed = parts.filter((p) => p.added || p.removed).reduce((n, p) => n + p.value.length, 0);
  if (changed > 0.6 * Math.max(a.length, b.length, 1)) return null;
  return parts.filter((p) => (side === "del" ? !p.added : !p.removed)).map((p) => (p.added || p.removed ? `<mark>${esc(p.value)}</mark>` : esc(p.value))).join("");
}
function diffRows(e) {
  const rows = [], known = e.line > 0, parts = diffLines(e.old, e.new);
  let o = e.line, n = e.line;
  const lines = (p) => p.value.replace(/\n$/, "").split("\n");
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi], ls = lines(p);
    if (p.removed && parts[pi + 1]?.added) {
      const ns = lines(parts[++pi]), pair = ls.length === ns.length;
      ls.forEach((l, j) => rows.push({ c: "del", o: known ? o++ : "", l, other: pair ? ns[j] : null }));
      ns.forEach((l, j) => rows.push({ c: "add", n: known ? n++ : "", l, other: pair ? ls[j] : null }));
    } else if (p.removed) ls.forEach((l) => rows.push({ c: "del", o: known ? o++ : "", l }));
    else if (p.added) ls.forEach((l) => rows.push({ c: "add", n: known ? n++ : "", l }));
    else {
      const head = pi === 0 ? 0 : 3, tail = pi === parts.length - 1 ? 0 : 3;
      ls.forEach((l, j) => {
        const shown = ls.length <= 7 || j < head || j >= ls.length - tail;
        if (shown) rows.push({ c: "ctx", o: known ? o : "", n: known ? n : "", l });
        else if (j === head) rows.push({ gap: `${ls.length - head - tail} lines unchanged` });
        o++; n++;
      });
    }
  }
  return rows;
}
function Diff({ edits, cap = 400 }) {
  const all = edits.flatMap((e, i) => [...(i ? [{ gap: e.line ? `line ${e.line}` : "elsewhere in the file" }] : []), ...diffRows(e)]), rows = all.slice(0, cap);
  const tidy = (l) => l.replace(/\t/g, "  ");
  const ind = Math.min(...rows.filter((r) => !r.gap && tidy(r.l).trim()).map((r) => tidy(r.l).match(/^ */)[0].length));
  const cut = (l) => (isFinite(ind) ? tidy(l).slice(ind) : tidy(l));
  return html`<div class="code">${rows.map((r) => {
    if (r.gap) return html`<div class="gap">${r.gap}</div>`;
    const a = cut(r.l), b = r.other != null ? cut(r.other) : null;
    const w = b != null && wordMarks(r.c === "del" ? a : b, r.c === "del" ? b : a, r.c);
    return html`<div class="l ${r.c}"><span class="ln o">${r.o}</span><span class="ln">${r.n}</span><span class="s">${r.c === "add" ? "+" : r.c === "del" ? "-" : ""}</span><span class="c" dangerouslySetInnerHTML=${{ __html: w || esc(a) || " " }}></span></div>`;
  })}${all.length > cap && html`<div class="gap">${all.length - cap} more lines not shown; the file has them</div>`}</div>`;
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
  if (!page) return html`<p class="cont">Reading the agent's work</p>`;
  const b = bodyOf(page.messages || []);
  return html`<div class="thread">
    ${b.prompt && html`<p class="thread-ask">${firstSentence(b.prompt)}</p>`}
    ${b.items.length > 0 && html`<div class="steps">${joinEdits(numberEdits(b.items)).filter((x) => x.t === "step" && !TX_NOISE.test(x.tool)).map((x) => html`<${Step} key=${x.id} st=${x} s=${s} zoom=${zoom} />`)}</div>`}
    ${b.answer ? html`<div class="prose small" dangerouslySetInnerHTML=${{ __html: md(b.answer) }}></div>`
      : done ? st.out?.text && html`<div class="prose small" dangerouslySetInnerHTML=${{ __html: md(st.out.text) }}></div>`
      : html`<p class="cont">The agent is still working</p>`}
  </div>`;
}

const optIndex = (q, label) => (q.options || []).findIndex((o) => o.label === label);
function AskedStep({ st, s }) {
  const ans = answersOf(st), other = answeredElsewhere(s);
  return (st.input.questions || []).map((q) => {
    const a = ans[q.question] || "";
    if (!a && !st.out) return html`<p class="evt">${s.asks?.length ? "Asked you a question; it waits below." : "Asked a question; answer it in the terminal."}</p>`;
    const parts = a.split(/,\s*/).filter(Boolean), picked = parts.map((x) => optIndex(q, x));
    const said = picked.some((i) => i < 0) ? a : parts.map((x, j) => `${picked[j] + 1}, ${x}`).join("; ");
    return html`<${AnsweredLine} q=${q.question} options=${(q.options || []).map((o) => ({ label: o.label, note: o.description !== o.label ? o.description : "" }))}
      chosen=${picked.filter((i) => i >= 0)} line=${a ? html`You answered <b>${said}</b>${st.out?.time && `, ${txClock(st.out.time)}`}${other?.what === a && fromWhere(other)}` : "No answer was given"} />`;
  });
}

function PageRef({ b, s }) {
  useSeenTick();
  const p = (s.shown || []).find((x) => x.name === splitRef(b.ref)[0]);
  return html`<button class="pref ${p && pageFresh(p) ? "fresh" : ""}" onClick=${() => SESSION_API?.page(b.ref)} title=${p ? tilde(p.path) : ""}>
    <span><span class="pk2"><span class="tag">${KIND_LABEL[p?.kind] || "Page"}</span>${p ? "made here" : s.state === "past" ? "shown here" : "taken down"}</span>
      <span class="pt">${p ? pageTitle(p) : b.text}</span>${p && html`<span class="pl">${pageInfo(p)}</span>`}</span>
    <span class="go kb">Open</span></button>`;
}

function Step({ st, s, zoom, pin }) {
  const k = txKind(st), i = st.input, bad = st.out?.error;
  const [opened, setOpen] = useState(!!bad || (st.out?.images || []).length > 0);
  const open = opened || pin;
  const toggle = () => setOpen(!open);
  const cls = `step ${st.tool === "Write" ? "write" : k} ${bad ? "bad" : ""}`;
  const running = pin && !st.out && html`<${Running} st=${st} />`;
  if (k === "ask") return html`<div class=${cls}><${AskedStep} st=${st} s=${s} /></div>`;
  if (st.tool === "Bash" && st.badge?.kind === "show") return html`<div class=${cls}><${PageRef} b=${st.badge} s=${s} /></div>`;
  if (st.tool === "Bash") {
    const cmd = i.command || st.detail || "";
    const b = st.badge;
    return html`<div class=${cls}>
      <button class="line" aria-expanded=${open} onClick=${toggle}>
        ${b ? html`<${BadgeChip} b=${b} />` : html`<b>${i.description || "Ran"}</b>`}
        ${!b && !i.description && html`<span class="arg">${cmd.split("\n")[0]}</span>`}
        ${b && i.description && html`<span class="arg sans">${i.description}</span>`}
        <${Failed} st=${b ? {} : st} />${running}
      </button>
      ${open && html`<div class="tbox"><pre class="tpre"><span class="ps">$ </span>${cmd}</pre><${Clip} out=${st.out} bad=${bad} /></div>`}
    </div>`;
  }
  if (k === "edit") {
    const d = diffStat(st), path = relPath(i.file_path || st.detail, s);
    return html`<div class=${cls}>
      <button class="line" aria-expanded=${open} onClick=${toggle}><b>${st.tool === "Write" ? "Wrote" : st.n > 1 ? `Edited ${st.n} times` : "Edited"}</b><span class="arg">${path}</span><span class="end"><span class="plus">+${d.add}</span>${d.del > 0 && html` <span class="minus">-${d.del}</span>`}</span>${running}</button>
      ${open && html`<div class="tbox"><${Diff} edits=${st.tool === "Write" ? [{ old: "", new: i.content || "", line: 1 }] : st.edits || txEdits(st)} cap=${120} /></div>`}
    </div>`;
  }
  if (st.tool === "Read") {
    const from = i.offset, to = i.offset && i.limit ? i.offset + i.limit : null;
    return html`<div class=${cls}><div class="line"><b>Read</b><span class="arg">${relPath(i.file_path || st.detail, s)}${from ? `:${from}${to ? `-${to}` : ""}` : ""}</span><${Failed} st=${st} />${running}</div><${Shots} st=${st} zoom=${zoom} /></div>`;
  }
  if (st.tool === "Grep" || st.tool === "Glob") return html`<div class=${cls}><div class="line"><b>Searched</b><span class="arg">${i.pattern || st.detail}${i.path ? `  in ${relPath(i.path, s)}` : ""}</span>${running}</div></div>`;
  if (st.tool === "WebSearch") {
    const hits = st.out?.meta?.hits || [];
    return html`<div class=${cls}>
      <button class="line" aria-expanded=${open} onClick=${toggle}><b>Searched the web</b><span class="arg wrap sans">${i.query || st.detail}</span>${running}</button>
      ${open && hits.length > 0 && html`<div class="tbox"><ul class="hits">${hits.map((h) => html`<li><span class="d">${hostOf(h.url)}</span><a href=${h.url} data-out>${h.title}</a></li>`)}</ul></div>`}
    </div>`;
  }
  if (st.tool === "WebFetch") return html`<div class=${cls}>
    <button class="line" aria-expanded=${open} onClick=${toggle}><b>Read</b><span class="arg">${hostOf(i.url || st.detail)}</span>${running}</button>
    ${open && html`<div class="tbox">${i.prompt && html`<p class="tbhd">${i.prompt}</p>`}<div class="prose small" dangerouslySetInnerHTML=${{ __html: md(st.out?.text) }}></div></div>`}
  </div>`;
  if (k === "agent") return html`<div class=${cls}>
    <button class="line" aria-expanded=${open} onClick=${toggle}><b>Agent</b><span class="arg wrap sans">${i.description || st.detail}</span>${running}</button>
    ${open && html`<div class="tbox"><${AgentThread} st=${st} s=${s} zoom=${zoom} /></div>`}
  </div>`;
  if (TX_NOISE.test(st.tool)) return null;
  const input = Object.keys(i).length ? JSON.stringify(i, null, 1) : st.detail;
  return html`<div class=${cls}>
    <button class="line" aria-expanded=${open} onClick=${toggle}><b>${toolName(st.tool)}</b><${Failed} st=${st} />${running}</button>
    ${open && html`<div class="tbox">${input && html`<pre class="tpre">${input}</pre>`}<${Clip} out=${st.out} bad=${bad} /></div>`}
    <${Shots} st=${st} zoom=${zoom} />
  </div>`;
}

const THEME_NOTES = { "": "Instrument grey; the deepest dark", frappe: "Catppuccin Frappé, with Rosé Pine Dawn for light", nord: "Nord's blue-grey; a softer dark" };
const PREVIEW_COLORS = ["strip", "sunk", "line", "ink", "dim", "faint", "needs", "work"];
const TX_SAMPLE = "The resize race came from two viewers sending sizes at once. The server now keeps the size of the last visible one and asks Claude to redraw, so a phone joining no longer squeezes the desktop.";

function ThemePreview({ colors, on }) {
  return html`<span class="pv" aria-hidden="true">${["light", "dark"].map((sc) => {
    const c = colors?.[sc] || {};
    const style = PREVIEW_COLORS.map((n) => `--p-${n}: ${c[n] || "transparent"}`).join(";");
    return html`<span class="h ${on(sc) ? "" : "off"}" style=${style}>
      <span class="bar"><i class="n"></i><i class="t"></i><i class="w"></i></span>
      <span class="row"><i class="b n"></i><i class="l"></i></span>
      <span class="row"><i class="b t"></i><i class="l s"></i></span>
      <span class="row"><i class="b w"></i><i class="l d"></i></span>
      <span class="prose"><i></i><i></i><i class="s"></i></span>
      <span class="lab">${sc === "light" ? "Light" : "Dark"}</span>
    </span>`;
  })}</span>`;
}

function Seg({ label, value, options, set }) {
  return html`<span class="seg" role="group" aria-label=${label}>${options.map(([v, name, style]) =>
    html`<button aria-pressed=${value === v} style=${style || ""} onClick=${() => set(v)}>${name}</button>`)}</span>`;
}

function SettingsPage({ me, onClose }) {
  const [look, setLook] = useState({ scheme: LOOK.scheme, theme: LOOK.theme });
  const [colors, setColors] = useState(null);
  const [prefs, setPrefs] = useState(txPrefs.get);
  const [notif, setNotif] = useState(() => typeof Notification === "undefined" ? "none" : Notification.permission);
  useEffect(() => {
    const onLook = () => setLook({ scheme: LOOK.scheme, theme: LOOK.theme });
    const onPrefs = (e) => setPrefs(e.detail);
    const onKey = (e) => e.key === "Escape" && !document.querySelector(".veil") && onClose();
    addEventListener("atc-look", onLook);
    addEventListener("atc-txprefs", onPrefs);
    addEventListener("keydown", onKey);
    Promise.all(LOOK.sheets).then(() => setColors(LOOK.palettes(PREVIEW_COLORS, (c) => c)));
    return () => { removeEventListener("atc-look", onLook); removeEventListener("atc-txprefs", onPrefs); removeEventListener("keydown", onKey); };
  }, []);
  const on = (sc) => look.scheme === "auto" || look.scheme === sc;
  const face = TX_FACES[prefs.face] || TX_FACES.lit;
  const askNotif = () => Notification.requestPermission().then(setNotif);
  const hosts = me?.hosts?.length > 1 ? me.hosts.join(" and ") : me?.host;
  return html`
    <div class="pghome settings" role="dialog" aria-label="Settings">
      <header class="pghead">
        <button class="icon" onClick=${onClose} aria-label="Back">←</button>
        <div class="who"><h2>Settings</h2></div>
      </header>
      <div class="pgbody"><div class="setpage">
        <section id="appearance">
          <h2>Appearance <span class="n">one setting for every device</span></h2>
          <div class="set">
            <b>Light and dark</b>
            <p>Auto follows each device's own setting, so the phone can be dark while the desk is light.</p>
            <div class="ctl"><${Seg} label="Light and dark" value=${look.scheme} set=${(v) => LOOK.set("scheme", v)}
              options=${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]} /></div>
          </div>
          <div class="themes" role="radiogroup" aria-label="Theme">
            ${Object.entries(THEMES).map(([t, name]) => html`
              <button class="thcard" role="radio" aria-checked=${look.theme === t} onClick=${() => LOOK.set("theme", t)}>
                <${ThemePreview} colors=${colors?.[t || "atc"]} on=${on} />
                <span class="meta"><b>${name}</b>${look.theme === t && html`<span class="cur">In use</span>`}<span class="d">${THEME_NOTES[t] || ""}</span></span>
              </button>`)}
          </div>
        </section>
        <section id="reading">
          <h2>Reading <span class="n">transcripts, on this device</span></h2>
          <div class="set">
            <b>Typeface</b>
            <p>What the agent says to you. Your own words and the interface stay in Recursive.</p>
            <div class="ctl"><${Seg} label="Typeface" value=${prefs.face} set=${(v) => txPrefs.set({ face: v })}
              options=${Object.entries(TX_FACES).map(([k, f]) => [k, f.name, `font-family:${f.css}`])} /></div>
          </div>
          <div class="set">
            <b>Size</b>
            <div class="ctl"><${Seg} label="Size" value=${prefs.size} set=${(v) => txPrefs.set({ size: v })}
              options=${["Small", "Medium", "Large"].map((n, i) => [i, n])} /></div>
          </div>
          <div class="set">
            <b>Line length</b>
            <div class="ctl"><${Seg} label="Line length" value=${prefs.width} set=${(v) => txPrefs.set({ width: v })}
              options=${["Narrow", "Normal", "Wide"].map((n, i) => [i, n])} /></div>
          </div>
          <p class="rsample" style=${`font-family:${face.css};font-size:${face.sizes[prefs.size]}px;line-height:${face.lh};max-width:${TX_MEASURES[prefs.width]}px`}>${TX_SAMPLE}</p>
        </section>
        ${!APP && notif !== "none" && html`
          <section id="notifications">
            <h2>Notifications <span class="n">this browser</span></h2>
            <div class="set">
              <b>Desktop notifications</b>
              <p>${notif === "granted" ? "On: a session that needs you or finishes its turn shows a notification while this tab is in the background."
                : notif === "denied" ? "Blocked in this browser's site settings; allow notifications for atc there to turn them on."
                : "Off: turn on to hear about sessions while this tab is in the background."}</p>
              <div class="ctl">${notif === "default" ? html`<button class="btn" onClick=${askNotif}>Turn on</button>` : html`<span class="fixed">${notif === "granted" ? "on" : "blocked"}</span>`}</div>
            </div>
          </section>`}
        <section id="about">
          <h2>About</h2>
          <div class="set"><b>This atc</b><p>Build ${me?.web || "unknown"}${hosts ? `, sessions on ${hosts}` : ""}${APP_VERSION ? `; Android app ${APP_VERSION}` : ""}.</p></div>
        </section>
      </div></div>
    </div>`;
}


function Results({ turns, s, bodies, need, go, close }) {
  const files = new Map(), commits = [], deploys = [], pushes = [];
  turns.forEach((t, i) => {
    for (const f of t.files || []) { const cur = files.get(f.path) || { path: f.path, add: 0, del: 0, turns: [] }; cur.add += f.add; cur.del += f.del; cur.turns.push(i); files.set(f.path, cur); }
    for (const b of t.badges || []) {
      if (b.kind === "commit") commits.push({ ...b, i });
      if (b.kind === "deploy" && b.ok) deploys.push({ ...b, i });
      if (b.kind === "push" && b.ok) pushes.push({ ...b, i });
    }
  });
  const [file, setFile] = useState(null);
  const [showJunk, setShowJunk] = useState(false);
  const all = [...files.values()], kept = all.filter((f) => !scratch(f.path)), junk = all.filter((f) => scratch(f.path));
  const fileRow = (f) => html`<li><button onClick=${() => setFile(f)}><span class="p"><bdi>${relPath(f.path, s)}</bdi></span><span class="n"><span class="plus">+${f.add}</span>${f.del > 0 && html` <span class="minus">−${f.del}</span>`}</span></button></li>`;
  useEffect(() => { if (file) file.turns.forEach((i) => need(i)); }, [file]);
  const fileEdits = file && file.turns.flatMap((i) => txSteps(bodies[turns[i].from]?.items || []).filter((x) => txKind(x) === "edit" && x.input.file_path === file.path && !x.out?.error).flatMap((x) => x.tool === "Write" ? [{ old: "", new: x.input.content || "" }] : txEdits(x)));
  const pages = s.shown || [];
  const sec = (title, n, body) => n > 0 && html`<section><h4>${title}<span>${n}</span></h4>${body}</section>`;
  return html`<div class="pop results" role="dialog" aria-label="What this session produced">
    <div class="pop-head"><b>What this session produced</b><button class="x" onClick=${close} >Close</button></div>
    ${file ? html`<div class="file-diff">
      <button class="back" onClick=${() => setFile(null)}>All files</button>
      <p class="p"><bdi>${relPath(file.path, s)}</bdi> <span class="plus">+${file.add}</span> <span class="minus">−${file.del}</span></p>
      ${fileEdits.length ? html`<${Diff} edits=${fileEdits} path=${file.path} />` : html`<p class="cont">Loading the edits</p>`}
    </div>` : html`
      ${sec("Files changed", kept.length || junk.length, html`<ul class="rlist">${kept.map(fileRow)}${junk.length > 0 && html`<li><button onClick=${() => setShowJunk(!showJunk)}><span class="l quiet">${showJunk ? "Hide" : "Show"} ${junk.length} scratch file${junk.length > 1 ? "s" : ""}</span></button></li>`}${showJunk && junk.map(fileRow)}</ul>`)}
      ${sec("Commits", commits.length, html`<ul class="rlist">${commits.map((c) => html`<li><button onClick=${() => { go(c.i); close(); }}><code>${c.ref}</code><span class="l">${c.text}</span></button></li>`)}</ul>`)}
      ${sec("Pushed", new Set(pushes.map((p) => p.text)).size, html`<ul class="rlist">${[...new Set(pushes.map((p) => p.text))].map((t) => html`<li><span class="l">${t}</span></li>`)}</ul>`)}
      ${sec("Deployed", deploys.length, html`<ul class="rlist">${deploys.map((d) => html`<li><button onClick=${() => { go(d.i); close(); }}><span class="l">${d.ref}</span><span class="n">${txClock(turns[d.i].at)}</span></button></li>`)}</ul>`)}
      ${sec("Pages", pages.length, html`<ul class="rlist">${pages.map((p) => html`<li><button onClick=${() => { SESSION_API?.page(p.name); close(); }}><span class="l">${pageTitle(p)}</span><span class="n">${agoLong(p.updated || p.shown)}</span></button></li>`)}</ul>`)}
      ${sec("Running", (s.servers || []).length, html`<ul class="rlist">${(s.servers || []).map((p) => html`<li><a href=${serverURL(s, p)} data-out><span class="l">:${p}</span></a></li>`)}</ul>`)}
      ${!files.size && !commits.length && !deploys.length && !pages.length && html`<p class="cont">Nothing yet: no files changed, commits, deploys or pages.</p>`}
    `}
  </div>`;
}

const TX_FILTERS = [["failed", "Failures", (t) => t.failed > 0], ["commit", "Commits", (t) => (t.badges || []).some((b) => b.kind === "commit")], ["files", "Changed files", (t) => (t.files || []).length > 0], ["deploy", "Deploys", (t) => (t.badges || []).some((b) => b.kind === "deploy")], ["asks", "Questions", (t) => t.asks > 0]];

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
    <div class="find-in"><input ref=${ref} value=${q} placeholder="Find in this session: words, files, commands" onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && list[0]) { go(list[0][0], false, q); close(); } }} /><button class="x" onClick=${close} >Close</button></div>
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


function useDictation(onText, say, onDiscard) {
  const [state, setState] = useState("idle");
  const rec = useRef(null), keep = useRef(true);
  const start = async () => {
    if (rec.current || state === "busy") return;
    keep.current = true;
    rec.current = "starting";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream), chunks = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
        if (!keep.current) { setState("idle"); onDiscard?.(); return; }
        setState("busy");
        try {
          const ctx = new AudioContext();
          const buf = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
          ctx.close();
          const res = await transcribe(wavFrom(buf));
          if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
          const text = (await res.json()).text?.trim();
          if (text) onText(text); else onDiscard?.();
        } catch (e) { say(`Couldn't write down what you said: ${e.message}`); }
        setState("idle");
      };
      r.start();
      rec.current = r;
      setState("rec");
      if (!keep.current) r.stop();
    } catch (e) { rec.current = null; say(`The microphone isn't available: ${e.message}`); }
  };
  const stop = (k = true) => {
    keep.current = k;
    if (rec.current?.state === "recording") rec.current.stop();
  };
  return { state, start, stop, toggle: () => (state === "rec" ? stop() : state === "idle" && start()) };
}

function BgStrip({ s }) {
  const seen = useRef(new Map());
  const [open, setOpen] = useState(() => pref("atc.bgopen", "off") === "on");
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
      ${running > 0 && html`<span class="chev" aria-hidden="true"></span>`}
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

const ATT_URL = new Map();
const attsOf = (sid) => txStore.get(`atts.${sid}`, []).map((a) => ({ ...a, url: ATT_URL.get(a.id) || null }));

const SLASH = [["/compact", "summarize the conversation to free context"], ["/clear", "start over with an empty context"], ["/model", "switch the model"],
  ["/review", "review the current diff"], ["/cost", "what this session has cost"], ["/memory", "edit CLAUDE.md memory"], ["/permissions", "what it may run without asking"],
  ["/agents", "subagents it can call"], ["/init", "write a CLAUDE.md for this repo"], ["/add-dir", "let it read another folder"], ["/mcp", "MCP servers and their tools"], ["/status", "model, account, connections"]];
const fileSize2 = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function Composer({ s, say, draft, setDraft, quotes, setQuotes, send, replies, focusRef, uploadRef, working, asking, interrupt, top, prompt, doors, hintFor }) {
  const ta = useRef(), file = useRef();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [slash, setSlash] = useState(0);
  const [note, setNote] = useState(null);
  const [atts, setAttsRaw] = useState(() => attsOf(s.sessionId));
  const setAtts = (f) => setAttsRaw((as) => {
    const n = typeof f === "function" ? f(as) : f, kept = n.filter((a) => a.path).map(({ id, name, path, size }) => ({ id, name, path, size }));
    txStore.set(`atts.${s.sessionId}`, kept.length ? kept : null);
    return n;
  });
  const [big, setBig] = useState(null);
  const phone = usePhone();
  const noteT = useRef(0);
  const flash = (n) => { setNote(n); clearTimeout(noteT.current); noteT.current = setTimeout(() => setNote(null), 4000); };
  const dict = useDictation((t) => { setDraft((d) => (d ? `${d.trimEnd()} ${t}` : t)); flash("kept"); }, say, () => flash("none"));
  focusRef.current = () => ta.current?.focus();
  useEffect(() => { if (!working) setConfirm(false); }, [working]);
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = ""; if (el.scrollHeight > el.clientHeight + 2) el.style.height = Math.min(el.scrollHeight, phone ? 132 : 220) + "px"; } }, [draft]);
  const go = async () => {
    const paths = atts.map((a) => (/\s/.test(a.path) ? `"${a.path}"` : a.path)).join("\n");
    const text = [...quotes.map((q) => q.split("\n").map((l) => `> ${l}`).join("\n")), draft.trim(), paths].filter(Boolean).join("\n\n");
    if (!text || busy || atts.some((a) => !a.path)) return;
    setBusy(true);
    const kept = { draft, quotes, atts };
    setDraft(""); setQuotes([]); setAtts([]);
    if ((await send(text)) === false) { setDraft(kept.draft); setQuotes(kept.quotes); setAtts(kept.atts); }
    setBusy(false);
  };
  const upload = async (files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f, f.name);
      const id = Math.random().toString(36).slice(2), url = f.type.startsWith("image/") ? URL.createObjectURL(f) : null;
      if (url) ATT_URL.set(id, url);
      setAtts((as) => [...as, { id, name: f.name || "pasted.png", url, size: f.size }]);
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
  uploadRef.current = upload;
  const slashes = /^\/\S*$/.test(draft) ? SLASH.filter(([c]) => c.startsWith(draft)) : null;
  const pickSlash = (c) => { setDraft(c + " "); setSlash(0); requestAnimationFrame(() => { const el = ta.current; el?.focus(); el?.setSelectionRange(1e4, 1e4); }); };
  const space = useRef(null);
  const onKey = (e) => {
    if (slashes?.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); return setSlash((i) => (Math.min(i, slashes.length - 1) + (e.key === "ArrowDown" ? 1 : slashes.length - 1)) % slashes.length); }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return pickSlash(slashes[Math.min(slash, slashes.length - 1)][0]); }
    }
    if (slashes && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return setDraft(""); }
    if (dict.state === "rec" && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return dict.stop(false); }
    if (confirm) {
      if (e.key === "Enter") { e.preventDefault(); setConfirm(false); return interrupt(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return setConfirm(false); }
    }
    if (e.key === "Escape" && !draft && working) { e.preventDefault(); e.stopPropagation(); return setConfirm(true); }
    if (e.key === "Escape") { e.stopPropagation(); e.target.blur(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); return go(); }
    if (e.key === " " && !draft && !touch && VOICE_OK) { e.preventDefault(); if (!e.repeat && !space.current) space.current = setTimeout(() => { space.current = "on"; dict.start(); }, 280); }
  };
  const onKeyUp = (e) => {
    if (e.key !== " " || !space.current) return;
    if (space.current === "on") dict.stop(true); else { clearTimeout(space.current); setDraft((d) => d + " "); }
    space.current = null;
  };
  const press = useRef(0);
  const talkDown = (e) => {
    e.preventDefault();
    if (dict.state === "rec") return dict.stop(true);
    press.current = Date.now(); dict.start();
  };
  const talkUp = (e) => {
    if (!press.current) return;
    const held = Date.now() - press.current > 350, r = e.currentTarget.getBoundingClientRect(), off = e.type === "pointercancel" || e.clientY < r.top - 60;
    press.current = 0;
    if (off) dict.stop(false); else if (held) dict.stop(true);
  };
  const hasText = !!(draft.trim() || atts.length || quotes.length);
  const ready = hasText && !busy && !atts.some((a) => !a.path);
  const short = s.title && s.title.length > 30 ? s.title.slice(0, 28).replace(/\s+\S*$/, "") + "..." : s.title || "this session";
  const hint = hintFor && !asking && !working ? hintFor : asking ? (phone ? "Or type your answer" : "Or type your own answer; enter sends") : working ? (phone ? "Queue a reply" : "Queue a reply for when it stops; esc in an empty box stops it") : phone ? "Reply" : `Reply to ${short}; enter sends`;
  const chips = !hasText && !asking && replies?.length > 0 ? replies : [];
  const strip = confirm ? html`<div class="cstrip confirm" role="alert"><b>Stop the agent?</b><span class="h"><kbd>enter</kbd> stops it, <kbd>esc</kbd> keeps it going</span><span class="sp"></span>
      <button class="btn" onClick=${() => { setConfirm(false); ta.current?.focus(); }}>Keep going</button><button class="btn prime" onClick=${() => { setConfirm(false); interrupt(); }}>Stop it</button></div>`
    : dict.state === "rec" ? html`<div class="cstrip dict" role="status" aria-live="polite"><span class="lvl" aria-hidden="true"><i></i><i></i><i></i><i></i></span><b>Listening</b><span class="sp"></span><span class="h">${touch ? "release to keep, slide off to cancel" : html`release to keep, <kbd>esc</kbd> cancels`}</span></div>`
    : dict.state === "busy" ? html`<div class="cstrip dict" role="status"><b class="slow">Writing down what you said</b></div>`
    : note === "kept" ? html`<div class="cstrip" role="status"><b>Kept.</b><span class="h">Edit it, or ${touch ? "Send" : html`<kbd>enter</kbd> sends`}. Nothing was sent.</span></div>`
    : note === "none" ? html`<div class="cstrip" role="status"><b>Dictation discarded.</b><span class="h">The box is as it was.</span></div>` : null;
  return html`<div class="composer">
    <div class="cols"><div class="cx">${top}
      <div class="cmp ${hasText ? "has-text" : ""} ${dict.state === "rec" ? "listening" : ""} ${VOICE_OK ? "has-talk" : ""}">
        ${slashes && html`<div class="slash" role="listbox" aria-label="Slash commands">${slashes.length ? slashes.map(([c, d], j) => html`<button class="sl ${j === Math.min(slash, slashes.length - 1) ? "on" : ""}" role="option" aria-selected=${j === slash} onMouseDown=${(e) => e.preventDefault()} onClick=${() => pickSlash(c)}><span class="c">${c}</span><span class="d">${d}</span></button>`)
          : html`<div class="sl none">No command starts with ${draft}</div>`}<div class="slh"><span><kbd>up</kbd> <kbd>down</kbd> choose</span><span><kbd>tab</kbd> complete</span><span><kbd>esc</kbd> close</span></div></div>`}
        ${strip}
        ${quotes.map((q, j) => html`<div class="cstrip quote"><span class="qx">${q}</span><span class="sp"></span><button class="btn" onClick=${() => setQuotes(quotes.filter((_, k) => k !== j))}>Remove</button></div>`)}
        <div class="cbox ${chips.length ? "has-chips" : ""}">
          ${chips.length > 0 && html`<div class="chips" aria-label="Suggested replies">${chips.map((r) => html`<button class="chip" onClick=${() => { setDraft(r); requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(1e4, 1e4); }); }}>${r}</button>`)}</div>`}
          <div class="box" onClick=${(e) => e.target === e.currentTarget && ta.current?.focus()}>
            ${prompt}
            ${atts.length > 0 && html`<div class="atts" aria-label="Attached">${atts.map((a) => html`<span class="att ${a.path ? "" : "up"}">
              ${a.url ? html`<img src=${a.url} alt="" onClick=${() => setBig(a.url)} />` : html`<span class="fi" aria-hidden="true">${(a.name.split(".").pop() || "").slice(0, 4)}</span>`}
              <span class="nm">${a.name}</span><span class="sz">${a.path ? (a.size ? fileSize2(a.size) : "") : "uploading"}</span>
              <button class="rm" aria-label=${`Remove ${a.name}`} onClick=${() => setAtts(atts.filter((x) => x.id !== a.id))}></button></span>`)}</div>`}
            <button class="kb att-b" title="Attach files (or paste, or drop them on the transcript)" onClick=${() => file.current?.click()}>Attach</button>
            <input type="file" multiple hidden ref=${file} onChange=${(e) => { upload([...e.target.files]); e.target.value = ""; }} />
            <textarea ref=${ta} rows="1" value=${draft} placeholder=${hint} aria-label=${`Reply to ${s.title || "the session"}`} enterkeyhint=${touch ? "enter" : "send"}
              onInput=${(e) => { setDraft(e.target.value); setSlash(0); if (confirm) setConfirm(false); }} onKeyDown=${onKey} onKeyUp=${onKeyUp}
              onPaste=${(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); upload(fs); } }}></textarea>
            ${VOICE_OK && html`<button class="kb mic ${dict.state === "rec" ? "on" : ""}" aria-pressed=${dict.state === "rec"} disabled=${dict.state === "busy"} title="Hold to dictate into the box; it never sends"
              onPointerDown=${talkDown} onPointerUp=${talkUp} onPointerCancel=${talkUp} onContextMenu=${(e) => e.preventDefault()}>Talk</button>`}
            ${doors}
            <button class="btn prime send" disabled=${!ready} onClick=${go} title=${working ? "It is working: this waits and sends when it stops" : "Send (enter)"}>${working ? "Queue" : "Send"}</button>
          </div>
        </div>
      </div>
    </div></div>
    ${big && html`<div class="lightbox" onClick=${() => setBig(null)}><img src=${big} alt="" /></div>`}
  </div>`;
}

function EndBar({ s, resume, busy }) {
  const at = txClock(s.updated);
  return html`<div class="endbar"><div class="cols"><div class="cx">
    <p><b>${s.state === "stopped" ? `Stopped${at ? ` ${at}` : ""}.` : "Not running."}</b> It keeps its transcript; Resume continues the conversation.</p>
    <span class="acts"><button class="btn prime" disabled=${busy} aria-keyshortcuts="r" onClick=${resume}>${busy ? "Resuming" : html`Resume <kbd aria-hidden="true">r</kbd>`}</button></span>
  </div></div></div>`;
}

const pendingOf = (sid) => txStore.get(`pending.${sid}`, []).filter((p) => Date.now() - p.at < 6 * 3600e3).map((p) => (p.state === "sending" ? { ...p, state: "sent" } : p));

const UPLOADED = /^"?[^\n"]*\/\.cache\/atc\/uploads\/[^\n]*$/gm;
const unpathed = (t) => t.replace(UPLOADED, "").trim();

const SEL_ASKS = [["Explain", "explain this part:"], ["Push back", "i'm not sure about this:"], ["Do this", "go ahead with this:"]];

function SelBar({ sel, live, act }) {
  return html`<div class="selbar" style=${`left:${sel.x}px;top:${sel.y}px`} onMouseDown=${(e) => e.preventDefault()}>
    ${live && html`<button onClick=${() => act("quote")}>Quote</button>`}
    ${live && SEL_ASKS.map(([label, lead]) => html`<button onClick=${() => act("ask", lead)}>${label}</button>`)}
    <button onClick=${() => act("copy")}>Copy</button>
    <button onClick=${() => act("find")}>Find</button>
  </div>`;
}

function copyImage(url) {
  const png = fetch(url).then((r) => r.blob()).then((b) => b.type === "image/png" ? b : createImageBitmap(b).then((i) => {
    const c = Object.assign(document.createElement("canvas"), { width: i.width, height: i.height });
    c.getContext("2d").drawImage(i, 0, 0);
    return new Promise((ok) => c.toBlob(ok, "image/png"));
  }));
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function copyText(text) {
  try { navigator.clipboard.writeText(text); } catch { const ta = Object.assign(document.createElement("textarea"), { value: text }); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
}


// Seen marks and drafts live in atc (/api/seen, /api/drafts), so the phone and the desk agree.
// Each write carries PAGE_ID; its echo on /api/events is ignored.
const SYNC = { seen: null, drafts: null, subs: new Set(), adopt: new Map(), put: new Map(), loading: null };
const syncTell = () => SYNC.subs.forEach((f) => f());
const syncLoad = () => (SYNC.loading ||= Promise.all([
  api("/api/seen").then((m) => (SYNC.seen = { ...(m || {}), ...(SYNC.seen || {}) }), () => (SYNC.seen ||= {})),
  api("/api/drafts").then((m) => (SYNC.drafts = { ...(m || {}), ...(SYNC.drafts || {}) }), () => (SYNC.drafts ||= {})),
]).then(() => {
  for (const k of Object.keys(localStorage)) {
    const m = k.match(/^atc\.tx\.(draft|seen)\.(.+)$/);
    if (!m) continue;
    const v = txStore.get(`${m[1]}.${m[2]}`, "");
    if (m[1] === "draft" && v && !SYNC.drafts[m[2]]?.text) draftPut(m[2], v, 0);
    txStore.set(`${m[1]}.${m[2]}`, null);
  }
  syncTell();
}));
function useSync() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    SYNC.subs.add(f);
    syncLoad();
    return () => SYNC.subs.delete(f);
  }, []);
}
function syncEvent(kind, d) {
  if (!d?.sessionId || d.from === PAGE_ID) return;
  if (kind === "seen") {
    SYNC.seen ||= {};
    if (!(Date.parse(SYNC.seen[d.sessionId] || 0) >= Date.parse(d.at))) SYNC.seen[d.sessionId] = d.at;
  } else {
    SYNC.drafts ||= {};
    if (d.text) SYNC.drafts[d.sessionId] = { text: d.text, at: d.at };
    else delete SYNC.drafts[d.sessionId];
    SYNC.adopt.get(d.sessionId)?.(d.text || "");
  }
  syncTell();
}
const seenOf = (sid) => SYNC.seen?.[sid] || null;
function markLooked(s) {
  const sid = s.sessionId, was = seenOf(sid);
  if (was && Date.parse(was) >= Date.parse(s.updated || 0)) return;
  (SYNC.seen ||= {})[sid] = new Date().toISOString();
  api("/api/seen", { method: "PUT", body: { sessionId: sid, from: PAGE_ID } }).catch(() => {});
  syncTell();
}
function draftPut(sid, text, wait = 600) {
  (SYNC.drafts ||= {});
  if (text) SYNC.drafts[sid] = { text, at: new Date().toISOString() };
  else delete SYNC.drafts[sid];
  clearTimeout(SYNC.put.get(sid));
  SYNC.put.set(sid, setTimeout(() => api(`/api/drafts/${encodeURIComponent(sid)}`, { method: "PUT", body: { text, from: PAGE_ID } }).catch(() => {}), wait));
}

// One answer per ask, kept outside the components so its state survives redraws:
// sending (shown after 400 ms), sent (the host took it), accepted (the session moved on), failed (with why).
const ANSWERS = new Map();
const ansKey = (sid, id) => `${sid}:${id}`;
async function answerAsk(s, a, rec) {
  const k = ansKey(s.sessionId, a.id);
  ANSWERS.set(k, { ...rec, sid: s.sessionId, id: a.id, st: "sending", at: new Date().toISOString(), why: "" });
  syncTell();
  markLooked({ ...s, updated: new Date().toISOString() });
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
  try {
    await api(`/api/sessions/${s.sessionId}/asks/${a.id}`, { method: "POST", body: rec.body, signal: ctl.signal });
    ANSWERS.set(k, { ...ANSWERS.get(k), st: "sent", sent: new Date().toISOString() });
  } catch (e) {
    const why = e.name === "AbortError" ? `${s.host || "The host"} did not confirm within 10 s.` : e.message;
    ANSWERS.set(k, { ...ANSWERS.get(k), st: "failed", why });
  }
  clearTimeout(t);
  syncTell();
}

function askSpec(s, a) {
  if (a.permission) {
    const cmd = (a.patterns || []).join(" ");
    return { perm: true, qs: [{ text: cmd ? `${toolName(a.permission)} wants to run:` : `${s.harness || "Claude"} wants to use ${toolName(a.permission)}.`, cmd, options: [
      { label: "Allow once", note: "it runs now and asks again next time", body: { reply: "once" } },
      ...(s.harness ? [{ label: "Always for this pattern", note: cmd ? `allows ${cmd} for this session` : "allows it for this session", body: { reply: "always" } }] : []),
      { label: "Deny", note: "it stops and waits for you", body: { reject: true } }] }] };
  }
  return { qs: (a.questions || []).map((q) => ({ text: q.question, multiple: q.multiple, custom: q.custom, options: (q.options || []).map((o) => ({ label: o.label, note: o.description !== o.label ? o.description : "" })) })) };
}
const ANSWER_VIA = { push: "the notification", widget: "the home-screen widget", web: "atc" };
const answeredElsewhere = (s) => s.answered && !ANSWERS.has(ansKey(s.sessionId, s.answered.ask)) ? s.answered : null;
const fromWhere = (x) => html` <span class="from">(from ${ANSWER_VIA[x.via] || x.via}${x.device ? ` on ${x.device}` : ""})</span>`;
const askHead = (rec) => rec.i ? html`You answered <b>${rec.i}, ${rec.label}</b>` : html`You answered <b>${rec.label}</b>`;

function AskState({ rec, host, retry }) {
  if (rec.st === "sending") return html`<div class="ast" role="status"><span class="slow">Sending ${rec.i ? `${rec.i}, ${rec.label}` : "your answer"} to ${host || "the host"}</span></div>`;
  if (rec.st === "sent") return html`<div class="ast" role="status"><b>Sent ${txClock(rec.sent)}.</b> Waiting for the agent to take it.</div>`;
  if (rec.st === "accepted") return html`<div class="ast" role="status"><b>Accepted.</b> ${rec.deny ? "It stopped and waits for you." : "It is working on it."}</div>`;
  if (rec.st === "failed") return html`<div class="ast failed" role="alert"><b>Not sent.</b> <span>${/[.!?]$/.test(rec.why) ? rec.why : `${rec.why}.`} Your choice is kept.</span><button class="btn" ref=${focusOnMount} onClick=${retry}>Retry</button></div>`;
  return null;
}

function AnsweredLine({ q, cmd, options, chosen = [], line, state }) {
  const [open, setOpen] = useState(false);
  return html`<div class="ask line ${open ? "open" : ""}">
    <button class="adl" aria-expanded=${open} onClick=${() => setOpen(!open)}><span class="chev" aria-hidden="true"></span><span>${line}</span></button>
    ${state}
    ${open && html`<div class="adx"><p class="aq">${q}</p>${cmd && html`<code class="cmd">${cmd}</code>`}<div class="opts">${options.map((o, i) => html`
      <div class="opt ${chosen.includes(i) ? "ch" : ""}"><span class="k">${i + 1}</span><span><span class="lb">${o.label}</span>${o.note && html`<span class="nt">${o.note}</span>`}</span></div>`)}</div></div>`}
  </div>`;
}

function Ask({ s, a, say, keyRef = { current: null }, onType, compact, sheet }) {
  useSync();
  const spec = askSpec(s, a), rec = ANSWERS.get(ansKey(s.sessionId, a.id));
  const locked = rec && rec.st !== "failed";
  const [picked, setPicked] = useState([]);
  const [typed, setTyped] = useState([]);
  useEffect(() => { setPicked([]); setTyped([]); }, [a.id]);
  const one = spec.qs.length === 1 && !spec.qs[0].multiple;
  const go = (body, i, label, q) => answerAsk(s, a, { body, i, label, q, cmd: spec.qs[0].cmd, perm: !!spec.perm, deny: !!body.reject, options: spec.qs[0].options });
  const pick = (qi, i) => {
    const q = spec.qs[qi], o = q?.options[i];
    if (!o || locked) return;
    if (one) return go(o.body || { answers: [[o.label]] }, i + 1, o.label, q.text);
    const cur = picked[qi] || [];
    const next = q.multiple ? (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]) : cur.includes(i) ? [] : [i];
    setPicked(Object.assign([...picked], { [qi]: next }));
  };
  const answers = () => spec.qs.map((q, qi) => [...(picked[qi] || []).map((i) => q.options[i].label), ...(typed[qi]?.trim() ? [typed[qi].trim()] : [])]);
  const ready = answers().every((x) => x.length);
  const sendAll = () => ready && go({ answers: answers() }, 0, answers().map((x) => x.join(", ")).join("; "), spec.qs.map((q) => q.text).join(" "));
  keyRef.current = locked ? null : (n) => pick(one ? 0 : Math.max(0, spec.qs.findIndex((q, qi) => !(picked[qi] || []).length)), n - 1);
  useEffect(() => () => { keyRef.current = null; }, []);
  const chosen = (qi, i) => (one ? locked && rec.i === i + 1 : (picked[qi] || []).includes(i));
  const waited = ago(s);
  const dismiss = () => go({ reject: true }, 0, "dismissed", spec.qs[0]?.text);
  if (compact) return html`<div class="ask compact ${locked ? `st-${rec.st}` : ""}" data-ask role="group" aria-label=${spec.perm ? "Permission request" : "Question"}
    onKeyDown=${(e) => { if (/^[1-9]$/.test(e.key) && !e.target.matches("input") && keyRef.current) { e.preventDefault(); e.stopPropagation(); keyRef.current(+e.key); } }}>
    ${spec.qs.map((q, qi) => html`<div class="aqb">
      <div class="aq">${q.text}</div>
      ${q.cmd && html`<code class="cmd">${q.cmd}</code>`}
      <div class="acts" role="group" aria-label="Answers">
        ${q.options.map((o, i) => html`<button class="btn ${spec.perm && i === 0 && !rec ? "primary" : ""} ${chosen(qi, i) ? "ch" : ""}" disabled=${locked && !chosen(qi, i)}
          aria-pressed=${one ? null : chosen(qi, i)} aria-keyshortcuts=${i < 9 ? String(i + 1) : null} title=${o.note} onClick=${() => pick(qi, i)}><kbd aria-hidden="true">${i + 1}</kbd>${o.label}</button>`)}
        ${q.custom && !locked && html`<input class="atype" value=${typed[qi] || ""} placeholder="Or type an answer" aria-label="Or type an answer"
          onInput=${(e) => setTyped(Object.assign([...typed], { [qi]: e.target.value }))}
          onKeyDown=${(e) => { if (e.key === "Enter" && one && typed[qi]?.trim()) go({ answers: [[typed[qi].trim()]] }, 0, typed[qi].trim(), q.text); }} />`}
      </div></div>`)}
    ${!one && !locked && html`<div class="acts"><button class="btn primary" disabled=${!ready} onClick=${sendAll}>Send answers</button></div>`}
    ${rec && html`<${AskState} rec=${rec} host=${s.host} retry=${() => answerAsk(s, a, rec)} />`}
  </div>`;
  return html`<div class="ask rows ${locked ? `st-${rec.st}` : "focus"}" id=${sheet ? null : "pending-ask"} tabindex="-1" data-ask role="group" aria-label=${spec.perm ? "Permission request" : "Question"}>
    ${!sheet && html`<div class="who2"><span>Waiting on you${waited && waited !== "now" ? `, ${waited}` : ""}${spec.perm ? ": run a command" : ""}</span>
      ${!spec.perm && !locked && html`<button class="kb" onClick=${dismiss}>Dismiss</button>`}</div>`}
    ${spec.qs.map((q, qi) => html`<div class="aqb">
      <div class="aq ${spec.perm ? "ui" : ""}">${q.text}</div>
      ${q.cmd && html`<code class="cmd">${q.cmd}</code>`}
      <div class="opts" role="group" aria-label="Answers">
        ${q.options.map((o, i) => html`<button class="opt ${chosen(qi, i) ? "ch" : ""}" disabled=${locked && !chosen(qi, i)} aria-disabled=${locked ? "true" : null}
          aria-pressed=${one ? null : chosen(qi, i)} aria-keyshortcuts=${i < 9 ? String(i + 1) : null} onClick=${() => pick(qi, i)}>
          <kbd aria-hidden="true">${i + 1}</kbd><span><span class="lb">${o.label}</span>${o.note && html`<span class="nt">${o.note}</span>`}</span></button>`)}
        ${!spec.perm && !locked && (one ? onType && html`<button class="opt type" onClick=${onType}><kbd aria-hidden="true"></kbd><span><span class="lb">Or type an answer</span></span></button>`
          : q.custom && html`<label class="opt type"><kbd aria-hidden="true"></kbd><input value=${typed[qi] || ""} placeholder="Or type an answer" onInput=${(e) => setTyped(Object.assign([...typed], { [qi]: e.target.value }))} /></label>`)}
      </div></div>`)}
    ${!one && !locked && html`<div class="acts"><button class="btn prime" disabled=${!ready} onClick=${sendAll}>Send answers</button></div>`}
    ${rec && html`<${AskState} rec=${rec} host=${s.host} retry=${() => answerAsk(s, a, rec)} />`}
  </div>`;
}

const VERB = { Read: "read", Grep: "grep", Glob: "glob", Edit: "edit", MultiEdit: "edit", Write: "write", NotebookEdit: "edit", Bash: "bash", WebFetch: "fetch", WebSearch: "search", Agent: "agent", Task: "agent", AskUserQuestion: "asked" };
function stepNote(st, s) {
  const i = st.input || {}, path = i.file_path || i.notebook_path;
  let v = VERB[st.tool] || toolName(st.tool).toLowerCase(), c = st.detail || "", n = "";
  if (st.tool === "Read") { c = relPath(path || st.detail, s); n = i.offset ? (i.limit ? `lines ${i.offset} to ${i.offset + i.limit}` : `from line ${i.offset}`) : ""; }
  else if (st.tool === "Grep" || st.tool === "Glob") { c = i.pattern || st.detail; n = i.path ? `in ${relPath(i.path, s)}` : ""; }
  else if (txKind(st) === "edit") { const d = diffStat(st); c = relPath(path || st.detail, s); n = st.tool === "Write" ? `new, ${d.add} lines` : `+${d.add} -${d.del}`; }
  else if (st.tool === "Bash") {
    if (st.badge) { v = st.badge.kind; c = badgeLabel(st.badge); }
    else { c = (i.command || st.detail || "").split("\n")[0].replace(/^cd \S+ && /, ""); n = i.description || ""; }
  }
  else if (st.tool === "WebSearch") c = i.query || st.detail;
  else if (st.tool === "WebFetch") c = hostOf(i.url || st.detail);
  else if (txKind(st) === "agent") c = i.description || st.detail;
  else if (st.tool === "AskUserQuestion") c = "a question";
  const bad = !!st.out?.error || st.badge?.ok === false;
  return { v, c, n: bad ? "failed" : n, bad };
}
const groupSpan = (steps) => {
  const a = Date.parse(steps[0]?.time || 0), b = Math.max(...steps.map((x) => Date.parse(x.out?.time || x.time || 0)));
  return a && b - a >= 1000 ? txSpan(b - a) : "";
};
const groupHead = (steps) => `${plural(steps.length, "step")}${groupSpan(steps) ? `, ${groupSpan(steps)}` : ""}`;

const InlineSteps = ({ steps, open, toggle, at }) => {
  const failed = steps.filter((x) => x.out?.error || x.badge?.ok === false).length;
  return html`<button class="inl-steps" aria-expanded=${open} onClick=${toggle} title=${open ? "Fold the steps" : "Show every step"}><span class="chev" aria-hidden="true"></span><span class="h">${groupHead(steps)}</span>${failed > 0 && html`<b>${failed} failed</b>`}<span class="v">${[...new Set(steps.map((x) => VERB[x.tool] || toolName(x.tool).toLowerCase()))].join(", ")}</span>${at && html`<time>${at}</time>`}</button>`;
};

function Edits({ steps, s }) {
  const files = new Map();
  for (const st of steps) {
    const p = st.input.file_path || st.detail, f = files.get(p) || { p, add: 0, del: 0, edits: [], n: 0, write: false }, d = diffStat(st);
    f.add += d.add; f.del += d.del; f.n += st.n || 1;
    if (st.tool === "Write") { f.write = true; f.edits.push({ old: "", new: st.input.content || "", line: 1 }); }
    else f.edits.push(...(st.edits || txEdits(st)));
    files.set(p, f);
  }
  const [open, setOpen] = useState(() => new Set());
  const list = [...files.values()].sort(byKeep), add = list.reduce((a, f) => a + f.add, 0), del = list.reduce((a, f) => a + f.del, 0);
  const flip = (p) => setOpen((o) => { const n = new Set(o); n.has(p) ? n.delete(p) : n.add(p); return n; });
  return html`<div class="edits"><div class="eh"><b>Edited ${plural(list.length, "file")}</b><span class="plus">+${add}</span>${del > 0 && html`<span class="minus">-${del}</span>`}</div>
    <ul class="ef">${list.map((f) => html`<li class=${open.has(f.p) ? "open" : ""}>
      <button aria-expanded=${open.has(f.p)} onClick=${() => flip(f.p)}><span class="chev" aria-hidden="true"></span><span class="f"><bdi>${relPath(f.p, s)}</bdi></span>
        <span><span class="plus">${f.add ? `+${f.add}` : ""}</span> <span class="minus">${f.del ? `-${f.del}` : ""}</span></span><span class="n">${f.write ? "new file" : f.n > 1 ? `${f.n} edits` : ""}</span></button>
      ${open.has(f.p) && html`<${Diff} edits=${f.edits} cap=${f.write ? 60 : 400} />`}</li>`)}</ul></div>`;
}

function GroupBody({ steps, s, open, zoom, live }) {
  if (open) return html`<div class="steps">${steps.map((x) => html`<${Step} key=${x.id} st=${x} s=${s} zoom=${zoom} pin=${live && x === steps[steps.length - 1]} />`)}</div>`;
  const edits = steps.filter((x) => txKind(x) === "edit" && !x.out?.error);
  return html`${edits.length > 0 && html`<${Edits} steps=${edits} s=${s} />`}
    ${steps.filter((x) => txKind(x) === "ask" || (x.tool === "Bash" && x.badge?.kind === "show")).map((x) => html`<${Step} key=${x.id} st=${x} s=${s} zoom=${zoom} />`)}`;
}

function agentRows(b) {
  const rows = [], items = joinEdits(numberEdits(b.items));
  let g = [];
  const flush = () => { if (g.length) rows.push({ k: "steps", steps: g, at: g[0].time }); g = []; };
  for (const it of items) {
    if (it.t === "step") { if (!TX_NOISE.test(it.tool)) g.push(it); continue; }
    flush();
    if (it.t === "text") rows.push({ k: "say", text: it.text, at: it.time });
    else rows.push({ k: it.t === "note" ? "note" : "evt", text: it.text, at: it.time });
  }
  flush();
  if (b.answer) rows.push({ k: "say", text: b.answer, at: b.answerAt || rows[rows.length - 1]?.at, answer: true });
  const out = [];
  for (let j = 0; j < rows.length; j++) {
    if (rows[j].k === "steps" && rows[j + 1]?.k === "say") { out.push({ ...rows[j + 1], steps: rows[j].steps, at: rows[j].at || rows[j + 1].at }); j++; }
    else out.push(rows[j]);
  }
  return out;
}

const unesc = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const cleanPrompt = (t) => unesc(t || "").replace(/\[Image #\d+\]\s*/g, "");
function Lead({ text, images, files, at }) {
  const [all, setAll] = useState(false);
  const long = text.length > 600 || text.split("\n").length > 8;
  return html`<div class="lead"><div class="lead-at">you ${at}</div><p class=${long && !all ? "clamp" : ""}>${text}</p>
    ${long && html`<button class="kb more" onClick=${() => setAll(!all)}>${all ? "Show less" : "Show all"}</button>`}
    ${files > 0 && html`<span class="attl">${plural(files, "attachment")}</span>`}
    ${(images || []).length > 0 && html`<span class="imgs">${images.map((src) => html`<img src=${src} alt="Image you attached" />`)}</span>`}</div>`;
}

function Prose({ text, id }) {
  const h = useMemo(() => { let j = 0; return md(text).replace(/<h([1-4])>/g, (_, n) => `<h${n} id="${id}h${j++}">`); }, [text]);
  return html`<div class="prose" dangerouslySetInnerHTML=${{ __html: h }}></div>`;
}

function LiveRow({ s, step, since, steps }) {
  useNow(1000);
  const at = step?.time || since, ms = at ? Date.now() - new Date(at) : 0, m = step && stepNote(step, s);
  const what = m ? `${m.v} ${m.c}` : s.activity ? doing(s) : "Thinking";
  return html`<div class="work" id="tx-now" role="status"><i class="pulse" aria-hidden="true"></i><span class="doing">${what}</span>
    <span class="el">${[ms >= 1000 && txSpan(ms), steps > 0 && `step ${steps}`].filter(Boolean).join(", ")}</span></div>`;
}

function Since({ mark, rows, s, jump }) {
  const after = (rows || []).filter(Boolean), q = s.asks?.length > 0 && s.state === "needs-you";
  const replies = after.filter((r) => r.answer).length;
  const files = new Set(after.flatMap((r) => (r.steps || []).filter((x) => txKind(x) === "edit" && !x.out?.error).map((x) => x.input.file_path))).size;
  const pages = after.flatMap((r) => r.steps || []).filter((x) => x.badge?.kind === "show").length;
  const counts = [replies && (replies === 1 ? "a reply" : `${replies} replies`), files && plural(files, "file"), pages && (pages === 1 ? "a page" : `${pages} pages`), q && "1 question"].filter(Boolean).join(", ");
  const sum = s.summary, sumAt = sum?.at ? Date.parse(sum.at) || 0 : 0, last = Math.max(0, ...after.map((r) => Date.parse(r.at || 0) || 0));
  const now = s.state === "working" && s.activity ? `Now ${doing(s).replace(/^./, (c) => c.toLowerCase())}` : "";
  const gist = (sum?.status || "").replace(/^[A-Z][a-z]+:\s+/, "") || (now.length > 90 ? now.slice(0, 88).replace(/\s+\S*$/, "") + "..." : now);
  return html`<div class="snc" id="since" tabindex="-1"><h2 class="l">Since you last looked, ${txClock(mark)}</h2>
    ${(gist || counts) && html`<p class="cu">${gist && html`<b>${gist.replace(/^./, (c) => c.toUpperCase())}${/[.!?]$/.test(gist) ? "" : "."}</b> `}${counts && counts.replace(/^./, (c) => c.toUpperCase()) + "."}</p>`}
    ${sumAt > 0 && last > sumAt && html`<p class="sm">Summary from ${txClock(sum.at)}; what came after is not in it yet.</p>`}
    ${q && html`<div class="acts"><button class="btn" onClick=${jump}>Jump to the question <kbd aria-hidden="true">N</kbd></button></div>`}</div>`;
}

function Queued({ p, edit, cancel, now, undo }) {
  if (p.state === "cancelled") return html`<div class="queued gone" role="status"><span>Cancelled. It was not sent.</span><button class="btn" onClick=${undo}>Undo</button></div>`;
  return html`<div class="queued" role="status"><div class="qh"><b>Queued</b><span>sends when it stops</span>
    <span class="acts"><button class="btn" onClick=${now}>Send now</button><button class="btn" onClick=${edit}>Edit</button><button class="btn" onClick=${cancel}>Cancel</button></span></div>
    <p class="qt">${unpathed(p.text)}</p>${(p.text.match(UPLOADED) || []).length > 0 && html`<p class="qa">${plural((p.text.match(UPLOADED) || []).length, "attachment")}</p>`}</div>`;
}

function SentState({ p, host, retry, edit }) {
  if (p.state === "sending") return html`<div class="mst" role="status"><span class="slow">Sending to ${host || "the host"}</span></div>`;
  if (p.state === "failed") return html`<div class="mst failed" role="alert"><b>Not sent.</b> <span>${p.err}</span><span class="acts"><button class="btn" onClick=${retry}>Retry</button><button class="btn" onClick=${edit}>Edit</button></span></div>`;
  return html`<div class="mst" role="status"><b>Sent ${txClock(new Date(p.sent || p.at).toISOString())}.</b> ${p.queued ? "Claude reads it after its current step." : "It has it."}</div>`;
}
const headsOf = (src) => [...(src || "").matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => plain(m[1]));

let TX_API = null;
const shortDay = (ts) => new Date(ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const msOf = (at) => (at ? Date.parse(at) || 0 : 0);

function Transcript({ s, say, resume, busy, voice, onVoiceOff, cmp = {} }) {
  useSync();
  const sid = s.sessionId;
  const [idx, setIdx] = useState(null);
  const [bodies, setBodies] = useState({});
  const [err, setErr] = useState(null);
  const [prefs, setPrefsRaw] = useState(txPrefs.get);
  const [pop, setPop] = useState(null);
  const [opened, setOpened] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [contents, setContentsRaw] = useState(() => txStore.get("contents", false));
  const [level, setLevelRaw] = useState(() => txStore.get("level", 2));
  const setLevel = (l) => { setLevelRaw(l); txStore.set("level", l); say(["Outline: one line per turn", "Story: earlier turns folded", "Everything: every turn and step open"][l - 1]); };
  const [sel, setSel] = useState(null);
  const [below, setBelow] = useState(false);
  const [fresh, setFresh] = useState(0);
  const [shot, setShot] = useState(null);
  const [drop, setDrop] = useState(false);
  const [pending, setPendingRaw] = useState(() => pendingOf(sid));
  const setPending = (f) => setPendingRaw((ps) => { const n = typeof f === "function" ? f(ps) : f; txStore.set(`pending.${sid}`, n.length ? n : null); return n; });
  const [draft, setDraftRaw] = useState(() => SYNC.drafts?.[sid]?.text || "");
  const setDraft = (v) => setDraftRaw((d) => { const n = typeof v === "function" ? v(d) : v; if (n !== d) draftPut(sid, n); return n; });
  const [quotes, setQuotes] = useState([]);
  const box = useRef(), landed = useRef(false), atEnd = useRef(false), hold = useRef(null), loading = useRef(new Set());
  const focusInput = useRef(() => {}), uploadRef = useRef(null), findQ = useRef(""), askKey = useRef(null), mark = useRef(undefined);
  const live = s.attachable || s.harness === "opencode";
  const working = s.state === "working" && !s.turnDone;
  const asking = s.state === "needs-you" && s.asks?.length > 0 ? s.asks[0] : null;
  const turns = idx || [];
  const stream = useHubStream(s, () => loadIdx());
  const setContents = (v) => { setContentsRaw(v); txStore.set("contents", v); };

  const loadIdx = async () => {
    try {
      const r = await api(`/api/sessions/${sid}/turns`);
      setIdx(r.turns || []);
      setErr(null);
    } catch (e) { setErr(e.message); setIdx((x) => x || []); }
  };
  const need = async (i) => {
    const t = turns[i];
    if (!t) return;
    const have = bodies[t.from], key = `${t.from}:${t.to}`;
    if ((have && have.to === t.to) || loading.current.has(key)) return;
    loading.current.add(key);
    try {
      const p = await api(`/api/sessions/${sid}/transcript?from=${t.from}&to=${t.to}`);
      setBodies((b) => (b[t.from]?.to > t.to ? b : { ...b, [t.from]: { to: t.to, ...bodyOf(p.messages || []) } }));
    } catch (e) { setErr(e.message); }
    loading.current.delete(key);
  };

  useEffect(() => {
    landed.current = false; mark.current = undefined;
    setIdx(null); setBodies({}); setOpened(new Set()); setExpanded(new Set()); setPendingRaw(pendingOf(sid)); setQuotes([]);
    setDraftRaw(SYNC.drafts?.[sid]?.text || "");
    loadIdx();
  }, [sid]);
  useEffect(() => { if (SYNC.drafts && !draft) setDraftRaw(SYNC.drafts[sid]?.text || ""); }, [SYNC.drafts !== null, sid]);
  useEffect(() => {
    SYNC.adopt.set(sid, (text) => { if (!document.activeElement?.closest?.(".cmp")) setDraftRaw(text); });
    return () => SYNC.adopt.delete(sid);
  }, [sid]);
  useEffect(() => { if (idx) loadIdx(); }, [s.updated, s.state]);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(loadIdx, 10000);
    return () => clearInterval(t);
  }, [working, sid]);
  if (mark.current === undefined && SYNC.seen) mark.current = seenOf(sid);
  const markMs = msOf(mark.current);

  const firstOpen = useMemo(() => {
    const n = turns.length;
    if (!n || !SYNC.seen) return Math.max(0, n - 1);
    const i = markMs ? turns.findIndex((t) => !t.partial && msOf(t.end || t.at) > markMs) : -1;
    return i < 0 ? n - 1 : Math.max(i, n - 12);
  }, [turns.length > 0, sid, SYNC.seen !== null]);
  const isOpen = (i) => (level === 3 || (level === 2 && i >= firstOpen) || opened.has(i));
  const openTurn = (i) => setOpened((o) => new Set(o).add(i));
  const flip = (k) => setExpanded((o) => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n; });

  useEffect(() => { for (let i = level === 3 ? 0 : firstOpen; i < turns.length; i++) if (isOpen(i)) need(i); }, [idx, firstOpen, level]);
  useEffect(() => { opened.forEach((i) => need(i)); }, [opened]);
  useEffect(() => {
    if (!pending.length || !idx) return;
    const head = (p) => plain(unpathed(p.text)).slice(0, 24);
    const said = (t) => plain(cleanPrompt(t.prompt));
    const there = (p) => turns.some((t) => (t.at && new Date(t.at) >= p.at - 60000 && (head(p) ? said(t).startsWith(head(p)) : t.images > 0 || /\[Image #\d+\]/.test(t.prompt))) || (head(p) && (t.notes || []).some((n) => plain(n).startsWith(head(p)))));
    const passed = (p) => turns.some((t) => t.at && new Date(t.at) > p.at + 60000);
    const stale = (p) => passed(p) || (!working && Date.now() - p.at > 5 * 60e3);
    const gone = (p) => (p.state === "sending" || p.state === "sent") && (there(p) || (p.state === "sent" && stale(p)));
    if (pending.some(gone)) setPending((ps) => ps.filter((p) => !gone(p)));
  }, [idx, pending]);

  useEffect(() => {
    const f = TX_FACES[prefs.face] || TX_FACES.lit, st = box.current?.parentElement?.style;
    if (!st) return;
    st.setProperty("--rf", f.css);
    st.setProperty("--rs", `${f.sizes[prefs.size]}px`);
    st.setProperty("--rl", f.lh);
    st.setProperty("--rw", `${TX_MEASURES[prefs.width]}px`);
  }, [prefs, idx !== null]);
  useEffect(() => {
    const f = (e) => setPrefsRaw(e.detail);
    addEventListener("atc-txprefs", f);
    return () => removeEventListener("atc-txprefs", f);
  }, []);

  const deliver = async (p) => {
    setPending((ps) => [...ps.filter((x) => x.id !== p.id), { ...p, state: "sending", queued: working }]);
    try {
      await api(`/api/sessions/${s.id || sid}/send`, { method: "POST", body: { text: p.text, suggested: p.suggested, voice: p.voice } });
      setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, state: "sent", sent: Date.now() } : x)));
      setTimeout(loadIdx, 1500);
    } catch (e) {
      setPending((ps) => ps.map((x) => (x.id === p.id ? { ...x, state: "failed", err: e.message } : x)));
    }
  };
  const send = async (text, { suggested, voice: v } = {}) => {
    const a = s.asks?.[0];
    if (a?.permission && !s.harness) { say("Answer the request above first: Allow once or Deny."); return false; }
    if (a && !a.permission) {
      if (a.questions?.length !== 1) { say("Answer the questions above first."); return false; }
      answerAsk(s, a, { body: { answers: [[text]] }, i: 0, label: text, q: a.questions[0].question, options: (a.questions[0].options || []).map((o) => ({ label: o.label, note: "" })) });
      return true;
    }
    letGo();
    atEnd.current = true;
    const p = { id: Math.random().toString(36).slice(2), text, at: Date.now(), suggested, voice: v };
    if (working && !v) { setPending((ps) => [...ps, { ...p, state: "queued" }]); return true; }
    deliver(p);
    return true;
  };
  const queued = pending.filter((p) => p.state === "queued" || p.state === "cancelled");
  useEffect(() => { if (!working && idx) pending.filter((p) => p.state === "queued").forEach(deliver); }, [working, idx !== null]);
  useEffect(() => {
    const out = () => pendingOf(sid).filter((p) => p.state === "queued").forEach((p) => navigator.sendBeacon?.(`/api/sessions/${s.id || sid}/send`, new Blob([JSON.stringify({ text: p.text })], { type: "application/json" })) && setPending((ps) => ps.filter((x) => x.id !== p.id)));
    addEventListener("pagehide", out);
    return () => {
      removeEventListener("pagehide", out);
      const all = pendingOf(sid), held = all.filter((p) => p.state === "queued");
      held.forEach((p) => api(`/api/sessions/${s.id || sid}/send`, { method: "POST", body: { text: p.text } }).catch(() => {}));
      if (held.length) txStore.set(`pending.${sid}`, all.map((p) => (p.state === "queued" ? { ...p, state: "sending", queued: true } : p)));
    };
  }, [sid]);
  const interrupt = () => api(`/api/sessions/${s.id || sid}/keys`, { method: "POST", body: { keys: "\x1b" } }).then(() => say("Stopped its turn. Nothing after that ran."), (e) => say(`Couldn't stop it: ${e.message}`));

  useEffect(() => {
    let moved = false;
    for (const [k, r] of ANSWERS) if (r.sid === sid && r.st === "sent" && (s.asks?.[0]?.id !== r.id || s.state !== "needs-you")) { ANSWERS.set(k, { ...r, st: "accepted" }); moved = true; }
    if (moved) syncTell();
  }, [s.asks?.[0]?.id, s.state]);

  const settle = () => {
    const el = box.current, target = hold.current && el?.querySelector(hold.current);
    if (!el) return;
    if (!target) { if (atEnd.current) el.scrollTop = el.scrollHeight; return; }
    const max = el.scrollHeight - el.clientHeight, to = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16;
    el.scrollTop = Math.min(to, max);
    atEnd.current = to >= max - 60;
  };
  const letGo = () => { hold.current = null; };
  const openBodies = turns.filter((_, i) => isOpen(i) && i >= firstOpen).map((t) => bodies[t.from]);
  const ready = idx && SYNC.seen && openBodies.every(Boolean);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !idx) return;
    if (!landed.current && ready) {
      landed.current = true;
      const latest = [...el.querySelectorAll("[data-you], [data-said]")].pop();
      hold.current = el.querySelector("#since") ? "#since" : latest ? `#${CSS.escape(latest.id)}` : null;
      settle();
      document.fonts.ready.then(() => requestAnimationFrame(settle));
      if (atEnd.current) markLooked(s);
      if (!touch && document.activeElement === document.body) el.focus({ preventScroll: true });
    } else if (landed.current) settle();
  }, [idx, bodies, ready, pending]);
  useEffect(() => { if (landed.current && atEnd.current) markLooked(s); }, [s.updated]);
  useEffect(() => { if (!touch && landed.current && !pop && document.activeElement === document.body) box.current?.focus({ preventScroll: true }); });

  useEffect(() => {
    const el = box.current, inner = el?.querySelector(".read");
    if (!inner) return;
    let h = 0;
    const ro = new ResizeObserver(() => {
      if (landed.current && (hold.current !== null || atEnd.current)) settle();
      else if (landed.current && el.scrollHeight > h + 40) setFresh((n) => n + 1);
      h = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [idx !== null]);

  useEffect(() => {
    if (!pop) return;
    const off = (e) => !e.target.closest(".pop") && setPop(null);
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [pop]);

  const scrollTo = (el, smooth = true) => {
    const sc = box.current;
    if (!el || !sc) return;
    letGo();
    sc.scrollTo({ top: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12, behavior: smooth ? "smooth" : "instant" });
  };
  const step = (sel, d) => {
    const sc = box.current;
    if (!sc) return;
    const top = sc.getBoundingClientRect().top + 14, list = [...sc.querySelectorAll(sel)];
    const t = d > 0 ? list.find((e) => e.getBoundingClientRect().top > top + 2) : list.reverse().find((e) => e.getBoundingClientRect().top < top - 2);
    if (t) scrollTo(t);
  };
  const nextUnseen = () => {
    const sc = box.current, since = sc?.querySelector("#since"), q = sc?.querySelector("#pending-ask");
    const top = sc?.getBoundingClientRect().top, canScroll = sc && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2;
    const ahead = (e) => e && canScroll && e.getBoundingClientRect().top > top + 20;
    if (ahead(since)) return scrollTo(since);
    if (q && document.activeElement !== q && !q.contains(document.activeElement)) { scrollTo(q); return q.focus({ preventScroll: true }); }
    markLooked({ ...s, updated: new Date().toISOString() });
    say(`Nothing new since ${txClock(mark.current || new Date().toISOString()) || "you last looked"}.`);
  };
  const go = (i, instant, q) => {
    letGo();
    if (!isOpen(i)) openTurn(i);
    need(i);
    const jump = (n = 0) => requestAnimationFrame(() => {
      const el = box.current?.querySelector(`#tx${i}`);
      if (!el) return n < 20 && setTimeout(() => jump(n + 1), 100);
      scrollTo(el, !instant);
      if (q) { if (el.parentElement.querySelector(".prose") || n > 20) highlight(box.current.querySelector(".read"), q); else setTimeout(() => jump(n + 1), 150); }
    });
    jump();
  };
  TX_API = { level: () => setLevel((level % 3) + 1), find: () => { findQ.current = ""; setPop("find"); }, results: () => setPop("results"), contents: () => setContents(!contents) };
  useEffect(() => () => { TX_API = null; }, []);

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector(".veil, .pghome, .palone, .keys-ov, .sheet")) return;
      const k = e.key;
      if (/^[1-9]$/.test(k)) { if (askKey.current && t.closest?.(".ask")) { e.preventDefault(); askKey.current(+k); } }
      else if (k === "J" || k === "K") { e.preventDefault(); step("[data-stop]", k === "J" ? 1 : -1); }
      else if (k === "N") { e.preventDefault(); nextUnseen(); }
      else if (k === "c") { e.preventDefault(); setContents(!contents); }
      else if (k === "l") { e.preventDefault(); setLevel((level % 3) + 1); }
      else if (k === "Enter" && live && !t.closest?.("button, a, [role=button], .ask, [data-ask]")) { e.preventDefault(); focusInput.current(); }
      else if (k === "Enter" && !live && resume && s.kind !== "interactive" && !t.closest?.("button, a, [role=button]")) { e.preventDefault(); resume(); }
      else if (k === "f") { e.preventDefault(); findQ.current = ""; setPop("find"); }
      else if (k === "Escape") { setPop(null); setShot(null); setSel(null); CSS.highlights?.delete("tx-find"); }
    };
    const onSel = () => {
      const g = getSelection(), txt = g?.toString().trim();
      const node = g?.anchorNode?.parentElement?.closest?.(".tx .read");
      if (!txt || txt.length < 2 || !node || g.anchorNode.parentElement.closest(".composer")) return setSel(null);
      const r = g.getRangeAt(0).getBoundingClientRect(), b = box.current.parentElement.getBoundingClientRect();
      const under = touch || r.top - b.top < 60;
      setSel({ text: txt, x: Math.min(b.width - 330, Math.max(8, r.left - b.left + r.width / 2 - 160)), y: under ? r.bottom - b.top + 10 : r.top - b.top - 46 });
    };
    addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSel);
    return () => { removeEventListener("keydown", onKey); document.removeEventListener("selectionchange", onSel); };
  }, [live, contents, s, level]);

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

  const last = turns[turns.length - 1], lastBody = last && bodies[last.from];
  const running = working && lastBody ? txSteps(lastBody.items).findLast((x) => !x.out) : null;
  const replies = live && !working && !pending.some((p) => p.state !== "failed") && s.state === "your-turn" && !s.asks?.length ? s.summary?.replies : null;

  const rows = [];
  const askedQs = new Set(), shownAns = new Set();
  turns.forEach((t, i) => {
    const b = bodies[t.from], open = isOpen(i);
    if (!open) return rows.push({ k: "fold", key: `f${t.from}`, at: t.at, i, t });
    rows.push({ k: t.notice ? "notice" : t.partial ? "partial" : "you", key: `y${t.from}`, at: t.at, i, t, b });
    if (!b) return (t.steps || t.reply) && rows.push({ k: "skel", key: `s${t.from}`, i });
    agentRows(b).forEach((r, j) => {
      (r.steps || []).filter((x) => x.tool === "AskUserQuestion").forEach((x) => { (x.input.questions || []).forEach((q) => askedQs.add(q.question)); Object.values(answersOf(x)).forEach((a) => shownAns.add(a)); });
      rows.push({ ...r, key: `${t.from}:${j}`, i, live: working && i === turns.length - 1 });
    });
  });
  for (const r of ANSWERS.values()) {
    if (r.sid !== sid || r.id === asking?.id || askedQs.has(r.q)) continue;
    const at = msOf(r.at), j = rows.findIndex((x) => msOf(x.at) > at);
    rows.splice(j < 0 ? rows.length : j, 0, { k: "answered", key: `a${r.id}`, at: r.at, rec: r });
  }
  const other = answeredElsewhere(s);
  if (other && other.ask !== asking?.id && !shownAns.has(other.what)) {
    const at = msOf(other.at), j = rows.findIndex((x) => msOf(x.at) > at);
    rows.splice(j < 0 ? rows.length : j, 0, { k: "elsewhere", key: `e${other.ask}`, at: other.at, x: other });
  }
  pending.filter((p) => p.state !== "queued" && p.state !== "cancelled").forEach((p) => rows.push({ k: "sent", key: `p${p.id}`, at: new Date(p.at).toISOString(), p }));
  if (stream?.text) rows.push({ k: "stream", key: "stream", st: stream });
  if (working && !stream?.text) rows.push({ k: "live", key: "live", at: new Date().toISOString() });
  if (asking) rows.push({ k: "ask", key: `q${asking.id}`, at: s.updated, a: asking });
  const di = markMs ? rows.findIndex((r) => r.at && r.k !== "live" && msOf(r.at) > markMs) : -1;
  if (di > 0) rows.splice(di, 0, { k: "since", key: "since", at: mark.current, after: rows.slice(di) });
  queued.forEach((p) => rows.push({ k: "queued", key: `qd${p.id}`, p }));

  const toc = [];
  for (const r of rows) {
    if (r.k === "you" || r.k === "fold") toc.push({ id: `tx${r.i}`, at: txClock(r.at), text: plain(cleanPrompt(r.t.prompt)) || "Image", folded: r.k === "fold", kids: [] });
    else if (r.k === "since") toc.push({ id: "since", at: txClock(r.at), text: "Since you last looked", kids: [] });
    else if (r.k === "say" && r.answer && toc.length) headsOf(r.text).forEach((h, j) => toc[toc.length - 1].kids.push({ id: `h-${r.key.replace(":", "-")}h${j}`, text: h }));
    else if (r.k === "ask" && toc.length) toc[toc.length - 1].kids.push({ id: "pending-ask", text: "Waiting on you", cls: "q" });
    else if (r.k === "live" && toc.length) toc[toc.length - 1].kids.push({ id: "tx-now", text: "now", cls: "now" });
  }

  let shownClock = "", shownDay = txDay(new Date().toISOString());
  const clock = (at, force) => {
    if (!at) return "";
    const c = txClock(at), d = txDay(at), day = d !== shownDay;
    if (!force && !day && c === shownClock) return "";
    shownClock = c; shownDay = d;
    return day ? `${shortDay(at)} ${c}` : c;
  };
  const cell = (r) => {
    const gk = `g${r.key}`, gOpen = level === 3 ? !expanded.has(gk) : expanded.has(gk);
    switch (r.k) {
      case "fold": {
        const f = (r.t.files || []).filter((x) => !scratch(x.path)).sort((a, b) => b.add + b.del - a.add - a.del)[0];
        const work = [r.t.steps > 0 && plural(r.t.steps, "step"), f && `${relPath(f.path, s)} +${f.add}${f.del ? ` -${f.del}` : ""}`, (r.t.files || []).length > 1 && `${r.t.files.length - 1} more`].filter(Boolean).join(", ");
        const who = r.t.notice ? "" : "you";
        return html`${who && html`<h2 class="sr">you, ${txClock(r.at)}</h2>`}<button class="fold ${r.t.notice ? "ntc" : ""}" id=${`tx${r.i}`} data-stop data-you=${who ? "" : null} aria-expanded="false" title="Open this turn" onClick=${() => openTurn(r.i)}>
          <span class="fy"><span class="lead-at">${who} ${clock(r.at, true)}</span><span class="fq">${r.t.partial ? "Continued from earlier" : plain(cleanPrompt(r.t.prompt)) || "Image"}</span></span>
          <span class="g">${r.t.reply ? firstSentence(r.t.reply) : "No reply."} ${work && html`<b>${work}</b>`}</span></button>`;
      }
      case "you": {
        const first = rows[0] === r;
        return html`<div class="sec ${first ? "first" : ""}" id=${`tx${r.i}`} data-stop data-you><h2 class="sr">you, ${txClock(r.at)}</h2>
          <${Lead} at=${clock(r.at, true)} text=${cleanPrompt(r.b?.prompt ?? r.t.prompt).trim()} images=${r.b?.images} /></div>`;
      }
      case "notice": return html`<p class="evt" id=${`tx${r.i}`}>${plain(cleanPrompt(r.t.prompt))}</p>`;
      case "partial": return html`<p class="evt" id=${`tx${r.i}`}>This turn started before what is loaded here.</p>`;
      case "skel": return html`<div class="skel" aria-label="Loading"><i></i><i></i><i></i></div>`;
      case "say": case "steps":
        return html`${r.answer && html`<h2 class="sr">${s.agent ? `@${s.agent}` : "agent"}, ${txClock(r.at)}</h2>`}${r.steps && html`<${InlineSteps} steps=${r.steps} at=${clock(r.at)} open=${gOpen} toggle=${() => flip(gk)} /><${GroupBody} steps=${r.steps} s=${s} open=${gOpen} zoom=${setShot} live=${r.live && !r.text} />`}
            ${r.text && html`<div id=${`said-${r.key}`} data-said data-stop=${r.answer ? "" : null}><${Prose} text=${r.text} id=${`h-${r.key.replace(":", "-")}`} /></div>`}`;
      case "evt": return html`<p class="evt">${r.text}</p>`;
      case "note": return html`<${Lead} at=${clock(r.at, true)} text=${r.text} />`;
      case "answered": {
        const rec = r.rec;
        return html`<${AnsweredLine} q=${rec.q} cmd=${rec.cmd} options=${rec.options || []} chosen=${rec.i ? [rec.i - 1] : []}
          line=${html`${askHead(rec)}, ${txClock(rec.at)} <span class="from">(from this screen)</span>`} state=${rec.st !== "accepted" && html`<${AskState} rec=${rec} host=${s.host} retry=${() => answerAsk(s, { id: rec.id }, rec)} />`} />`;
      }
      case "elsewhere": return html`<div class="ask line"><p class="adl"><span>You answered <b>${r.x.what}</b>, ${txClock(r.x.at)}${fromWhere(r.x)}</span></p></div>`;
      case "since": return html`<${Since} mark=${r.at} rows=${r.after} s=${s} jump=${nextUnseen} />`;
      case "sent": {
        const first = rows[0] === r;
        return html`<div class="sec ${first ? "first" : ""}" data-stop data-you id=${`tx-p${r.p.id}`}>
          <${Lead} at=${clock(r.at, true)} text=${unpathed(r.p.text)} files=${(r.p.text.match(UPLOADED) || []).length} />
          <${SentState} p=${r.p} host=${s.host} retry=${() => deliver(r.p)} edit=${() => { setPending((ps) => ps.filter((x) => x.id !== r.p.id)); setDraft((d) => [unpathed(r.p.text), d].filter(Boolean).join("\n")); focusInput.current(); }} /></div>`;
      }
      case "stream": return html`${HUB_CHANNEL[r.st.channel] && html`<p class="evt">${HUB_CHANNEL[r.st.channel]}</p>`}<div class="prose live" dangerouslySetInnerHTML=${{ __html: md(r.st.text) + '<span class="caret"></span>' }}></div>`;
      case "live": return html`<${LiveRow} s=${s} step=${running} since=${lastAt(lastBody) || last?.end} steps=${last?.steps || 0} />`;
      case "ask": return html`<${Ask} s=${s} a=${r.a} keyRef=${askKey} onType=${() => focusInput.current()} />`;
      case "queued": return html`<${Queued} p=${r.p} now=${() => deliver(r.p)}
        edit=${() => { setPending((ps) => ps.filter((x) => x.id !== r.p.id)); setDraft((d) => [d, unpathed(r.p.text)].filter(Boolean).join("\n")); focusInput.current(); }}
        cancel=${() => { setPending((ps) => ps.map((x) => (x.id === r.p.id ? { ...x, state: "cancelled" } : x))); setTimeout(() => setPending((ps) => ps.filter((x) => !(x.id === r.p.id && x.state === "cancelled"))), 8000); }}
        undo=${() => setPending((ps) => ps.map((x) => (x.id === r.p.id ? { ...x, state: "queued" } : x)))} />`;
    }
    return null;
  };

  const dropIn = (e) => { if (live && e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDrop(true); } };
  return html`<div class="tx-wrap ${contents ? "with-toc" : ""}" onDragEnter=${dropIn} onDragOver=${dropIn}
    onDragLeave=${(e) => !e.currentTarget.contains(e.relatedTarget) && setDrop(false)}
    onDrop=${(e) => { if (!drop) return; e.preventDefault(); setDrop(false); uploadRef.current?.([...e.dataTransfer.files]); }}>
    <div class="txv"><div class="tx" ref=${box} tabindex="0" aria-label=${`Transcript of ${s.title || "this session"}`} onWheel=${letGo} onTouchStart=${letGo} onPointerDown=${letGo}
      onScroll=${(e) => { const el = e.target; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; setBelow(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 0.6); if (atEnd.current) { setFresh(0); if (landed.current) markLooked(s); } setSel(null); }}>
      <div class="read">
        <article class="flow">
          ${err && html`<p class="evt fail" role="alert"><b>Couldn't load the transcript.</b> ${err}</p>`}
          ${idx === null && !err && html`<div class="skel big" aria-label="Loading"><i></i><i></i><i></i><i></i></div>`}
          ${idx && turns.length === 0 && !rows.length && html`<p class="evt">No messages yet.${live ? " Write the first one below." : ""}</p>`}
          ${rows.map((r) => html`<div class="tb" key=${r.key} data-k=${r.k}>${cell(r)}</div>`)}
        </article>
        ${contents && html`<nav class="toc" aria-label="Contents"><div class="th">Contents <button class="kb" onClick=${() => setContents(false)}>Close <kbd aria-hidden="true">c</kbd></button></div><ol>${toc.map((x) => html`<li class=${x.folded ? "folded" : ""}>
          <a href=${`#${x.id}`} onClick=${(e) => { e.preventDefault(); const n = +x.id.slice(2); if (x.folded) go(n); else scrollTo(box.current.querySelector(`#${CSS.escape(x.id)}`)); }}><time>${x.at}</time>${x.text.length > 60 ? x.text.slice(0, 56).replace(/\s+\S*$/, "") + "..." : x.text}</a>
          ${x.kids.length > 0 && html`<ul>${x.kids.map((k) => html`<li class=${k.cls || ""}><a href=${`#${k.id}`} onClick=${(e) => { e.preventDefault(); scrollTo(box.current.querySelector(`#${CSS.escape(k.id)}`)); }}>${k.text}</a></li>`)}</ul>`}</li>`)}</ol></nav>`}
      </div>
      ${sel && html`<${SelBar} sel=${{ ...sel, y: sel.y + (box.current?.scrollTop || 0) }} live=${live} act=${selAct} />`}
    </div>
    ${pop === "find" && html`<${Find} turns=${turns} s=${s} go=${go} close=${() => { setPop(null); box.current?.focus({ preventScroll: true }); }} init=${findQ.current} key=${findQ.current} />`}
    ${pop === "results" && html`<${Results} turns=${turns} s=${s} bodies=${bodies} need=${need} go=${go} close=${() => setPop(null)} />`}
    ${below && fresh > 0 && html`<button class="btn to-end" onClick=${() => { letGo(); atEnd.current = true; setFresh(0); box.current?.scrollTo({ top: box.current.scrollHeight }); }}>${working ? "New activity below" : "New reply below"}</button>`}
    </div>
    ${drop && html`<div class="droptarget" aria-hidden="true"><span>Drop to attach to <b>${s.title || "this session"}</b></span></div>`}
    ${!live && resume && s.kind !== "interactive" && html`<${EndBar} s=${s} resume=${resume} busy=${busy} />`}
    ${live && voice && html`<${VoiceBar} s=${s} say=${say} type=${(t) => send(t, { voice: true })} onClose=${onVoiceOff} top=${html`${cmp.top}<${BgStrip} s=${s} />`}
      press=${(k) => api(`/api/sessions/${s.id || sid}/keys`, { method: "POST", body: { keys: k } }).catch((e) => say(e.message))} />`}
    ${live && !voice && html`<${Composer} s=${s} say=${say} draft=${draft} setDraft=${setDraft} quotes=${quotes} setQuotes=${setQuotes} send=${send} replies=${replies}
      focusRef=${focusInput} uploadRef=${uploadRef} working=${working} asking=${!!asking && !asking.permission} interrupt=${interrupt}
      prompt=${cmp.prompt} doors=${cmp.doors} hintFor=${cmp.hint} top=${html`${cmp.top}<${BgStrip} s=${s} />`} />`}
    ${shot && html`<div class="lightbox" onClick=${() => setShot(null)}><img src=${shot} alt="" /></div>`}
  </div>`;
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


const lastAt = (body) => (body?.items || []).map((it) => it.out?.time || it.time).filter(Boolean).sort().pop();

const HUB_CHANNEL = { phone: "On the call", whatsapp: "On WhatsApp", "atc-voice": "By voice", agent: "To a session", guest: "To a guest", "guest-call": "On a guest's call" };

// useHubStream follows the assistant's reply as the hub streams it: what it writes after its
// last tool call, since everything before that is already in the transcript.
function useHubStream(s, landed) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    if (s.kind !== "hub") return;
    const es = new EventSource(`/api/sessions/${s.sessionId}/stream`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "turn" || e.type === "tool") setSt({ channel: e.channel, text: "" });
      else if (e.type === "text") setSt((x) => ({ channel: e.channel, text: (x?.channel === e.channel ? x.text : "") + e.delta }));
      else if (e.type === "done") { setSt(null); landed(); }
    };
    return () => es.close();
  }, [s.sessionId, s.kind]);
  return st;
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
  if (!a) return;
  const h = atcRoute(a.getAttribute("href"));
  e.preventDefault();
  if (h && !(e.metaKey || e.ctrlKey || e.shiftKey)) location.hash = h;
  else openOut(new URL(a.getAttribute("href"), location.href).href);
});

function useDirs(host, home) {
  const [dirs, setDirs] = useState([]);
  useEffect(() => { api(`/api/dirs${hostQ(host, home)}`).then((d) => setDirs(d || []), () => setDirs([])); }, [host]);
  return dirs;
}

const hostQ = (host, home) => (host && host !== home ? `?host=${encodeURIComponent(host)}` : "");

const NS_DRAFT = "atc.nsdraft", NS_HOSTS = "atc.nshost", NS_ROWS = 6;
let nsSave = 0;
const nsDraft = {
  get: () => stored(NS_DRAFT, null),
  set(d) {
    store(NS_DRAFT, d);
    clearTimeout(nsSave);
    nsSave = setTimeout(() => api("/api/drafts/new-session", { method: "PUT", body: { text: d ? JSON.stringify(d) : "" } }).catch(() => {}), 800);
  },
};

function rankFolder(q, path) {
  if (!q) return { r: 0, hits: [] };
  const pl = path.toLowerCase(), base = pl.split("/").at(-1), bi = pl.length - base.length;
  const run = (i, n) => [...Array(n).keys()].map((k) => i + k);
  if (base === q) return { r: 4, hits: run(bi, q.length) };
  if (base.startsWith(q)) return { r: 3, hits: run(bi, q.length) };
  const i = pl.indexOf(q);
  if (i >= 0) return { r: 2, hits: run(i, q.length) };
  const hits = [];
  for (let j = 0; j < pl.length && hits.length < q.length; j++) if (pl[j] === q[hits.length]) hits.push(j);
  return hits.length === q.length ? { r: 1, hits } : null;
}

function FolderField({ dirs, folder, pick, host, listHost = host, live, presets = [], preset, setPreset, onStart, home }) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(-1);
  const [more, setMore] = useState(false);
  const box = useRef();
  const ql = q.trim().toLowerCase();
  const inHere = (p) => (live || []).filter((s) => s.kind !== "hub" && (s.host || home) === host && tilde(baseDir(s.cwd)) === p).length;
  const rows = useMemo(() => {
    const paths = dirs.map((d) => ({ path: tilde(d.path), recent: !!d.recent, uses: d.uses || 0 }));
    const ps = presets.map((p) => ({ preset: p, path: p.name, grp: "Presets" }));
    if (!ql) {
      const recent = paths.filter((d) => d.recent).sort((a, b) => b.uses - a.uses).map((d) => ({ ...d, grp: `Recent on ${listHost}` }));
      let out = [...recent, ...paths.filter((d) => !d.recent).map((d) => ({ ...d, grp: "Other folders" }))];
      const at = out.findIndex((d) => d.path === folder);
      if (!preset && folder && (at < 0 || (at >= NS_ROWS && !more))) out = [{ path: folder, grp: "Picked" }, ...out.filter((d) => d.path !== folder)];
      return { folders: out, ps };
    }
    const hits = paths.map((d) => { const m = rankFolder(ql, d.path); return m && { ...d, ...m, grp: "Best match first" }; }).filter(Boolean)
      .sort((a, b) => b.r - a.r || b.recent - a.recent || a.path.length - b.path.length);
    const typed = /^[~/]/.test(q.trim()) && !hits.some((h) => h.path === q.trim()) ? [{ path: q.trim(), typed: true, grp: "This path" }] : [];
    const pm = ps.map((p) => { const m = rankFolder(ql, p.path.toLowerCase()); return m && { ...p, ...m }; }).filter(Boolean);
    return { folders: [...typed, ...hits.slice(0, 30)], ps: pm };
  }, [dirs, ql, folder, preset, listHost, presets, more]);
  const shown = [...(ql || more ? rows.folders : rows.folders.slice(0, NS_ROWS)), ...rows.ps];
  const hidden = ql || more ? 0 : rows.folders.length - NS_ROWS;
  const isPick = (r) => (r.preset ? preset?.name === r.preset.name : !preset && r.path === folder);
  const cur = hi >= 0 && hi < shown.length ? hi : Math.max(0, shown.findIndex(isPick));
  useEffect(() => setHi(-1), [ql, host]);
  useEffect(() => { box.current?.querySelector(".fo.on")?.scrollIntoView({ block: "nearest" }); }, [cur]);
  const choose = (r) => {
    if (r.preset) setPreset(preset?.name === r.preset.name ? null : r.preset);
    else { setPreset(null); pick(r.path); }
    setQ(""); setMore(false); setHi(-1);
  };
  const key = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setHi((cur + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(1, shown.length)); }
    else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const r = shown[cur];
      r && (ql || !isPick(r)) ? choose(r) : onStart();
    } else if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); }
  };
  const meta = (r) => r.preset ? `preset: ${MULTI && r.preset.host ? `${r.preset.host} ` : ""}${tilde(r.preset.dir)}` : r.typed ? "a folder that exists on this host" : (inHere(r.path) ? plural(inHere(r.path), "session") : "");
  let grp = "";
  return html`
    <div class="nsfld">
      <label class="nslb" for="ns-folder">Folder <span>${preset ? `preset ${preset.name}` : folder}</span></label>
      <input id="ns-folder" class="nsin mono" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${key} placeholder="Search folders, or type a path"
        role="combobox" aria-expanded="true" aria-controls="ns-fl" aria-activedescendant=${shown.length ? `ns-fo${cur}` : ""} autocapitalize="off" autocomplete="off" spellcheck="false" />
      <div class="nsfl" id="ns-fl" role="listbox" aria-label="Folders" ref=${box}>
        ${shown.map((r, i) => {
          const head = r.grp !== grp && html`<div class="fh" role="presentation">${r.grp}</div>`;
          grp = r.grp;
          return html`${head}<button type="button" tabindex="-1" role="option" id=${`ns-fo${i}`} aria-selected=${isPick(r)} class="fo ${i === cur ? "on" : ""} ${isPick(r) ? "pick" : ""}"
            onPointerMove=${() => i !== cur && setHi(i)} onClick=${() => choose(r)}>
            <span class="p ${r.preset ? "" : "mono"}">${r.typed ? html`Use <b>${r.path}</b>` : marked(r.path, r.hits)}${isPick(r) && html`<span class="pk">picked</span>`}</span><span class="m">${meta(r)}</span></button>`;
        })}
        ${hidden > 0 && html`<button type="button" class="more" onClick=${() => { setMore(true); document.getElementById("ns-folder")?.focus(); }}>More folders, ${hidden} <span>(or type to search)</span></button>`}
        ${ql && !shown.length && html`<p class="none">No folder matches. Type a path that starts with ~ or / to use it.</p>`}
      </div>
    </div>`;
}

function HostPick({ hosts, down, host, setHost }) {
  if (hosts.length < 2) return null;
  const off = (h) => down.find((p) => p.name === h);
  return html`<span class="nsseg" role="radiogroup" aria-labelledby="ns-hl">${hosts.map((h) => html`
    <button type="button" role="radio" aria-checked=${h === host} disabled=${!!off(h)} class=${off(h) ? "off" : ""}
      title=${off(h) ? `${h} is unreachable${off(h).error ? `: ${off(h).error}` : ""}` : ""} onClick=${() => setHost(h)}>${h}</button>`)}</span>`;
}

function WorktreeSwitch({ on, setOn, why }) {
  return html`<div class="nsfld">
    <div class="nslb" id="ns-wl">Worktree</div>
    <div class="nswt"><button type="button" class="sw" role="switch" aria-checked=${on} aria-labelledby="ns-wl" onClick=${() => setOn(!on)}></button>
      <span class="d">${on ? "on: a separate checkout on a new branch" : "off: works in the folder itself"}</span></div>
    <div class="why">${why}</div>
  </div>`;
}

const workingIn = (live, dir, host, home) => (live || []).filter((s) => s.kind !== "hub" && s.state === "working" && (s.host || home) === host && tilde(baseDir(s.cwd)) === dir);
const wtWhy = (n, dir, host) => n ? html`<b>On because ${plural(n, "session")} ${n === 1 ? "is" : "are"} working in ${dir} on ${host}.</b>` : "Nothing else is working in this folder.";

const untrusted = "Claude Code hasn't been trusted in this folder yet. Open Claude there once and accept the prompt, then try again.";
const submitOnEnter = (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key !== "Enter" || e.isComposing || (!mod && (touch || e.shiftKey))) return;
  e.preventDefault();
  e.target.form?.requestSubmit();
};

function NewSession({ onClose, say, hosts, down = [], home, live, start: from, context }) {
  const later = !!from?.later;
  const seeded = !!(from?.dir || from?.prompt);
  const [saved] = useState(() => (later || seeded ? null : nsDraft.get()));
  const ctxDir = context?.dir ? tilde(context.dir) : null;
  const [folder, setFolder] = useState(() => (from?.dir && tilde(from.dir)) || saved?.folder || ctxDir);
  const isDown = (h) => down.some((p) => p.name === h);
  const lastHosts = stored(NS_HOSTS, {});
  const [host, setHostRaw] = useState(() => from?.host || saved?.host || (folder && lastHosts[folder]) || context?.host || home);
  const [prompt, setPrompt] = useState(from?.prompt || saved?.prompt || "");
  const [name, setName] = useState(from?.title || "");
  const [naming, setNaming] = useState(false);
  const [wt, setWt] = useState(null);
  const [presets, setPresets] = useState([]);
  const [preset, setPreset] = useState(null);
  const [engines, setEngines] = useState([]);
  const [engine, setEngine] = useState("");
  const [engOpen, setEngOpen] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const up = hosts.filter((h) => !isDown(h));
  const listHost = isDown(host) ? up[0] || home : host;
  const dirs = useDirs(listHost, home);
  useEffect(() => { api("/api/presets").then((p) => setPresets(p || []), () => {}); api("/api/engines").then((e) => setEngines(e || []), () => {}); }, []);
  useEffect(() => {
    if (later || seeded || saved) return;
    api("/api/drafts").then((m) => {
      let d = null;
      try { d = JSON.parse(m?.["new-session"]?.text || "null"); } catch {}
      if (!d) return;
      setPrompt((p) => p || d.prompt || "");
      if (d.folder) setFolder(d.folder);
      if (d.host) setHostRaw(d.host);
    }, () => {});
  }, []);
  const recent = dirs.find((d) => d.recent);
  const dir = folder ?? (recent ? tilde(recent.path) : "~");
  const target = preset ? preset.host || home : host;
  const usable = engines.filter((e) => (e.host || home) === target);
  useEffect(() => { if (!usable.some((e) => e.name === engine)) setEngine(""); }, [target, engines]);
  const eng = usable.find((e) => e.name === engine);
  const harness = eng?.harness;
  const git = !!dirs.find((d) => tilde(d.path) === dir)?.git;
  const busyHere = workingIn(live, dir, target, home);
  const wtOn = git && !harness && !preset && (wt ?? busyHere.length > 0);
  const hostDown = isDown(target);
  const other = up.find((h) => h !== target);
  const first = useRef(true);
  useEffect(() => {
    if (first.current || later) { first.current = false; return; }
    nsDraft.set(prompt.trim() || (folder && folder !== ctxDir) ? { prompt, folder, host } : null);
  }, [prompt, folder, host]);
  useEffect(() => {
    const f = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
  const setHost = (h) => { setHostRaw(h); setWt(null); setErr(null); };
  const pick = (p) => { setFolder(p); setWt(null); setErr(null); const h = stored(NS_HOSTS, {})[p]; if (h && hosts.includes(h) && !isDown(h)) setHostRaw(h); };
  const clear = () => { nsDraft.set(null); setPrompt(""); setFolder(ctxDir); setHostRaw(context?.host || home); setPreset(null); setWt(null); setErr(null); };

  const putAside = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/backlog${hostQ(host, home)}`, { method: "POST", body: { dir: dir.trim(), title: name, prompt, worktree: wtOn } });
      if (!later) nsDraft.set(null);
      onClose();
      say("On the backlog.");
      loadBacklog();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const start = async (onHost) => {
    if (busy) return;
    if (later) return putAside();
    const h = onHost || target;
    if (onHost && !preset) setHostRaw(onHost);
    setBusy(h);
    setErr(null);
    try {
      const r = preset
        ? await api(`/api/sessions${hostQ(preset.host, home)}`, { method: "POST", body: { preset: preset.name, name: name.trim(), prompt, engine } })
        : await api(`/api/sessions${hostQ(h, home)}`, { method: "POST", body: { dir: dir.trim(), name: name.trim(), prompt, worktree: wtOn, engine } });
      if (!preset) store(NS_HOSTS, { ...stored(NS_HOSTS, {}), [dir]: h });
      nsDraft.set(null);
      onClose();
      say(`Started on ${h}.`);
      go(r.id);
    } catch (e) {
      setErr(e.status === 409 ? untrusted : e.message);
    }
    setBusy(false);
  };
  const submit = (e) => { e.preventDefault(); start(hostDown && !later && other ? other : null); };

  const off = down.find((p) => p.name === target);
  const why = hostDown
    ? html`<b>${target} is unreachable${off?.error ? `: ${off.error}` : ""}.</b> ${lastHosts[dir] === target ? `You usually start ${dir} there. ` : ""}${other ? `Start on ${other} instead, or come back when ${target} is up.` : ""}`
    : down.length ? `${down.map((p) => p.name).join(" and ")} ${down.length === 1 ? "is" : "are"} unreachable, so ${down.length === 1 ? "it" : "they"} can't be picked.`
    : lastHosts[dir] === host ? `Last time you used ${host} for this folder.` : "";
  const draft = !later && !!(prompt.trim() || (folder && folder !== ctxDir));
  const engLine = eng ? `${eng.name}${eng.harness ? `, ${eng.harness}` : ""}${eng.model ? `, ${eng.model}` : ""}` : "Claude, as configured";
  const startLabel = busy ? `Starting on ${busy}…` : later ? "Add to backlog" : hostDown && other ? `Start on ${other} instead` : "Start";
  return html`
    <div class="nsveil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <form class="nsdlg" role="dialog" aria-modal="true" aria-label=${later ? "Put on the backlog" : "New session"} onSubmit=${submit}>
        <div class="dh"><b>${later ? "Put on the backlog" : "New session"}</b><span class="r"><button type="button" class="kb" onClick=${onClose} aria-keyshortcuts="Escape">Close <kbd aria-hidden="true">esc</kbd></button></span></div>
        <div class="db">
          ${later && html`<div class="nsfld"><label class="nslb" for="ns-title">Title <span>what the backlog shows, in a few words</span></label>
            <input id="ns-title" class="nsin" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${submitOnEnter} ref=${touch ? null : focusOnMount} /></div>`}
          <div class="nsfld"><label class="nslb" for="ns-prompt">Prompt <span>${later ? "the session's first message when you start it" : "optional; without one you start in an empty session with the composer ready"}</span></label>
            <textarea id="ns-prompt" class="nsprompt" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} onKeyDown=${submitOnEnter}
              ref=${touch || later ? null : focusOnMount} placeholder="What should it do?"></textarea></div>
          <${FolderField} dirs=${dirs} folder=${dir} pick=${pick} host=${target} listHost=${listHost} live=${live} presets=${later ? [] : presets} preset=${preset} setPreset=${setPreset} home=${home}
            onStart=${() => start(hostDown && !later && other ? other : null)} />
          <div class="nsrow2">
            ${!preset && hosts.length > 1 && html`<div class="nsfld"><div class="nslb" id="ns-hl">Host</div><${HostPick} hosts=${hosts} down=${down} host=${host} setHost=${setHost} />
              ${why && html`<div class="why">${why}</div>`}</div>`}
            ${!later && git && !harness && !preset && html`<${WorktreeSwitch} on=${wtOn} setOn=${setWt} why=${wtWhy(busyHere.length, dir, target)} />`}
            ${later && git && html`<${WorktreeSwitch} on=${wtOn} setOn=${setWt} why="The session starts in its own checkout when you start it." />`}
          </div>
          ${!later && html`<div class="nsfld"><div class="nslb">Engine</div>
            <div class="nseng">
              ${engOpen && usable.length
                ? html`<select aria-label="Engine" value=${engine} onChange=${(e) => setEngine(e.target.value)} ref=${focusOnMount}>
                    ${[{ name: "" }, ...usable].map((e) => html`<option value=${e.name}>${e.name ? `${e.name}${e.harness ? `, ${e.harness}` : ""}${e.model ? `, ${e.model}` : ""}` : "Claude, as configured"}</option>`)}</select>`
                : html`<span>${engLine}</span>${usable.length > 0 && html`<button type="button" class="kb" onClick=${() => setEngOpen(true)}>Change</button>`}`}
              ${naming
                ? html`<input class="nsin nsname" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${submitOnEnter} placeholder=${preset ? preset.name : "Session name"} aria-label="Session name" ref=${focusOnMount} />`
                : html`<button type="button" class="kb" title=${`Without one, ${harness || "Claude"} titles the session from what you ask`} onClick=${() => setNaming(true)}>Name it</button>`}
            </div></div>`}
          ${err && html`<div class="nserr" role="alert"><b>Couldn't ${later ? "add it" : `start on ${preset ? preset.host || home : host}`}.</b> ${err}</div>`}
        </div>
        <div class="df">
          <span class="sum">${preset ? html`preset <b>${preset.name}</b>, ${tilde(preset.dir)}` : html`<b>${dir}</b> on ${hostDown && other ? other : host}${wtOn ? ", own worktree" : ""}`}</span>
          ${draft && html`<button type="button" class="btn clr" onClick=${clear} title="Empty the sheet; it keeps what you typed until you start or clear it">Clear</button>`}
          <button type="button" class="btn nsx" onClick=${onClose}>Cancel</button>
          ${!later && !preset && html`<button type="button" class="btn" title="Put it on the backlog to start later" disabled=${!dir.trim() || !(name.trim() || prompt.trim()) || !!busy} onClick=${putAside}>Later</button>`}
          <button class="btn primary go" disabled=${(!preset && !dir.trim()) || (later && !(name.trim() || prompt.trim())) || !!busy || (hostDown && !other && !later)}>${startLabel}${!busy && html` <kbd aria-hidden="true">enter</kbd>`}</button>
        </div>
      </form>
    </div>
  `;
}

function fuzzy(q, text) {
  if (!q) return { score: 1, hits: [] };
  const t = text.toLowerCase(), sub = t.indexOf(q);
  if (sub >= 0) return { score: 100 + q.length * 3 + (sub === 0 ? 40 : /[\s\-_:/#.(@]/.test(t[sub - 1]) ? 25 : 0) - sub * 0.3, hits: [...Array(q.length).keys()].map((k) => sub + k) };
  const qq = q.replace(/\s+/g, ""), hits = [];
  let score = 0, last = -2;
  for (let i = 0; i < t.length && hits.length < qq.length; i++) {
    if (t[i] !== qq[hits.length]) continue;
    score += 1 + (last === i - 1 ? 6 : 0) + (i === 0 || /[\s\-_:/#.(@]/.test(t[i - 1]) ? 9 : 0);
    hits.push(i);
    last = i;
  }
  if (hits.length < qq.length) return null;
  score -= (hits.at(-1) - hits[0]) * 0.15;
  return score < qq.length * 5 ? null : { score, hits };
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

const PAL_RECENT = "atc.palrecent";
const PAL_CAP = { Sessions: 6, Pages: 4, Actions: 6, Folders: 4, Agents: 4, Earlier: 4, Bays: 4, Appearance: 4 };
const STATE_BOOST = { "needs-you": 30, "your-turn": 12, working: 6 };

function Palette({ live, sel, say, home, hosts, actions, onClose }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [presets, setPresets] = useState([]);
  const [dirs, setDirs] = useState([]);
  const [pages, setPages] = useState([]);
  const [past, setPast] = useState([]);
  const [preview, setPreview] = useState(null);
  const list = useRef(), input = useRef(), from = useRef(location.hash);
  useEffect(() => {
    api("/api/presets").then((p) => setPresets(p || []), () => {});
    api("/api/pages").then((p) => setPages(p || []), () => {});
    Promise.all(hosts.map((h) => api(`/api/dirs${hostQ(h, home)}`).then((d) => (d || []).map((x) => ({ ...x, host: h })), () => []))).then((l) => setDirs(l.flat()));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => api(`/api/history?limit=${q ? 12 : 6}&q=${encodeURIComponent(q)}`).then((h) => setPast(h || []), () => {}), q ? 120 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const remember = (k) => store(PAL_RECENT, [k, ...stored(PAL_RECENT, []).filter((x) => x !== k)].slice(0, 8));
  const leave = (ran) => { if (!ran && preview && location.hash !== from.current) history.back(); onClose(); };
  const items = [];
  const add = (group, label, opts) => items.push({ group, label, ...opts });
  const run = (key, f) => () => { if (key) remember(key); onClose(); f(); };
  const bays = baysOf(live, BAY.only);
  const cur = SESSION_API;
  if (cur && sel) {
    const s = cur.s, g = "This session";
    const act = (label, f, kw = "", hint) => add(g, label, { run: run(null, f), kw, hint, sub: s.title || "Untitled" });
    if (cur.canAttach) act("Terminal", () => cur.mode("term"), "shell attach", "t");
    act("Transcript", () => cur.mode("chat"), "read conversation");
    act("Outputs", () => cur.mode("out"), "files servers links");
    act("Sessions pane", () => actions.pane("rail"), "rail list", "[");
    act("State pane", () => actions.pane("state"), "summary facts", "]");
    for (const p of cur.pages || []) act(`Page: ${pageTitle(p)}`, () => cur.page(p.name), `show ${p.name}`);
    if (cur.canAttach && VOICE_OK) act("Voice", cur.voice, "talk speak mic");
    act("Session usage", cur.usage, "tokens cost limit");
    act("Rename", cur.rename, "title name");
    act(s.pinned ? "Unpin" : "Pin", () => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { pinned: !s.pinned } }));
    act(s.parked ? "Unpark" : "Park", () => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { parked: !s.parked } }), "hide quiet");
    if (s.attachable) act("Stop", () => api(`/api/sessions/${s.sessionId}/stop`, { method: "POST" }).then(() => say("Stopped. Resume it any time.")), "end");
    act("Put on the backlog", () => putAside(s, say), "later aside backlog");
  }
  for (const s of live) add("Sessions", s.title || "Untitled", { key: `s:${s.sessionId}`, s, extra: bayOf(s) || project(s.cwd).name, boost: STATE_BOOST[s.state] || 0,
    sub: s.state === "working" ? doing(s) : oneLine(s.summary?.status || s.lastReply), bay: bayOf(s) || project(s.cwd).name, ago: ago(s),
    to: `#/s/${keyOf(s)}`, run: run(`s:${s.sessionId}`, () => go(keyOf(s))) });
  const liveIDs = new Set(live.map((s) => s.sessionId));
  for (const s of past.filter((s) => !liveIDs.has(s.sessionId))) add("Earlier", s.title || "Untitled", { s, extra: project(s.cwd).name, bay: project(s.cwd).name, ago: ago(s), sub: oneLine(s.lastPrompt), to: `#/s/${s.sessionId}`, run: run(null, () => go(s.sessionId)) });
  for (const p of pages) {
    const owner = live.find((x) => x.sessionId === p.session), to = owner ? pageLink(p.session, p.name) : aloneLink(p.session, p.name);
    add("Pages", pageTitle(p), { key: `p:${pkey(p)}`, page: true, sub: `${p.kind || "page"}, from ${owner?.title || p.of || "an earlier session"}`, bay: owner ? bayOf(owner) || project(owner.cwd).name : "",
      ago: ago({ updated: p.updated || p.shown }), to, run: run(`p:${pkey(p)}`, () => (location.hash = to)) });
  }
  const action = (label, hint, sub, f, kw = "") => add("Actions", label, { key: `a:${label}`, hint, sub, kw, boost: 4, run: run(`a:${label}`, f) });
  action("New session", "+", "start a session in a folder", () => actions.create(), "start folder");
  action("Session", "s", "the open session of this bay", () => goBay(BAY.only, live, true));
  action("Board", "b", "every session of this bay", () => { rememberBay(BAY.only, { view: "board" }); go(null); });
  action("Pages", "g", "every page your sessions showed you", () => (location.hash = pagesHash()), "shown html reports gallery");
  action("Assistant", ".", "your conversation with it", actions.ask, "ask chat switchboard");
  if (CAN_CALL) action("Call the assistant", "", "a voice call", callAssistant, "phone voice");
  if (VOICE_OK) action("Talk to Claude", "", "voice, hands free", actions.talk, "voice assistant");
  action("All bays", "0", "the board across every bay", () => { BAY.set(null); go(null); });
  action("Next session that needs you", "n", "any bay, in bay order", actions.next);
  action("Usage", "", "limits, pace, cost per bay and session", actions.usage, "tokens cost week limits");
  action("Backlog", "", "future tasks of this bay", () => (location.hash = BACKLOG), "later todo tasks ideas");
  action("New backlog item", "", "put a task aside for later", () => actions.create({ later: true }), "later todo task add put");
  action("Agents", "", "standing agents and what they keep", () => (location.hash = AGENTS_ROUTE), "tracker standing");
  action("Settings", ",", "appearance, reading, notifications", () => (location.hash = SETTINGS), "preferences options theme");
  action("Keys", "?", "every key", actions.help, "help shortcuts keyboard");
  for (const p of presets) action(`Start ${p.name}`, "", `preset, ${MULTI && p.host ? `${p.host} ` : ""}${tilde(p.dir)}`, () => api(`/api/sessions${hostQ(p.host, home)}`, { method: "POST", body: { preset: p.name } }).then((r) => { say(`Started ${p.name}.`); go(r.id); }, (e) => say(e.message)), "preset");
  for (const [v, label] of [["auto", "Match the system"], ["light", "Light"], ["dark", "Dark"]])
    add("Appearance", label, { kw: "appearance scheme mode light dark night day theme", sub: LOOK.scheme === v ? "current" : "light and dark", run: run(null, () => LOOK.set("scheme", v)) });
  for (const [v, label] of Object.entries(THEMES))
    add("Appearance", `Theme: ${label}`, { kw: "appearance theme colors look", sub: LOOK.theme === v ? "current" : "", run: run(null, () => LOOK.set("theme", v)) });
  const seenDir = new Set();
  for (const d of [...dirs].sort((a, b) => !!b.recent - !!a.recent || (b.uses || 0) - (a.uses || 0))) {
    const k = `${d.host} ${d.path}`;
    if (seenDir.has(k)) continue;
    seenDir.add(k);
    add("Folders", tilde(d.path), { mono: true, sub: `new session on ${d.host}`, run: run(null, () => actions.create({ dir: d.path, host: d.host })) });
  }
  for (const a of Object.values(AGENT_INFO)) add("Agents", a.name === "assistant" ? "the assistant" : `@${a.name}`, { key: `g:${a.name}`, agent: a, boost: 2,
    sub: a.headline || a.error || (a.every ? `wakes every ${a.every}` : "wakes when messaged"), run: run(`g:${a.name}`, () => AGENT_SHEET(a.name)) });
  bays.forEach((b, i) => add("Bays", b.name, { bayN: i + 1, b, hint: i < 9 ? `alt ${i + 1}` : "", sub: bayWords(b, i).split(": ")[1] || "nothing open", run: run(null, () => goBay(b.name, live)) }));

  const ql = q.trim().toLowerCase();
  let groups;
  if (!ql) {
    const byKey = Object.fromEntries(items.filter((it) => it.key).map((it) => [it.key, it]));
    groups = [
      ["Recent", [...new Set([...stored(PAL_RECENT, []).map((k) => byKey[k]).filter(Boolean),
        ...items.filter((it) => it.group === "Sessions" && !away(it.s)).sort((x, y) => (Date.parse(y.s.updated || 0) || 0) - (Date.parse(x.s.updated || 0) || 0))])].slice(0, 6)],
      ["Needs you", items.filter((it) => it.group === "Sessions" && it.s.state === "needs-you" && !away(it.s))],
      ["This session", items.filter((it) => it.group === "This session")],
      ["Actions", items.filter((it) => it.group === "Actions").slice(0, 5), items.filter((it) => it.group === "Actions").length - 5],
    ].filter(([, l]) => l.length);
  } else {
    const by = {};
    for (const it of items) {
      if (it.group === "Folders" && ql.length < 2) continue;
      const m = fuzzy(ql, it.label), m2 = !m && fuzzy(ql, `${it.extra || ""} ${it.kw || ""}`);
      if (!m && !m2) continue;
      (by[it.group] ||= []).push({ ...it, hits: m ? m.hits : [], score: (m ? m.score : m2.score * 0.6) + (it.boost || 0) });
    }
    groups = Object.entries(by).map(([g, l]) => { l.sort((a, b) => b.score - a.score); return [g, l.slice(0, PAL_CAP[g] || 6), l.length - (PAL_CAP[g] || 6), l[0].score]; })
      .sort((a, b) => b[3] - a[3]);
    const n = /^[1-9]$/.test(ql) && bays[+ql - 1];
    if (n) groups.unshift(["Bay", [items.find((it) => it.group === "Bays" && it.b === n)], 0]);
  }
  const flat = groups.flatMap((g) => g[1]);
  const pick = Math.min(at, Math.max(0, flat.length - 1));
  const top = flat[pick];
  useEffect(() => setAt(0), [q]);
  useEffect(() => { list.current?.querySelector(".pal-o.on")?.scrollIntoView({ block: "nearest" }); }, [pick, q]);

  const peek = () => {
    if (!top?.to) return;
    setPreview(top.label);
    if (location.hash !== top.to) location.hash = top.to;
    setTimeout(() => input.current?.focus(), 60);
  };
  const keyRef = useRef();
  keyRef.current = (e) => {
    const c = e.ctrlKey;
    if (e.key === "ArrowDown" || (c && (e.key === "j" || e.key === "n"))) { e.preventDefault(); setAt((pick + 1) % Math.max(1, flat.length)); }
    else if (e.key === "ArrowUp" || (c && (e.key === "k" || e.key === "p"))) { e.preventDefault(); setAt((pick - 1 + flat.length) % Math.max(1, flat.length)); }
    else if (e.key === "Tab") { e.preventDefault(); peek(); }
    else if (e.key === "Enter") { e.preventDefault(); top?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); leave(false); }
    else return false;
  };
  useEffect(() => {
    const k = (e) => {
      if (!["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(e.key) && !(e.ctrlKey && "jknp".includes(e.key))) return;
      if (keyRef.current(e) !== false) e.stopPropagation();
    };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, []);
  const lead = (it) => it.s ? html`<${StateBlock} s=${it.s} />` : it.agent ? html`<${AgentMark} a=${it.agent} />` : it.b ? html`<span class="ic">${it.bayN}</span>`
    : html`<span class="ic" aria-hidden="true">${it.page ? "pg" : it.mono ? "dir" : ""}</span>`;
  const rt = (it) => it.bay !== undefined && (it.s || it.page) ? html`<span class="bay">${it.bay}</span><span class="ago">${it.ago}</span>`
    : it.b ? html`<span class="cts" aria-hidden="true">${it.b.needs + it.b.turn > 0 && html`<i class="cn n">${it.b.needs + it.b.turn}</i>`}${it.b.work > 0 && html`<i class="cn w">${it.b.work}</i>`}</span>${it.hint && html`<kbd>${it.hint}</kbd>`}`
    : it.hint ? it.hint.split(" ").map((k) => html`<kbd>${k}</kbd>`) : "";
  let n = -1;
  return html`
    <div class="pal-scrim ${preview ? "previewing" : ""}" onPointerDown=${() => leave(false)}></div>
    <div class="pal" role="dialog" aria-modal="true" aria-label="Palette">
      <div class="pal-hd"><b>Go to</b><button class="pal-x" onClick=${() => leave(false)}>Close</button></div>
      <div class="pal-in"><span class="pr" aria-hidden="true">/</span>
        <input ref=${(el) => { input.current = el; focusOnMount(el); }} value=${q} onInput=${(e) => setQ(e.target.value)} role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list"
          aria-activedescendant=${flat.length ? `pal-o${pick}` : ""} aria-label="Search sessions, pages, actions, folders and agents"
          placeholder=${PHONE.matches ? "Sessions, pages, actions, folders" : "Go to a session, page, action, folder or agent"} autocapitalize="off" autocomplete="off" spellcheck="false" />
        <span class="cnt">${ql ? flat.length : ""}</span></div>
      <div class="pal-list" id="pal-list" role="listbox" aria-label="Results" ref=${list}>
        ${groups.map(([g, its, more]) => html`
          <div role="group" aria-label=${g}>
            <div class="pal-g"><b>${g}</b><span class="c">${its.length}</span>${g === "Sessions" && html`<span>all bays, needs you first</span>`}${g === "Folders" && html`<span>to start a session</span>`}${more > 0 && html`<span class="r">${more} more, keep typing</span>`}</div>
            ${its.map((it) => { n++; const i = n; return html`
              <div class="pal-o ${i === pick ? "on" : ""}" role="option" id=${`pal-o${i}`} aria-selected=${i === pick} onPointerMove=${() => i !== pick && setAt(i)} onClick=${it.run}>
                ${lead(it)}<span class="lb ${it.mono ? "mono" : ""}">${marked(it.label, it.hits)}</span><span class="sub">${it.sub || ""}</span>
                <span class="rt">${preview === it.label && i === pick && html`<span class="pv">previewing</span>`}${rt(it)}</span>
              </div>`; })}
          </div>`)}
        ${!flat.length && html`<div class="pal-none">Nothing matches <b>${q}</b>. Start a session with it as the prompt: <button class="btn" onClick=${run(null, () => actions.create({ prompt: q }))}>New session</button></div>`}
      </div>
      <div class="pal-top">${top && html`<span class="w">Opens</span><span class="t">${top.label}</span><button class="btn primary" onClick=${top.run}>Go</button>`}</div>
      <div class="pal-f"><span><kbd>enter</kbd>runs</span><span><kbd>tab</kbd>previews behind</span><span><kbd>↑</kbd><kbd>↓</kbd><kbd>ctrl j</kbd><kbd>ctrl k</kbd>move</span><span><kbd>2</kbd>alone: bay 2</span><span><kbd>esc</kbd>closes</span></div>
      <div class="sr" aria-live="polite">${ql ? `${flat.length} results${top ? `, first: ${top.label}` : ""}` : ""}</div>
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
  const running = (live || []).filter((s) => s.attachable && !away(s));
  const [to, setTo] = useState(shared.to ? "running" : "new");
  const [target, setTarget] = useState(null);
  useEffect(() => {
    if (shared.to && !target) setTarget(running.find((s) => s.sessionId === shared.to) || null);
  }, [live]);
  const [host, setHost] = useState(home);
  const dirs = useDirs(host, home);
  const [chosen, setChosen] = useState(null);
  const dir = chosen ?? "~";
  const [worktree, setWorktree] = useState(null);
  const git = !!dirs.find((d) => tilde(d.path) === dir)?.git;
  const busyHere = workingIn(live, dir, host, home);
  const wtOn = git && (worktree ?? busyHere.length > 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

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
        const r = await api(`/api/sessions${hostQ(host, home)}`, { method: "POST", body: { dir: dir.trim(), prompt, worktree: wtOn } });
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
          <${FolderField} dirs=${dirs} folder=${dir} pick=${(p) => { setChosen(p); setWorktree(null); }} host=${host} live=${live} home=${home} onStart=${() => {}} />
          <div class="nsrow2">
            ${hosts.length > 1 && html`<div class="nsfld"><div class="nslb" id="ns-hl">Host</div><${HostPick} hosts=${hosts} down=${[]} host=${host} setHost=${(h) => { setHost(h); setChosen(null); setWorktree(null); }} /></div>`}
            ${git && html`<${WorktreeSwitch} on=${wtOn} setOn=${setWorktree} why=${wtWhy(busyHere.length, dir, host)} />`}
          </div>
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
