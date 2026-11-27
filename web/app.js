import { html, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "./vendor/preact-htm.js";
import { marked as Marked } from "./vendor/marked.esm.js";
import hljs from "./vendor/highlight.min.js";
import { diffLines } from "./vendor/diff.mjs";
import { Call } from "./call.js";
import { extended, onLine } from "./call-log.js";
import { persona } from "./persona.js";
import { minimal } from "./minimal.js";
import { cube, niceMax } from "./usage-cube.js";
import { attention, RULE } from "./attention.js";
import { ICON_PATHS, HUES, idColor, hueOf, appColor } from "./tile.js";
import { timeCube, costs, againstSpend, OUTSIDE } from "./time-cube.js";
import { partsOf } from "./res-parts.js";
import { numberedLists } from "./md-lists.js";
import { diffBlock, esc, marksOver, wordRanges } from "./md-diff.js";
import { ansiParts, clipView, cutAt, fileRef, githubIssue, isSha, issueRefs, linkSessions, shortURL, slug as headingSlug, spotLink, spotOf, stripAnsi } from "./md-refs.js";
import { glider, GLIDE_KEYS } from "./glide.js";
import { personOf, speakers, VIEWS, nextView, personLangs, langName, voiceName } from "./persons.js";
import { PersonsPage, useSample, ROOMS } from "./persons-page.js";
import { useCaps, useSetup, CapsBanner, CapsSections, SetupScreen, slug } from "./caps.js";
import { DevicesSection } from "./devices.js";
import { clipPath, clipWords, langOf } from "./text.js";
import { Empty, Err } from "./copy.js";
import { KEY_GROUPS, key as keyFor, tip, aria as ariaKeys, matches as keyMatches } from "./keys.js";
import { age, stamp, duration, clock as hhmm, at as whenAt, day as dayLabel, date as dateLabel, weekday } from "./when.js";

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

const rowAt = (s) => Math.max(Date.parse(s.updated || 0) || 0, Date.parse(s.startedAt || 0) || 0);
let STALE = { off: 0, hosts: {} };
const staleAt = (s) => (s?.host && STALE.hosts[s.host] && s.state !== "past" && s.state !== "stopped" ? STALE.hosts[s.host] : STALE.off && s?.state === "working" ? STALE.off : 0);
const ago = (s) => { const t = staleAt(s); return t ? `as of ${hhmm(t)}` : age(rowAt(s)); };

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
    for (const d of DOCK.values()) Object.assign(d.term.options, { theme: termTheme(), minimumContrastRatio: termContrast() });
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
addEventListener("atc-look", () => LOOK.restyle());
addEventListener("message", (e) => { if (e.data?.atc === 1 && e.data.op === "hello" && e.source) e.source.postMessage(LOOK.message(), "*"); });
const tilde = (p) => {
  if (!p) return "";
  if (HOME && (p === HOME || p.startsWith(HOME + "/"))) return "~" + p.slice(HOME.length);
  const m = p.match(/^\/(home|Users)\/[^/]+(\/.*)?$/);
  return m ? "~" + (m[2] || "") : p;
};
let MULTI = false, HERE = "", LIVE = [], LIVE_NAMES = "", HEARD = 0;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
let PALETTE_OPEN = () => {}, NEW_SESSION = () => {}, PAL_TOGGLE = null;
const FRAMED = window.self !== window.top;
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
const isHome = (h) => h === "" || h === "#" || h === "#/";
let FROM_HOME = false;
addEventListener("hashchange", (e) => { FROM_HOME = isHome(new URL(e.oldURL).hash) && location.hash.startsWith("#/s/"); });
const backHome = () => (FROM_HOME ? history.back() : go(null));
const USAGE = "#/usage", TIME = "#/time", RESOURCES = "#/resources", PAGES = "#/pages", SETTINGS = "#/settings";
{
  const m = location.pathname.match(/^\/(?:pages|p)(?:\/([^/]+))?\/?$/);
  if (m) history.replaceState(null, "", m[1] ? `/#/p/+pinned/${m[1]}` : `/${location.hash || PAGES}`);
}
if (FRAMED) {
  let posted = "";
  const tell = () => { if (location.href !== posted) window.parent.postMessage({ type: "location", href: (posted = location.href) }, "*"); };
  for (const k of ["pushState", "replaceState"]) { const f = history[k].bind(history); history[k] = (...a) => { f(...a); tell(); }; }
  addEventListener("hashchange", tell);
  addEventListener("popstate", tell);
  tell();
  let meta = "";
  const tellMeta = () => {
    const link = [...document.querySelectorAll('link[rel~="icon"]')].pop();
    const m = { type: "meta", title: document.title, icon: link ? link.href : null };
    const k = JSON.stringify([m.title, m.icon]);
    if (k !== meta) { meta = k; window.parent.postMessage(m, "*"); }
  };
  new MutationObserver(tellMeta).observe(document.head, { childList: true, subtree: true, attributes: true, characterData: true });
  tellMeta();
  const MODIFIERS = new Set(["Shift", "Alt", "Control", "Meta"]);
  const editable = (t) => !!t && (t.isContentEditable || !!t.matches?.("input, textarea, select"));
  let parentKeys = new Set();
  addEventListener("message", (e) => {
    if (e.source === window.parent && e.data?.type === "keys" && Array.isArray(e.data.keys)) parentKeys = new Set(e.data.keys);
  });
  const combo = (e) => (e.ctrlKey ? "ctrl+" : "") + (e.altKey ? "alt+" : "") + (e.shiftKey ? "shift+" : "") + e.code;
  addEventListener("keydown", (e) => {
    const t = e.composedPath()[0];
    if (e.isComposing || e.repeat || MODIFIERS.has(e.key) || t?.matches?.('input[type="password"]')) return;
    if (!(e.altKey || e.ctrlKey || e.metaKey || (e.shiftKey && !editable(t)))) return;
    const { key, code, altKey, ctrlKey, shiftKey, metaKey } = e;
    const pass = () => window.parent.postMessage({ type: "key", key, code, altKey, ctrlKey, shiftKey, metaKey }, "*");
    if (!e.defaultPrevented && parentKeys.has(combo(e))) { e.preventDefault(); pass(); return; }
    setTimeout(() => e.defaultPrevented || pass(), 0);
  });
}
const inSettings = () => /^#\/settings([#/]|$)/.test(location.hash);
const CALLS_ROW = `${SETTINGS}#calls`;
let SETTINGS_FROM = "#/";
const closeSettings = () => { location.hash = SETTINGS_FROM; };
const pagesHash = (bay = BAY.only, sid, name) => `#/g/${bay ? encodeURIComponent(bay) : "all"}${sid ? `/${encodeURIComponent(sid)}/${encodeURIComponent(name)}` : ""}`;
const pagesRoute = () => {
  const m = location.hash.match(/^#\/g\/([^/]+)(?:\/([^/]+)\/(.+))?$/);
  if (!m) return null;
  const bay = decodeURIComponent(m[1]);
  return { bay: bay === "all" ? null : bay, sid: m[2] ? decodeURIComponent(m[2]) : null, name: m[3] ? decodeURIComponent(m[3]) : null };
};
let PAGES_FROM = null;
let USAGE_FROM = null;
const inUsage = () => location.hash === USAGE || location.hash === TIME;
const openUsage = () => { if (inUsage()) return; USAGE_FROM = location.hash; location.hash = USAGE; };
const toggleUsage = () => (inUsage() ? (location.hash = USAGE_FROM || "#/") : openUsage());
const openResources = () => { if (location.hash !== RESOURCES) location.hash = RESOURCES; };
const SCREENS = { usage: "Usage", time: "Time", resources: "Resources", backlog: "Backlog", agents: "Agents", settings: "Settings" };
const screenOf = () => location.hash === USAGE ? "usage" : location.hash === TIME ? "time" : location.hash === RESOURCES ? "resources" : location.hash === BACKLOG ? "backlog" : agentRoute() !== null ? "agents" : null;
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

function useLive() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    addEventListener("atc-live", f);
    return () => removeEventListener("atc-live", f);
  }, []);
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
let AUTO_PANE = null, AUTO_SPLIT = false;
const WEB = { at: null, fresh: false, shown: Date.now() };
const CALL = "#/call";
let CAN_CALL = false;
const ASSIST = "#/assist";
let ASSIST_FROM = null;
const openAssistant = () => { if (location.hash === ASSIST) return; if (location.hash !== CALL) ASSIST_FROM = location.hash; location.hash = ASSIST; };
const closeAssistant = () => (location.hash = ASSIST_FROM && ASSIST_FROM !== ASSIST ? ASSIST_FROM : "#/");
const HOLD = "#/hold";
let HOLD_FROM = null;
window.leaveHold = () => { if (location.hash !== HOLD) return; HOLD_FROM ? history.back() : location.replace("#/"); };
const CALLDOCK = { open: true, set(v) { CALLDOCK.open = v; dispatchEvent(new Event("atc-calldock")); } };
const BP = { phone: "(max-width: 899px)", desk: "(min-width: 900px)" };
const isPhone = () => matchMedia(BP.phone).matches;
const returnToCall = () => (isPhone() ? (location.hash = CALL) : CALLDOCK.set(true));
const callAssistant = () => {
  if (APP?.call) return APP.call();
  CALLDOCK.set(true);
  Call.dial();
  if (isPhone() && location.hash !== CALL) location.hash = CALL;
};
/** The native app rings calls itself; a browser rings one only while it is fresh. */
const ringHere = ({ reason, at }) => {
  if (APP || !CAN_CALL || Date.now() / 1000 - at > 60 || !Call.ring(reason, Date.now() - lastInput < 90000)) return;
  CALLDOCK.set(true);
  if (isPhone() && location.hash !== CALL) location.hash = CALL;
};
const callOrSetup = () => (CAN_CALL ? callAssistant() : (location.hash = CALLS_ROW));
const callAbout = (s, say) => {
  if (!CAN_CALL) return void (location.hash = CALLS_ROW);
  api("/api/call/about", { method: "POST", body: { id: s.sessionId, title: s.title } }).catch((e) => say(`Couldn't tell the assistant which session: ${e.message}`));
  Call.live() ? returnToCall() : callAssistant();
};
/** Moves the live call to an agent, or has the next call open on it; "assistant" brings it back. */
const callAgent = (name, say) => {
  if (!CAN_CALL) return void (location.hash = CALLS_ROW);
  api("/api/call/to", { method: "POST", body: { agent: name } }).catch((e) => say?.(`Couldn't reach ${name}: ${e.message}`));
  if (name !== "assistant") Call.live() ? returnToCall() : callAssistant();
};
/** A session's call action: straight to it when it is an agent that can talk, otherwise the assistant, told which session. */
const callSession = (s, say) => {
  const a = AGENT_INFO[s.agent];
  return a?.talk && !a.error ? { label: "Call", boost: 5, run: () => callAgent(a.name, say) } : { label: "Call about this", run: () => callAbout(s, say) };
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
function zenHistory(on) {
  if (on) history.pushState({ ...history.state, atcZen: true }, "");
  else if (history.state?.atcZen) history.back();
}
function useZenBack(on, leave) {
  useEffect(() => {
    if (!on) return;
    const back = () => !history.state?.atcZen && leave();
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
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
  const onBays = useMemo(() => runs && runs.filter((x) => !hiddenRun(x) || agentAtWork(x)), [runs]);
  const hub = runs?.find(isAssistant);
  const [agents, setAgents] = useState(null);
  const [off, setOff] = useState(0);
  const [link, relink] = useState(0);
  const [past, setPast] = useState({});
  const [creating, setCreating] = useState(false);
  NEW_SESSION = (start) => setCreating(start || true);
  const [shelling, setShelling] = useState(false);
  NEW_SHELL = (start) => setShelling(start || true);
  const [shellAt, setShellAt] = useState(shellRoute);
  const [palette, setPalette] = useState(false);
  PALETTE_OPEN = () => setPalette(true);
  PAL_TOGGLE = usePal(!FRAMED && me?.pal) ? () => window.pal.toggle() : null;
  const [cursor, setCursor] = useState(null);
  const [quick, setQuick] = useState(null);
  QUICK = (s, rect) => setQuick({ s, rect });
  const [agentUse, setAgentUse] = useState(null);
  const [agentSheet, setAgentSheet] = useState(null);
  openAgent = (name, view) => (view === "usage" ? setAgentUse(name) : view === "details" ? setAgentSheet(name) : name === "assistant" ? openAssistant() : (location.hash = `${AGENTS_ROUTE}/${encodeURIComponent(name)}`));
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState(null);
  const [agentName, setAgentName] = useState(agentRoute);
  const [limits, setLimits] = useState(null);
  const route = useRoute();
  const [stale, setStale] = useState(null);
  const [panes, setPanesRaw] = useState(() => ({ rail: true, index: true, pgindex: true, aleft: true, ...stored("atc.panes", {}) }));
  const rememberPast = useCallback((list) => setPast((p) => Object.fromEntries([...Object.entries(p), ...list.map((s) => [s.sessionId, s])])), []);
  const [hist, moreHist, canMore] = useBayHistory(!!me, rememberPast);
  const lookingUp = usePastSession(route, !runs || !!past[route] || runs.some((s) => s.id === route || s.sessionId === route), rememberPast);
  const togglePane = (k) => setPanesRaw((p) => { const n = { ...p, [k]: !p[k] }; store("atc.panes", n); return n; });
  const only = useBay();
  const wide = useWide();
  const phone = usePhone();
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
    let pinged = false, lost = 0, raw = [];
    SHOW_LIVE = () => {
      LIVE = DOOMED.size ? raw.filter((x) => !doomed(x)) : raw;
      LIVE_NAMES = LIVE.map((x) => `${keyOf(x)}:${x.title}:${x.agent || ""}`).join("|");
      setLive(LIVE);
      dispatchEvent(new Event("atc-live"));
    };
    const hear = () => { if (navigator.onLine === false) return; HEARD = Date.now(); clearTimeout(lost); lost = 0; setOff(0); };
    const drop = (now) => { if (now) return setOff(HEARD || Date.now()); lost ||= setTimeout(() => setOff(HEARD || Date.now()), 4000); };
    es.onopen = hear;
    es.addEventListener("ping", () => { pinged = true; hear(); });
    es.addEventListener("sessions", (e) => {
      raw = steady(JSON.parse(e.data) || []);
      DOOMED.forEach((_, sid) => !raw.some((x) => x.sessionId === sid) && DOOMED.delete(sid));
      SHOW_LIVE();
      hear();
    });
    es.addEventListener("look", (e) => LOOK.adopt(JSON.parse(e.data)));
    es.addEventListener("seen", (e) => syncEvent("seen", JSON.parse(e.data)));
    es.addEventListener("drafts", (e) => syncEvent("drafts", JSON.parse(e.data)));
    es.addEventListener("bays", (e) => adoptBays(JSON.parse(e.data)));
    es.addEventListener("ring", (e) => ringHere(JSON.parse(e.data)));
    loadBays();
    es.onerror = () => {
      drop();
      api("/api/me").catch((e) => e.auth && setMe(null));
    };
    const quiet = setInterval(() => { if (pinged && Date.now() - HEARD > 40000) { drop(true); relink((n) => n + 1); } }, 5000);
    const gone = () => drop(true), back = () => relink((n) => n + 1);
    addEventListener("offline", gone);
    addEventListener("online", back);
    return () => { es.close(); clearTimeout(lost); clearInterval(quiet); removeEventListener("offline", gone); removeEventListener("online", back); };
  }, [me, link]);
  const retry = () => { relink((n) => n + 1); return api("/api/me").then(setMe, () => say("Still offline.")); };
  const retryPeer = (name) => api(`/api/peers/${encodeURIComponent(name)}/retry`, { method: "POST" }).then(setMe, () => say(`${name} still isn't answering.`));

  useEffect(() => {
    if (!me) return;
    SHELLS.load();
    const t = setInterval(() => document.visibilityState === "visible" && SHELLS.load(), 20000);
    return () => clearInterval(t);
  }, [!!me]);

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
  const [settings, setSettings] = useState(inSettings);
  const setup = useSetup(me, api);
  const [calling, setCalling] = useState(location.hash === CALL);
  const [holding, setHolding] = useState(location.hash === HOLD);
  useEffect(() => {
    const f = (e) => { if (inSettings() && e.oldURL && !new URL(e.oldURL).hash.startsWith(SETTINGS)) SETTINGS_FROM = new URL(e.oldURL).hash || "#/"; if (location.hash === HOLD && e.oldURL) HOLD_FROM = new URL(e.oldURL).hash || "#/"; setHolding(location.hash === HOLD); setAssisting(fromCall() || location.hash === ASSIST); setCalling(location.hash === CALL); setScr(screenOf()); setAgentName(agentRoute()); setSharing(shareRoute()); setAlone(aloneRoute()); setPagesAt(readPages()); setSettings(inSettings()); setAgentSheet(null); setShellAt(shellRoute()); };
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
      const n = x.private
        ? new Notification("Private session", { body: x.state === "needs-you" ? "Needs you" : "Finished its turn", tag: x.sessionId, icon: "/icon.svg" })
        : new Notification(x.title || "atc", { body: x.state === "needs-you" ? `Needs you${x.activity ? ": " + x.activity : ""}` : (x.summary?.status || x.lastReply || "Finished its turn"), tag: x.sessionId, icon: "/icon.svg" });
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
        id: s.attachable ? s.id : undefined, sid: s.sessionId, title: s.private ? "Private session" : s.title, state: s.state, host: s.host || undefined, pinned: s.pinned || undefined,
        since: (s.state === "working" && s.promptAt) || s.updated || undefined,
        summary: (s.state !== "working" && !s.private && s.summary?.status) || undefined, bay: (!s.private && bayOf(s)) || undefined,
        ask: s.state === "needs-you" && !s.private ? feedAsk(s) : undefined,
      }));
      const hub = (live || []).find(isAssistant);
      const said = hub && oneLine(hub.preview || hub.lastReply || hub.summary?.status);
      const assistant = said ? { text: said, at: hub.updated || undefined } : undefined;
      const key = JSON.stringify([rows.map(({ since, ...r }) => r), said]);
      if (key !== appSent) { appSent = key; APP.setSessions(JSON.stringify({ type: "sessions", at: new Date().toISOString(), sessions: rows, assistant })); }
    } else if (APP?.setTargets) {
      const targets = JSON.stringify(reach.filter((s) => s.attachable && !away(s)).slice(0, 8).map((s) => ({ id: s.sessionId, title: s.private ? "Private session" : s.title })));
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
    setTimeout(() => setToast((x) => (x === t ? null : x)), act?.undo ? 8000 : 6000);
  }, []);
  const undo = () => setToast((t) => { t?.undo?.(); return null; });

  const ordered = arrange(live);
  const keys = useRef({});
  keys.current = { ordered, route, cursor, creating, live, onBays, togglePane, setPeek, pages: !!pagesAt, toast, undo, list: !screenOf() && !pagesAt };
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
      if (!document.querySelector(".veil, .keys-ov, .pal, .peek, [role=menu]") && !e.metaKey && !e.ctrlKey && !e.altKey)
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
      const digit = /^Digit\d$/.test(e.code) && !e.metaKey && !e.ctrlKey && ((e.altKey && e.shiftKey) || (!e.altKey && !e.shiftKey && !typing && !t.closest?.(".ask, [data-ask]") && !document.querySelector(".veil, .pghome, .palone, .keys-ov, .peek, [role=menu]")));
      if (digit) {
        const n = +e.code.slice(5), bays = baysOf(k.onBays, BAY.only);
        e.preventDefault();
        if (e.altKey && e.shiftKey) { if (bays[n - 1]) k.setPeek((v) => (v === bays[n - 1].name ? null : bays[n - 1].name)); return; }
        if (n === 0 && k.pages) { const b = BAY.only, r = pagesRoute(); location.hash = pagesHash(b === null ? PAGES_FROM || bays[0]?.name || null : null, r?.sid, r?.name); PAGES_FROM = b || PAGES_FROM; return; }
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
      if (document.querySelector(".veil, .pghome, .palone, .keys-ov, .pal, .peek, [role=menu]")) {
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
          const bays = baysOf(k.onBays, BAY.only).map((b) => b.name);
          const needs = (k.live || []).filter(waiting).sort((a, b) => bays.indexOf(bayOf(a)) - bays.indexOf(bayOf(b)) || (a.state === "needs-you" ? 0 : 1) - (b.state === "needs-you" ? 0 : 1));
          const i = needs.findIndex((x) => keyOf(x) === k.route || x.sessionId === k.route);
          const next = needs[(i + 1) % needs.length];
          next ? go(keyOf(next)) : say("Nothing needs you.");
        },
        "[": () => (k.route ? k.togglePane("rail") : k.pages && k.togglePane("pgindex")),
        "]": () => !k.route && k.list && k.togglePane("index"),
        z: () => (k.toast?.undo ? k.undo() : !document.querySelector(".pghome, .palone, .sheet") && (SESSION_API?.zen || TX_API?.zen)?.()),
        ",": () => (inSettings() ? closeSettings() : (location.hash = SETTINGS)),
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
      } else if (e.key === "Delete" && k.cursor && k.list && !k.route) {
        const x = k.ordered.find((x) => x.sessionId === k.cursor);
        if (!x || !canDelete(x)) return;
        e.preventDefault();
        const near = [step(x.sessionId, 1), step(x.sessionId, -1)].find((y) => y && y.sessionId !== x.sessionId);
        deleteLater(x, say).then((ok) => ok && setCursor(near?.sessionId || null));
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
  CAN_CALL = !!me.call && (!!APP?.call || (!APP && Call.supported()));
  const down = (me.peers || []).filter((p) => p.error);
  STALE = { off, hosts: staleHosts(down) };
  if (setup.machine) return html`<${SetupScreen} machine=${setup.machine} check=${setup.check} skip=${setup.skip} ui=${{ ...capsUI(say), home: me.host, shell: () => { setup.skip(); setShelling(true); } }} />`;

  const all = runs || [];
  const sel = route && (all.find((s) => s.id === route || s.sessionId === route) || past[route]);
  const assistView = assisting || isAssistant(sel);
  const screen = assistView ? "assistant" : route || shellAt ? "session" : pagesAt ? "pages" : scr || "board";
  TIME_ON = openNow({ sel: alone ? all.find((x) => x.sessionId === alone.sid) : assistView || shellAt || settings ? null : sel, screen: alone ? "pages" : settings ? "settings" : shellAt ? "shell" : screen });
  const bays = baysOf(onBays, only);
  PANES = { panes, wide, toggle: togglePane, allBays: () => BAY.set(only === null ? bays[0]?.name || null : null) };
  const inBay = (live || []).filter((x) => x.state !== "stopped" && (only ? bayOf(x) === only : !homeless(x))).length;
  const railPath = only && (live || []).find((x) => bayOf(x) === only);
  const remember = rememberPast;
  const openFromUsage = async (x) => {
    if (!all.some((s) => s.sessionId === x.sessionId) && !past[x.sessionId])
      remember((await api(`/api/history?q=${encodeURIComponent(x.title)}&limit=50`).catch(() => [])).filter((s) => s.sessionId === x.sessionId));
    go(x.sessionId);
  };

  return html`
    <div class="app ${assistView ? "assisting" : ""} ${phone && screen === "session" ? "insession" : ""}">
    <${BayBar} bays=${bays} only=${only} view=${settings ? "settings" : screen} off=${off} down=${down} live=${live} peek=${peek} onPeek=${setPeek} />
    <${StaleLines} off=${off} down=${down} live=${all} retry=${retry} retryPeer=${retryPeer} />
    ${peek && html`<${BayPeek} key=${peek} bay=${peek} live=${live} onBays=${onBays} say=${say} onClose=${() => setPeek(null)} />`}
    ${settings ? html`<main class="shell scr"><${SettingsPage} me=${me} say=${say} onClose=${closeSettings} /></main>`
    : assistView ? html`<${AssistantView} hub=${hub} live=${all} loaded=${!!runs} say=${say} panes=${panes} togglePane=${togglePane} />`
    : pagesAt && !route ? html`<div class="shell pagesv"><${PagesView} at=${pagesAt} live=${all} bays=${bays} say=${say} index=${panes.pgindex !== false} /></div>`
    : scr && !route ? html`<main class="shell scr">${scr === "usage" ? html`<${UsagePage} limits=${limits} live=${all} down=${down} onOpen=${openFromUsage} />`
      : scr === "time" ? html`<${TimePage} live=${all} onOpen=${openFromUsage} />`
      : scr === "resources" ? html`<${ResourcesPage} hosts=${(me.hosts || [me.host]).filter((h) => h)} home=${me.host} live=${all} />`
      : scr === "backlog" ? html`<${BacklogPage} live=${all} say=${say} onAdd=${setCreating} only=${only} />`
      : html`<${AgentsPage} name=${agentName} agents=${agents} live=${all} past=${past} remember=${rememberPast} say=${say} reload=${loadAgents} panes=${panes} togglePane=${togglePane} />`}</main>`
    : !route && !shellAt && phone ? html`<${PhoneHome} live=${live} hist=${hist} more=${canMore && moreHist} only=${only} bays=${bays} cursor=${cursor} limits=${limits} say=${say} />`
    : !route && !shellAt ? html`<div class="shell boardv"><${BoardView} live=${live} hist=${hist} more=${canMore && moreHist} only=${only} sel=${sel} cursor=${cursor} say=${say} index=${panes.index && wide} /></div>` : html`
    <div class="shell open ${!panes.rail ? "norail" : ""}">
      <aside class="side">
        <div class="ph"><b>${only || "Every bay"}</b>${railPath ? html`<span class="w" title=${tilde(baseDir(railPath.cwd))}>${clipPath(tilde(baseDir(railPath.cwd)))}</span>` : html`<span class="w">${plural(inBay, "session")}</span>`}
          <span class="r"><button class="btn quiet" onClick=${() => setCreating(true)} aria-keyshortcuts=${ariaKeys("new")} title=${tip("new")}>${ICON.plus}New</button><${BayMore} only=${only} live=${live} say=${say} /><${PaneToggle} id="rail" on run=${() => togglePane("rail")} icon="rail" label="Hide the bay's sessions" /></span></div>
        <${RailList} live=${live} hist=${hist} more=${canMore && moreHist} only=${only} sel=${sel} cursor=${cursor} shell=${shellAt} say=${say} />
      </aside>
      <main class="main">
        ${shellAt ? html`<${ShellView} key=${shellAt.id} at=${shellAt} say=${say} />`
        : sel
          ? html`<${Session} key=${sel.sessionId} s=${sel} say=${say} live=${all} panes=${panes} togglePane=${togglePane} />`
          : html`<div class="blank">${!live || lookingUp ? "Opening…" : "This session is gone. Pick another from the list."}</div>`}
      </main>
    </div>`}
    <${Console} hub=${hub} agents=${agents} runs=${runs} limits=${limits} onTalk=${openAssistant} onKeys=${() => setHelp(true)} say=${say} />
    ${!calling && html`<${CallPill} hub=${hub} />`}
    <${TabBar} view=${calling ? "assistant" : settings ? "settings" : screen} onTalk=${openAssistant} waits=${(live || []).filter(waiting).length} />
    </div>
    ${creating && html`<${NewSession} onClose=${() => setCreating(false)} say=${say} hosts=${me.hosts || [me.host]} down=${down} home=${me.host} live=${all}
      start=${creating === true ? null : creating} context=${creating === true ? here(sel, live) : null} />`}
    ${shelling && html`<${NewShell} onClose=${() => setShelling(false)} hosts=${me.hosts || [me.host]} down=${down} home=${me.host} live=${all} start=${shelling === true ? null : shelling} />`}
    ${palette && html`<${Palette} live=${reach || []} onBays=${onBays} sel=${sel} say=${say} home=${me.host} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} onClose=${() => setPalette(false)}
      actions=${{ create: (start) => setCreating(start || true), usage: openUsage, help: () => setHelp(true), talk: openAssistant, ask: openAssistant,
        pane: togglePane, next: () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })) }} />`}
    ${sharing && html`<${Share} key=${sharing} live=${live} say=${say} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} home=${me.host} />`}
    ${alone && html`<${PageAlone} key=${alone.sid} sid=${alone.sid} name=${alone.name} at=${alone.at} live=${all} say=${say} />`}
    ${holding && html`<${Hold} live=${live} me=${me} down=${down} limits=${limits} say=${say} />`}
    ${calling ? html`<${CallScreen} hub=${hub} live=${all} />` : html`<${CallDock} hub=${hub} live=${all} assisting=${assistView} />`}
    ${quick && html`<${QuickMenu} quick=${quick} say=${say} onClose=${() => setQuick(null)} />`}
    ${agentSheet && html`<${AgentDetail} sheet a=${(agents || []).find((a) => a.name === agentSheet) || { name: agentSheet }} live=${all} say=${say} reload=${loadAgents} onClose=${() => setAgentSheet(null)} />`}
    ${agentUse && html`<${AgentUsage} name=${agentUse} onClose=${() => setAgentUse(null)} />`}
    <${Dialogs} />
    ${toast && html`<div class="toast" role="status"><span class="tmsg">${toast.msg}</span>${toast.undo && html`<button class="tundo" onClick=${undo} aria-keyshortcuts="z">${ICON.undo}Undo<kbd aria-hidden="true">z</kbd></button>`}</div>`}
    ${notifAsk && me && !updated && !settings && html`<div class="appbar" role="status">
      <span>Get a desktop notification when a session finishes or needs you, while this tab is in the background?</span>
      <button class="btn primary" onClick=${() => notifDone(true)}>Turn on</button>
      <button class="btn" onClick=${() => notifDone(false)}>Not now</button>
    </div>`}
    ${updated && html`<div class="appbar" role="status">
      <span>atc was updated. Reload to get the new version.</span>
      <button class="btn primary" onClick=${() => location.reload()}>Reload</button>
      <button class="icon" aria-label="Dismiss" onClick=${() => setUpdated(false)}>${ICON.x}</button>
    </div>`}
    ${stale && html`<div class="appbar" role="status">
      <span>A newer atc app is available (${stale}).</span>
      <button class="btn primary" onClick=${() => APP?.checkUpdate()}>Update</button>
      <button class="icon" aria-label="Dismiss" onClick=${() => setStale(null)}>${ICON.x}</button>
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
const PRIVATE_BAY = "private";
const projectOf = (s) => (s.private ? PRIVATE_BAY : project(s.cwd).name);
const bayOf = (s) => (!s ? null : homeless(s) || s.kind === "hub" ? AGENT_BAY : projectOf(s));
const waiting = (s) => (s.state === "needs-you" || s.state === "your-turn") && !away(s);

function baysOf(live, keep) {
  const tabs = projectTabs(live || [], keep);
  const ag = (live || []).filter((s) => bayOf(s) === AGENT_BAY && s.state !== "stopped" && s.state !== "past");
  if (ag.length || keep === AGENT_BAY) tabs.push({ name: AGENT_BAY, n: ag.length, resting: ag.filter((s) => !countsOnBay(s)).length, pips: ag.filter((s) => countsOnBay(s) && RANK[s.state] !== undefined).map((s) => s.state) });
  const names = tabs.map((t) => t.name);
  let order = BAYDATA.order;
  const fresh = names.filter((n) => !order.includes(n));
  if (fresh.length && !BAYDATA.local) {
    BAYDATA.order = order = [...order, ...fresh];
    api("/api/bays", { method: "PUT", body: { order, from: PAGE_ID } }).catch(() => {});
  } else if (fresh.length) order = [...order, ...fresh];
  const out = order.filter((n) => names.includes(n)).map((n) => {
    const t = tabs.find((x) => x.name === n), c = (st) => t.pips.filter((x) => x === st).length;
    return { name: n, needs: c("needs-you"), turn: c("your-turn"), work: c("working"), parked: t.n > 0 && t.resting === t.n };
  });
  return [...out.filter((b) => !b.parked), ...out.filter((b) => b.parked)];
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

const bayCounts = (b) => (b.needs + b.turn > 0 || b.work > 0) && html`<span class="cts">${b.needs + b.turn > 0 && html`<i class="cn n">${b.needs + b.turn}</i>`}${b.work > 0 && html`<i class="cn w">${b.work}</i>`}</span>`;
const bayWords = (b, i) => [`${b.name}, bay ${i + 1}${b.parked ? ", parked" : ""}`, [b.needs + b.turn && `${b.needs + b.turn} waiting on you`, b.work && `${b.work} working`].filter(Boolean).join(", ")].filter(Boolean).join(": ");

let PANES = { panes: {}, wide: true, toggle: () => {}, allBays: () => {} };
const PaneToggle = ({ id, on, run, icon, label }) => html`<button class="btn quiet icon ptog" aria-pressed=${!!on} aria-keyshortcuts=${ariaKeys(id)} aria-label=${label} title=${tip(id, label)} onClick=${run}>${ICON[icon]}</button>`;
const BoardToggles = ({ only }) => PANES.wide && html`<span class="ptogs"><${PaneToggle} id="all" on=${only === null} run=${PANES.allBays} icon="bays" label="Every bay on one board" /><${PaneToggle} id="index" on=${PANES.panes.index} run=${() => PANES.toggle("index")} icon="side" label="The bay's pages beside the board" /></span>`;

const DOWN_SEEN = {};
const staleHosts = (down) => {
  for (const n of Object.keys(DOWN_SEEN)) if (!down.some((p) => p.name === n)) delete DOWN_SEEN[n];
  return Object.fromEntries(down.map((p) => [p.name, Date.parse(p.since || 0) || (DOWN_SEEN[p.name] ||= Date.now())]));
};

function StaleLine({ children, retry }) {
  const [busy, setBusy] = useState(false);
  const run = () => { setBusy(true); Promise.resolve(retry()).finally(() => setBusy(false)); };
  return html`<div class="staleline" role="status">${ICON.off}<span class="t">${children}</span>
    ${retry && html`<button class="btn sm" aria-busy=${busy} onClick=${run}>${ICON.refresh}Retry</button>`}</div>`;
}

function StaleLines({ off, down, live, retry, retryPeer }) {
  return html`<div class="staleslot">${off
    ? html`<${StaleLine} retry=${retry}>Offline since <span class="tm">${hhmm(off)}</span>. Showing what was there.<//>`
    : down.map((p) => {
      const at = STALE.hosts[p.name], kept = live.some((s) => s.host === p.name);
      return html`<${StaleLine} key=${p.name} retry=${() => retryPeer(p.name)}>${p.since ? html`${p.name} hasn't answered since <span class="tm">${hhmm(at)}</span>.` : `${p.name} isn't answering.`}${kept && " Its sessions show what was there then."}<//>`;
    })}</div>`;
}

function MemMeter() {
  const b = useMachineBrief();
  const m = b?.machine;
  const pct = m?.memTotal ? Math.round((m.memUsed / m.memTotal) * 100) : 0;
  if (pct <= 85) return null;
  return html`<button class="st mem" onClick=${openResources} title=${`Memory ${gb(m.memUsed)} of ${gb(m.memTotal)}, CPU ${Math.round(m.cpu / m.cores)}%`}>
    ${ICON.warn}${HERE ? `${HERE} memory` : "Memory"}<span class="mm" aria-hidden="true"><i style=${`width:${pct}%`}></i></span><span class="num">${pct}%</span></button>`;
}

const parkedFold = (bays, only) => bays.map((b, i) => ({ b, i })).filter(({ b }) => b.parked && b.name !== only);

function BayBar({ bays, only, view, off, down, live, peek, onPeek }) {
  const scroller = useRef();
  const [hidden, setHidden] = useState(0);
  const [fold, setFold] = useState(false);
  const need = useRef(0), pm = useRef();
  const names = bays.map((b) => b.name).join();
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
  useEffect(() => setFold(false), [names]);
  useLayoutEffect(() => {
    const fit = () => {
      const el = scroller.current;
      if (!el || !el.clientWidth) return;
      if (!fold) { need.current = el.scrollWidth; if (el.scrollWidth > el.clientWidth + 1 && parkedFold(bays, only).length) setFold(true); }
      else if (el.clientWidth + (pm.current?.offsetWidth || 0) >= need.current) setFold(false);
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  });
  const folded = fold ? parkedFold(bays, only) : [];
  const shown = bays.map((b, i) => ({ b, i })).filter(({ b }) => !folded.some((f) => f.b === b));
  const view_ = (id, label, run) => html`<button aria-pressed=${view === id} aria-current=${view === id ? "page" : null} aria-keyshortcuts=${ariaKeys(id)} title=${tip(id)} onClick=${run}>${label}</button>`;
  return html`
    <nav class="bays" aria-label="Bays">
      <div class="bays-scroll" ref=${scroller}>
        ${only === null && html`<span class="bay on"><button class="bn" aria-current="true" title=${tip("all")}><span class="k">0</span><span class="n">All</span></button></span>`}
        ${shown.map(({ b, i }, n) => html`
          ${b.parked && !shown[n - 1]?.b.parked && html`<span class="bay-sep" aria-hidden="true"></span>`}
          <span class="bay ${only === b.name ? "on" : ""} ${peek === b.name ? "peeking" : ""} ${b.parked ? "rest" : ""}" data-bay=${b.name} ...${peekOnHover(b, only, peek, onPeek)}>
            <button class="bn" aria-current=${only === b.name ? "true" : null} aria-label=${bayWords(b, i)}
              aria-keyshortcuts=${i < 9 ? `${i + 1}` : null} onClick=${() => { onPeek(null); goBay(b.name, live); }}>
              <span class="k" aria-hidden="true">${i + 1}</span><span class="n">${b.name}</span>${bayCounts(b)}</button>
          </span>`)}
      </div>
      ${folded.length > 0 && html`<div class="parkedm" ref=${pm}><span class="bay-sep" aria-hidden="true"></span><${Menu} cls="bay parked" left width=${260} aria="Parked bays"
          label=${html`${folded.length} parked${ICON.down}`}
          render=${(close) => html`<div class="pmenu" role="menu">${folded.map(({ b, i }) => html`<button role="menuitem" aria-label=${bayWords(b, i)} onClick=${() => { close(); goBay(b.name, live); }}>
            <span class="k">${i + 1}</span><span class="n">${b.name}</span>${bayCounts(b)}</button>`)}</div>`} /></div>`}
      ${hidden > 0 && html`<button class="offneeds" onClick=${() => onPeek(peek === "*" ? null : "*")} aria-label=${`${hidden} more need you in other bays`}><i class="cn n">+${hidden}</i>need you</button>`}
      <div class="views">
        <span class="seg" role="group" aria-label="View">
          ${view_("session", "Session", () => goBay(only, live, true))}
          ${view_("board", "Board", () => { rememberBay(only, { view: "board" }); go(null); })}
          ${view_("pages", "Pages", () => (location.hash = pagesHash()))}
          ${SCREENS[view] && html`<button aria-pressed="true" aria-current="page">${SCREENS[view]}</button>`}
        </span>
      </div>
      <div class="meta">
        ${off ? html`<span class="st off" role="status">${ICON.off}Offline</span>`
          : down.map((p) => html`<span class="st off" title=${p.error}>${ICON.off}${p.name} down</span>`)}
        <${MemMeter} />
      </div>
    </nav>`;
}

const PEEK_HOVER = { close: 0, on: false, x: 0, y: 0 };
const bayListShown = () => !!document.querySelector(".shell.open > .side")?.offsetParent;
const peekOnHover = (b, only, peek, onPeek) => ({
  onPointerEnter: () => clearTimeout(PEEK_HOVER.close),
  onPointerMove: (e) => {
    const still = e.clientX === PEEK_HOVER.x && e.clientY === PEEK_HOVER.y;
    PEEK_HOVER.x = e.clientX; PEEK_HOVER.y = e.clientY;
    if (e.pointerType !== "mouse" || still || peek === b.name || (b.name === only && bayListShown()) || !(b.needs + b.turn + b.work) || (peek && !PEEK_HOVER.on)) return;
    PEEK_HOVER.on = true;
    onPeek(b.name);
  },
  onPointerLeave: () => { if (PEEK_HOVER.on) PEEK_HOVER.close = setTimeout(() => PEEK_HOVER.on && onPeek(null), 300); },
});

function PeekReply({ s, say }) {
  const [text, setText] = useState("");
  const send = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    api(`/api/sessions/${s.id}/send`, { method: "POST", body: { text: t } }).then(() => say(`Sent to ${s.title || "the session"}.`), (err) => { setText(t); say(err.message); });
  };
  return html`<form class="preply" onSubmit=${send}><input value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${`Reply to ${s.title || "Untitled"}`} aria-label=${`Reply to ${s.title || "Untitled"}`}
    onKeyDown=${(e) => e.key === "Escape" && text && (e.stopPropagation(), setText(""))} /><button class="btn sm primary" disabled=${!text.trim()}>Send</button></form>`;
}

function BayPeek({ bay, live, onBays, say, onClose }) {
  const phone = usePhone();
  const box = useRef();
  const every = bay === "*";
  const mine = (onBays || []).filter((s) => (every ? waiting(s) : bayOf(s) === bay) && countsOnBay(s));
  const pins = pinnedOf(mine), rest = mine.filter((s) => !pins.includes(s)), waits = mine.filter(waiting).length;
  const wait = rest.filter(waiting).sort((a, b) => (a.state === "needs-you" ? 0 : 1) - (b.state === "needs-you" ? 0 : 1)), work = rest.filter((s) => s.state === "working");
  const order = [...pins, ...wait, ...work];
  const [at, setAt] = useState(0);
  const keys = useRef({});
  const nav = useRef();
  nav.current = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); return onClose(); }
    if (e.target.matches?.("input, textarea") || e.altKey || e.ctrlKey || e.metaKey) return;
    const d = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); setAt((i) => Math.max(0, Math.min(order.length - 1, i + d))); }
    else if (/^[1-9]$/.test(e.key) && keys.current[order[at]?.sessionId]) { e.preventDefault(); e.stopPropagation(); keys.current[order[at].sessionId](+e.key); }
    else if (e.key === "Enter" && order[at] && !e.target.closest?.("button, a")) { e.preventDefault(); open(order[at]); }
  };
  useEffect(() => {
    const k = (e) => nav.current(e);
    const out = (e) => !box.current?.contains(e.target) && !e.target.closest?.(".bays") && onClose();
    addEventListener("keydown", k, true);
    addEventListener("pointerdown", out);
    return () => { removeEventListener("keydown", k, true); removeEventListener("pointerdown", out); PEEK_HOVER.on = false; clearTimeout(PEEK_HOVER.close); };
  }, []);
  useLayoutEffect(() => {
    const a = document.querySelector(every ? ".bays .offneeds" : `.bays .bay[data-bay="${CSS.escape(bay)}"]`)?.getBoundingClientRect(), el = box.current;
    if (!phone && a && el) el.style.left = `${Math.max(8, Math.min(a.left, innerWidth - el.offsetWidth - 8))}px`;
  });
  const open = (s) => { onClose(); go(keyOf(s)); };
  const path = !every && mine[0]?.cwd && tilde(baseDir(mine[0].cwd));
  const n = baysOf(onBays, BAY.only).findIndex((b) => b.name === bay) + 1;
  const row = (s) => {
    const line = lineOf(s), ref = { current: null };
    keys.current[s.sessionId] = (k) => ref.current?.(k);
    return html`<div class="pk ${s.state} ${!phone && order[at] === s ? "on" : ""}" key=${s.sessionId} onPointerMove=${() => order[at] !== s && setAt(order.indexOf(s))}>
      <${StateBlock} s=${s} /><a class="ti" lang=${langOf(s.title)} href=${`#/s/${keyOf(s)}`} onClick=${(e) => { e.preventDefault(); open(s); }}>${s.title || "Untitled"}</a>
      <span class="ago" title=${stamp(rowAt(s))}>${every && html`<span class="bayn">${bayOf(s)}</span>`}${ago(s)}</span>
      <p class="what" lang=${typeof line === "string" ? langOf(line) : null}>${line}</p>
      ${s.asks?.length > 0 && html`<div class="pka"><${Ask} compact=${!phone} sheet=${phone} s=${s} a=${s.asks[0]} say=${say} keyRef=${ref} /></div>`}
      ${replyable(s) && html`<div class="pka"><${CardReplies} s=${s} /></div>`}
      ${!phone && s.state === "your-turn" && s.attachable && !s.asks?.length && html`<div class="pka"><${PeekReply} s=${s} say=${say} /></div>`}
    </div>`;
  };
  const group = (title, l) => l.length > 0 && html`<h3 class="grp"><b>${title}</b><span class="c">${l.length}</span></h3>${l.map(row)}`;
  const body = html`
    ${group("Pinned", pins)}${group("Waiting on you", wait)}${group("Working", work)}
    ${!mine.length && html`<p class="pkn">Nothing running in ${bay}.</p>`}`;
  if (phone) return html`<${Sheet} cls="peeksheet" title=${every ? "Every bay" : bay} onClose=${onClose}><div class="peek" ref=${box}>${body}
    ${!every && html`<div class="pkf"><button class="btn" onClick=${() => { onClose(); goBay(bay, live); }}>Go to ${bay}</button></div>`}</div><//>`;
  return html`<div class="peek" ref=${box} role="dialog" aria-label=${`Peek at ${bay}`}
      onPointerEnter=${() => clearTimeout(PEEK_HOVER.close)} onPointerDown=${() => (PEEK_HOVER.on = false)}
      onPointerLeave=${() => PEEK_HOVER.on && (PEEK_HOVER.close = setTimeout(onClose, 300))}>
    <div class="pkh"><b>${every ? "Every bay" : bay}</b>${path && html`<span class="w">${clipPath(path)}</span>`}${waits > 0 && html`<span class="bc n">${waits} waiting</span>`}
      ${!every && html`<span class="r"><button class="btn sm quiet" onClick=${() => { onClose(); BAY.set(bay); rememberBay(bay, { view: "board" }); go(null); }}>Board</button>
        <button class="btn sm quiet" onClick=${() => { onClose(); goBay(bay, live); }}>Go to ${bay}${n > 0 && n < 10 && html`<kbd>${n}</kbd>`}</button></span>`}</div>
    <div class="pkb">${body}</div>
    ${order.length > 0 && html`<div class="pkf"><span><kbd>1</kbd>…<kbd>9</kbd> answers the highlighted one</span><span><kbd>j</kbd><kbd>k</kbd> moves</span><span><kbd>esc</kbd> closes</span></div>`}
  </div>`;
}

const hubLine = (hub) => {
  if (!hub) return "Ask about or drive your sessions.";
  if (hub.state === "needs-you") return `Needs you${hub.activity ? `: ${oneLine(hub.activity)}` : ""}`;
  if (hub.state === "working") return oneLine(hub.activity) || "Working";
  return oneLine(hub.summary?.status) || oneLine(hub.preview || hub.lastReply) || "Waiting for you.";
};

function ConsoleAgents({ agents, runs }) {
  const last = (a) => Math.max(Date.parse(a.last || 0) || 0, ...(runs || []).filter((x) => x.agent === a.name).map((x) => Date.parse(x.updated || 0) || 0));
  const list = (agents || []).filter((a) => !a.error && a.name !== "assistant").sort((a, b) => last(b) - last(a));
  if (!list.length) return null;
  const runOf = (a) => agentRun(runs || [], a.name);
  const needs = list.filter((a) => { const r = runOf(a); return r && waiting(r); }).length;
  const row = (a, close) => {
    const r = runOf(a), keeps = agentKeeps(a) || oneLine(r?.summary?.status || r?.lastReply) || "Keeps nothing";
    return html`<button class="ar ${r && waiting(r) ? "nd" : ""}" role="menuitem" onClick=${() => { close(); openAgent(a.name); }}>
      <b>@${a.name}</b><span class="ag" title=${last(a) ? stamp(last(a)) : null}>${last(a) ? age(last(a)) : ""}</span><span class="k">${keeps}</span></button>`;
  };
  return html`<${Menu} cls="btn quiet sm agentsb" up width=${360} aria="Agents"
    label=${html`Agents${needs > 0 ? html`<i class="cn n" aria-label=${`${needs} waiting on you`}>${needs}</i>` : html`<span class="num">${list.length}</span>`}`}
    render=${(close) => html`<div class="agpop" role="menu">
      <div class="ah"><b>Agents</b><span class="num">${list.length}</span><span class="sp"></span><span>what each keeps</span></div>
      ${list.slice(0, 8).map((a) => row(a, close))}
      <button class="more" onClick=${() => { close(); location.hash = AGENTS_ROUTE; }}>${list.length > 8 ? `All ${list.length} agents…` : "Agents page"}</button></div>`} />`;
}

const WINDOW_MS = { session: 5 * 3.6e6, weekly_all: 7 * 24 * 3.6e6 };
const paceOf = (w) => {
  const end = Date.parse(w.resetsAt), len = WINDOW_MS[w.key];
  if (!end || !len) return null;
  const gone = (Date.now() - (end - len)) / len;
  return gone > 0.03 && gone <= 1 ? gone * 100 : null;
};

function UsageChip({ limits }) {
  useNow(60000);
  useRoute();
  const ws = (limits?.windows || []).filter((w) => SHORT[w.key]);
  const week = ws.find((w) => w.key === "weekly_all"), sess = ws.find((w) => w.key === "session");
  const main = week || sess;
  if (!main) return null;
  const used = Math.round(main.percent), pace = paceOf(main), off = pace == null ? null : Math.round(main.percent - pace);
  const hotSess = week && sess && sess.percent >= 75 ? sess : null;
  const left = sess && Date.parse(sess.resetsAt) - Date.now();
  const title = [
    `${SHORT[main.key]} ${used}%${pace != null ? `, even pace ${Math.round(pace)}%${off ? ` (${Math.abs(off)} ${off > 0 ? "over" : "under"})` : ""}` : ""}`,
    week && sess && `Session ${Math.round(sess.percent)}%`,
    left > 0 && `session resets in ${duration(left / 1000)}`,
  ].filter(Boolean).join(", ");
  const open = inUsage();
  return html`<button class="usechip ${open ? "on" : ""}" onClick=${toggleUsage} title=${`${title}. ${open ? "Click to go back" : "Click for Usage"}`} aria-label=${`Usage: ${title}`} aria-pressed=${open}>
    <span class="v">${used}%</span>
    ${off ? html`<span class=${`pc ${off > 15 ? "hot" : off > 0 ? "over" : ""}`}>${off > 0 ? "+" : "−"}${Math.abs(off)}</span>` : null}
    ${hotSess && html`<span class="v">5h ${Math.round(hotSess.percent)}%</span>`}</button>`;
}

function Console({ hub, agents, runs, limits, onTalk, onKeys, say }) {
  useCall();
  const docked = useCallDock();
  const [text, setText] = useState("");
  if (Call.live()) return html`<${CallLine} docked=${docked} />`;
  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (!hub) return onTalk();
    setText("");
    api(`/api/sessions/${hub.id || hub.sessionId}/send`, { method: "POST", body: { text: t } })
      .then(() => say("Sent to the assistant."), (e) => { setText(t); say(`Couldn't send to the assistant: ${e.message}`); });
  };
  return html`
    <footer class="console" aria-label="Assistant">
      <button class="who" onClick=${onTalk} aria-keyshortcuts="." title=${tip("assistant", "Open the assistant")}>assistant</button>
      <span class="last">${hubLine(hub)}</span>
      ${hub && html`<span class="ago" title=${stamp(rowAt(hub))}>${ago(hub)}</span>`}
      <label class="ask"><input value=${text} placeholder="Talk to the assistant" aria-label="Talk to the assistant" autocomplete="off" spellcheck="false"
        onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); send(); } else if (e.key === "Escape") e.target.blur(); }} />
        ${text.trim() && html`<kbd>enter</kbd>`}</label>
      <${UsageChip} limits=${limits} />
      <button class="btn quiet sm" onClick=${callOrSetup}>${ICON.phone}Call</button>
      <${ConsoleAgents} agents=${agents} runs=${runs} />
      <button class="btn quiet sm icon" onClick=${onKeys} aria-keyshortcuts="?" aria-label="Keys" title=${tip("keys", "Every key")}>${ICON.keys}</button>
    </footer>`;
}

function TabBar({ view, onTalk, waits }) {
  const [adding, setAdding] = useState(false);
  const tab = (on, icon, label, run, badge) => html`<button class=${on ? "on" : ""} aria-current=${on ? "page" : null} onClick=${run}>
    ${badge > 0 && html`<i class="cn n" aria-label=${`${badge} waiting on you`}>${badge}</i>`}${icon}<span>${label}</span></button>`;
  const pick = (f) => () => { setAdding(false); f(); };
  return html`
    <nav class="tabbar" aria-label="Views">
      ${tab(view === "board", ICON.list, "Sessions", () => go(null), waits)}
      ${tab(view === "pages", ICON.page, "Pages", () => (location.hash = pagesHash()))}
      ${tab(view === "assistant", ICON.mic, "Assistant", onTalk)}
      ${tab(false, ICON.search, "Search", () => PALETTE_OPEN())}
      ${tab(adding, ICON.plus, "New", () => setAdding(true))}
    </nav>
    ${adding && html`<${MenuSheet} aria="New" onClose=${() => setAdding(false)}><${MenuItems} sheet onPick=${(it) => { setAdding(false); it.run(); }} items=${[
      { label: "New session", icon: "plus", run: () => NEW_SESSION() },
      { label: "New shell", icon: "term", run: () => NEW_SHELL() },
    ]} /><//>`}`;
}

function PhoneHome({ live, hist, more, only, bays, cursor, limits, say }) {
  const strip = useRef();
  useLayoutEffect(() => strip.current?.querySelector(".bay.on")?.scrollIntoView({ block: "nearest", inline: "nearest" }), [only]);
  const waits = (live || []).filter(waiting).length;
  const tab = (on, k, name, b, rest) => html`<span class="bay ${on ? "on" : ""} ${rest ? "rest" : ""}" key=${name}>
    <button class="bn" aria-current=${on ? "true" : null} onClick=${() => BAY.set(b ? b.name : null)}><span class="k" aria-hidden="true">${k}</span><span class="n">${name}</span>${b && bayCounts(b)}</button></span>`;
  return html`<div class="shell phomev">
    <div class="phead"><h1>Sessions</h1>${waits > 0 && html`<span class="bc n">${waits} waiting</span>`}
      <${UsageChip} limits=${limits} />
      <button class="btn icon pib" aria-label="Settings" title=${tip("settings", "Settings")} onClick=${() => (location.hash = SETTINGS)}>${ICON.gear}</button></div>
    <nav class="ptabs" aria-label="Bays" ref=${strip}>
      ${tab(only === null, 0, "All", null)}
      ${bays.map((b, i) => tab(only === b.name, i + 1, b.name, b, b.parked))}
    </nav>
    <${RailList} live=${live} hist=${hist} more=${more} only=${only} cursor=${cursor} say=${say} />
  </div>`;
}

const Keys = ({ k }) => k.split(" ").map((x) => (x === "…" ? html`<span class="to">…</span>` : html`<kbd>${x}</kbd>`));

function KeysOverlay({ onClose }) {
  const [q, setQ] = useState("");
  const groups = KEY_GROUPS.map(([g, note, rows]) => [g, note, rows.filter((r) => !q.trim() || keyMatches(q, [g, note], r))]).filter(([, , rows]) => rows.length);
  return html`
    <div class="keys-ov" onPointerDown=${onClose}>
      <div class="kp" role="dialog" aria-modal="true" aria-label="Keys" onPointerDown=${(e) => e.stopPropagation()}>
        <div class="kh"><h2>Keys</h2><label class="kf1">${ICON.search}<input ref=${focusOnMount} value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Type to filter: park, zen, answer…" aria-label="Filter the keys"
          onKeyDown=${(e) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), q ? setQ("") : onClose())} autocomplete="off" spellcheck="false" /></label>
          <span class="r"><button class="btn quiet sm" onClick=${onClose}>Close<kbd>esc</kbd></button></span></div>
        <div class="kg">${groups.map(([g, note, rows]) => html`
          <section><h3>${g}${note && html` <small>${note}</small>`}</h3><dl>${rows.map(([, k, what, alt]) => html`<dt><${Keys} k=${k} />${alt && html` <${Keys} k=${alt} />`}</dt><dd>${what}</dd>`)}</dl></section>`)}
          ${!groups.length && html`<p class="none">No key does “${q}”. <button class="vlink" onClick=${() => setQ("")}>Show every key</button></p>`}</div>
        <div class="kf">Every hint in atc reads from this table.</div>
      </div>
    </div>`;
}

const GROUPS = [["pinned", "Pinned"], ["waiting", "Waiting on you"], ["working", "Working"], ["cut", "Stopped unexpectedly"], ["parked", "Parked"], ["earlier", "Earlier"]];
const QWERTY = "qwertyuiop";
const endedAt = (s) => Date.parse(s.ended?.at || 0) || 0;
const unexpected = (s) => (s.state === "stopped" || s.state === "past") && !!s.ended?.unexpected;
const cutOff = (s) => unexpected(s) && !s.retired && !s.ended.dismissed && Date.now() - endedAt(s) < 7 * 86400000;
const onHost = (s) => (s.host ? `?host=${encodeURIComponent(s.host)}` : "");
const dismissEnded = (list, say, undo) => Promise.allSettled(list.map((s) => api(`/api/sessions/${s.sessionId}/ended/dismiss${onHost(s)}${undo ? `${s.host ? "&" : "?"}undo=1` : ""}`, { method: "POST" })))
  .then(() => !undo && say?.(list.length === 1 ? "Dismissed: it moves to Earlier." : `Dismissed ${list.length}: they move to Earlier.`, { undo: () => dismissEnded(list, say, true) }));
const groupOf = (s) => (away(s) ? "parked" : s.pinned ? "pinned" : waiting(s) ? "waiting" : s.state === "working" ? "working" : cutOff(s) ? "cut" : "earlier");
const byUrgency = (a, b) => (a.state === "needs-you" ? 0 : 1) - (b.state === "needs-you" ? 0 : 1) || (Date.parse(b.updated || 0) || 0) - (Date.parse(a.updated || 0) || 0);
const doingLine = (s) => s.state === "working" ? doing(s) : s.state === "needs-you" && s.asks?.[0] ? oneLine(s.asks[0].questions?.[0]?.question || (s.asks[0].permission && `Wants to use ${s.asks[0].permission}`)) : "";
const runningOf = (s) => [s.background?.length > 0 && plural(s.background.length, "task"), ...(s.servers || []).slice(0, 2).map((p) => `:${p}`), s.tabs?.length > 0 && plural(s.tabs.length, "tab")].filter(Boolean);

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
  const past = (hist || []).filter((s) => !ids.has(s.sessionId) && !doomed(s) && mine(s));
  const earlier = [...now.filter((s) => groupOf(s) === "earlier"), ...past.filter((s) => !cutOff(s))]
    .sort((a, b) => (Date.parse(b.updated || b.startedAt || 0) || 0) - (Date.parse(a.updated || a.startedAt || 0) || 0));
  const by = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const s of now) if (groupOf(s) !== "earlier") by[groupOf(s)].push(s);
  for (const k in by) by[k].sort(byUrgency);
  by.pinned.sort(byStart);
  by.earlier = earlier;
  by.cut.push(...past.filter(cutOff));
  by.cut.sort((a, b) => endedAt(b) - endedAt(a));
  return by;
}

function CardGist({ s }) {
  const [length, setLength] = useState(() => txPrefs.get().cards);
  useEffect(() => {
    const f = (e) => setLength(e.detail.cards);
    addEventListener("atc-txprefs", f);
    return () => removeEventListener("atc-txprefs", f);
  }, []);
  return length === "long" && waiting(s) && s.summary?.gist?.length > 0 && html`<span class="gl">${s.summary.gist.map((x) => html`<span>${x}</span>`)}</span>`;
}

const askLine = (s) => {
  const a = s.state === "needs-you" && s.asks?.[0];
  if (!a) return null;
  if (a.permission) { const cmd = (a.patterns || []).join(" "); return cmd ? html`Wants to run <code class="mono">${cmd}</code>` : `Wants to use ${toolName(a.permission)}`; }
  return oneLine(a.questions?.[0]?.question) || null;
};
const statusOf = (s) => (s.state === "needs-you" ? oneLine(s.summary?.status) || oneLine(s.preview || s.lastReply) || "Needs you" : headline(s)) || WORD[s.state] || "";
const lineOf = (s) => askLine(s) || (s.state === "working" ? doing(s) : cutOff(s) ? s.ended.text : statusOf(s));
const canResume = (s) => (s.state === "past" || s.state === "stopped") && !s.attachable && s.kind !== "interactive";
const resumeFrom = (s, say) => resumeSession(s).then((r) => go(r.id), (e) => say?.(e.message));
const branchOf = (s) => s.branch && !["HEAD", "main", "master"].includes(s.branch) && s.branch;
const swipeable = (s) => s.state !== "past" && s.state !== "stopped";

const DelX = ({ s, say }) => say && canDelete(s) && html`<button class="rdel" tabindex="-1" aria-label=${`Delete “${s.title || "Untitled"}”`} aria-keyshortcuts=${ariaKeys("delete")}
  title=${tip("delete", "Delete: its conversation stays in history")} onClick=${(e) => { e.stopPropagation(); deleteLater(s, say); }}>${ICON.x}</button>`;

function ResumeBtn({ s, say }) {
  const [busy, setBusy] = useState(false);
  return html`<button class="btn sm rsm" aria-busy=${busy} onClick=${(e) => { e.stopPropagation(); setBusy(true); resumeFrom(s, say).finally(() => setBusy(false)); }}>${ICON.play}Resume</button>`;
}

function RailRow({ s, sel, cursor, say, qk, when }) {
  const { events } = useRowEvents(s, null, swipeable(s));
  const on = sel?.sessionId === s.sessionId, fresh = unread(s), g = s.pinned && waiting(s) ? "pinned waiting" : groupOf(s);
  const line = lineOf(s), ask = say && s.state === "needs-you" && s.asks?.length > 0;
  return html`<div class="rr ${g} ${s.state} ${on ? "sel" : ""} ${cursor === s.sessionId ? "cur" : ""} ${fresh ? "fresh" : ""}">
    <button class="brow ${on ? "sel" : ""}" data-sid=${s.sessionId} aria-current=${on ? "true" : null} aria-description=${fresh ? "new since you looked" : null} ...${events}>
      <${StateBlock} s=${s} />
      <span class="r1"><span class="t" lang=${langOf(s.title)}>${s.title || "Untitled"}</span>
        <span class="ago" title=${stamp(rowAt(s))}>${fresh && html`<i class="dot" aria-hidden="true"></i>`}${when || ago(s)}</span></span>
      <span class="r2"><span class="s ${ask ? "q" : ""}" lang=${typeof line === "string" ? langOf(line) : null}>${line}</span>
        <span class="e2">${s.profile && html`<span class="prof" title=${`Runs on the ${s.profile} Claude account`}>${s.profile}</span>`}<${LoadTag} s=${s} short />${s.shown?.length > 0 && html`<span class="pg" title=${plural(s.shown.length, "page")}>${ICON.page}${s.shown.length > 1 && s.shown.length}</span>`}${qk && html`<kbd class="qk" aria-hidden="true">${qk}</kbd>`}</span></span>
    </button>
    ${canResume(s) && html`<${ResumeBtn} s=${s} say=${say} />`}
    <${DelX} s=${s} say=${say} />
    ${ask && html`<div class="rask"><${Ask} compact s=${s} a=${s.asks[0]} say=${say} /></div>`}
  </div>`;
}

function madeLine(s) {
  const pages = s.shown?.length || 0, files = s.files || 0, run = runningOf(s);
  const pg = pages > 0 && html`<a href=${pageLink(keyOf(s), s.shown[0].name)} onClick=${(e) => e.stopPropagation()}>${pages === 1 ? "a page" : plural(pages, "page")}</a>`;
  const made = (pg || files > 0) && html`Made ${pg}${pg && files > 0 && " and "}${files > 0 && plural(files, "file")}`;
  const parts = [
    s.steps > 0 && html`${plural(s.steps, "step")}${s.failed > 0 && html`, <span class="f">${s.failed} failed</span>`}`,
    run.length > 0 && html`running <span class="mono">${run.join(", ")}</span>`,
    made,
    s.context > 0 && html`<${CtxMeter} n=${s.context} /> ${Math.round(s.context / 1000)}k`,
  ].filter(Boolean);
  return parts.length ? parts.map((p, i) => html`${i > 0 && html`<span class="sep" aria-hidden="true"> · </span>`}<span class="part">${p}</span>`) : null;
}

function BoardRow({ s, open, toggle, sel, cursor, say, qk, when }) {
  const { events } = useRowEvents(s, () => toggle(s.sessionId), swipeable(s));
  const on = sel?.sessionId === s.sessionId, g = s.pinned && waiting(s) ? "pinned waiting" : groupOf(s), branch = branchOf(s);
  const where = [MULTI && s.host, s.profile, branch && clipPath(branch, 28, "-")].filter(Boolean).join(" · ");
  const fresh = unread(s), line = lineOf(s), ask = s.state === "needs-you" && s.asks?.length > 0;
  const meta = g !== "earlier" && madeLine(s), tags = s.load || cutOff(s);
  const owed = s.state !== "working" ? LIVE.filter((y) => y.reportsTo && y.reportsTo === (s.root || s.sessionId) && (y.state === "working" || y.state === "needs-you")) : [];
  const cls = `brow ${g} ${on ? "sel" : ""} ${cursor === s.sessionId ? "cur" : ""} ${open ? "open" : ""} ${fresh ? "fresh" : ""}`;
  return html`
    <div class="bwrap ${open ? "open" : ""} ${g} ${s.state}">
      <div class=${cls} data-sid=${s.sessionId} role="button" tabindex="0" aria-expanded=${open} aria-description=${fresh ? "new since you looked" : null} ...${events}
        onDblClick=${() => go(keyOf(s))} onKeyDown=${(e) => e.target === e.currentTarget && (e.key === "Enter" ? go(keyOf(s)) : e.key === " " && (e.preventDefault(), toggle(s.sessionId)))}>
        <${StateBlock} s=${s} />
        <span class="ses"><a class="t" lang=${langOf(s.title)} href=${`#/s/${keyOf(s)}`} onClick=${(e) => e.stopPropagation()}>${s.title || "Untitled"}</a>${where && html`<span class="w" title=${branch || null}>${where}</span>`}${s.lastFrom && html`<span class="from" title=${`The last message came from ${s.lastFrom}, not from you`}>${ICON.recv}${s.lastFrom}</span>`}${owed.length > 0 && html`<span class="from owed" title="It asked for these reports and they haven't come back yet">waiting on ${owed.map((y) => y.title || "a session").join(", ")}</span>`}</span>
        <span class="st"><span class="l1" lang=${typeof line === "string" ? langOf(line) : null}>${line}</span>${!open && html`<${CardGist} s=${s} />`}
          ${(meta || tags) && html`<span class="l2">${meta}<${LoadTag} s=${s} /><${EndTag} s=${s} /></span>`}
          ${ask && html`<div class="bask" onClick=${(e) => e.stopPropagation()} onPointerDown=${(e) => e.stopPropagation()}><${Ask} compact s=${s} a=${s.asks[0]} say=${say} /></div>`}</span>
        <span class="since" title=${stamp(rowAt(s))}><span>${fresh && html`<i class="dot" aria-hidden="true"></i>`}${when || ago(s)}</span>${qk && html`<kbd class="qk" aria-hidden="true">${qk}</kbd>`}</span>
      </div>
      ${canResume(s) && html`<${ResumeBtn} s=${s} say=${say} />`}
      <${DelX} s=${s} say=${say} />
      ${open && html`<div class="bexp">
        <div class="gx">
          ${s.summary?.gist?.length > 0 && html`<ul>${s.summary.gist.map((x) => html`<li>${x}</li>`)}</ul>`}
          <p class="facts">${[engineTag(s) || (s.model && model(s.model)), s.permissionMode === "bypassPermissions" ? "no permission prompts" : s.permissionMode, tilde(s.cwd || "")].filter(Boolean).join(", ")}</p>
        </div>
        <div class="ax">
          ${replyable(s) && html`<${CardReplies} s=${s} />`}
          <div class="acts"><button class="btn" onClick=${() => go(keyOf(s))}>Open</button>${cutOff(s) && html`<button class="btn" onClick=${() => dismissEnded([s], say)}>Dismiss</button>`}
            ${s.shown?.length > 0 && html`<button class="btn" onClick=${() => (location.hash = pageLink(keyOf(s), s.shown[0].name))}>${pageTitle(s.shown[0])}</button>`}</div>
        </div>
      </div>`}
    </div>`;
}

const GROUP_COUNT = { waiting: "n", working: "w" };
const GroupHead = ({ k, title, n, children }) => html`<h2 class="grp ${k}"><b>${title}</b><span class="c ${GROUP_COUNT[k] || ""}">${n}</span>${children}</h2>`;

function setParked(list, parked) {
  return Promise.allSettled(list.map((s) => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { parked } })))
    .then((r) => ({ done: list.filter((_, i) => r[i].status === "fulfilled"), bad: r.filter((x) => x.status === "rejected").length }));
}

function BayMore({ only, live, say, cls = "btn icon" }) {
  const counts = backlogCounts(useBacklog(), only);
  const mine = only ? (live || []).filter((s) => bayOf(s) === only) : [];
  const parkable = mine.filter((s) => !s.parked && s.kind !== "hub" && s.state !== "stopped" && s.state !== "past");
  const byPark = only ? (bayMem(only).parked || []).map((sid) => mine.find((s) => s.sessionId === sid && s.parked)).filter(Boolean) : [];
  const unparkAll = async (bay = only, list = byPark) => {
    const { done, bad } = await setParked(list, false);
    rememberBay(bay, { parked: [] });
    say(bad ? `Couldn't unpark ${bad} of ${list.length} in ${bay}.` : `Unparked ${done.length} in ${bay}.`);
  };
  const parkAll = async () => {
    const bay = only, { done, bad } = await setParked(parkable, true);
    rememberBay(bay, { parked: done.map((s) => s.sessionId) });
    say(bad ? `Couldn't park ${bad} of ${parkable.length} in ${bay}.` : `Parked ${done.length} in ${bay}.`, { undo: () => unparkAll(bay, done) });
  };
  return html`<${Menu} cls=${cls} aria=${only ? `More for ${only}` : "More"} title="Park all, Shell, Backlog" items=${[
    byPark.length > 0 && { label: "Unpark all", icon: "park", sub: `the ${byPark.length} your last Park all set aside`, run: () => unparkAll() },
    parkable.length > 0 && { label: "Park all", icon: "park", sub: "each comes back when it needs you", run: parkAll },
    "-",
    { label: "New shell", icon: "term", sub: "a plain login shell, no Claude", run: () => NEW_SHELL() },
    { label: "Backlog", icon: "inbox", sub: counts || "", run: () => (location.hash = BACKLOG) },
    { label: "Usage", icon: "chart", sub: "limits and the week", run: openUsage },
  ]} />`;
}

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayHead = (t) => (dayStart(t) === dayStart(Date.now() - 86400000) ? "Yesterday" : dayLabel(t));

function useHistorySearch(q, only) {
  const [res, setRes] = useState(null);
  useEffect(() => {
    if (!q.trim()) return setRes(null);
    const t = setTimeout(() => api(`/api/history?limit=40&q=${encodeURIComponent(q.trim())}`).then((l) => setRes(l || []), () => setRes([])), 150);
    return () => clearTimeout(t);
  }, [q]);
  if (!res) return null;
  const ids = new Set((LIVE || []).filter((s) => s.state !== "past" && s.state !== "stopped").map((s) => s.sessionId));
  const all = res.filter((s) => !ids.has(s.sessionId));
  return only ? [all.filter((s) => bayOf(s) === only), all.filter((s) => bayOf(s) !== only)] : [all, []];
}

function EarlierSection({ list, row, start = 0, sel, more }) {
  const [q, setQ] = useState("");
  const [olderOpen, flipOlder] = useEarlierOpen();
  const [shown, setShown] = useState(10);
  const found = useHistorySearch(q, BAY.only);
  if (!list.length && !q) return null;
  const t0 = startOfDay();
  const today = list.filter((s) => rowAt(s) >= t0), older = list.filter((s) => rowAt(s) < t0);
  let qn = start;
  const rows = (l, clock) => l.map((s) => row(s, QWERTY[qn++], clock && rowAt(s) < t0 ? hhmm(rowAt(s)) : ""));
  const byDay = (l) => {
    const out = [];
    let last = "";
    for (const s of l) { const d = dayHead(rowAt(s)); if (d !== last) out.push(html`<div class="eday" key=${`d${d}`}>${d}</div>`); last = d; out.push(...rows([s], true)); }
    return out;
  };
  const visible = older.slice(0, shown), selOlder = !olderOpen && older.find((s) => s.sessionId === sel?.sessionId);
  const canMore = older.length > shown || !!more;
  return html`<section class="earlier">
    <h2 class="grp earlierh"><b>Earlier</b><span class="c">${today.length ? `${today.length} today` : ""}</span></h2>
    <label class="efilter">${ICON.search}<input value=${q} placeholder="Search earlier sessions" aria-label="Search earlier sessions" autocomplete="off" spellcheck="false"
      onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.key === "Escape" && q && (e.stopPropagation(), setQ(""))} /></label>
    ${found ? html`
      ${found[0].length + found[1].length === 0 && html`<p class="enone">No earlier session matches “${q.trim()}”.</p>`}
      ${byDay(found[0])}
      ${found[1].length > 0 && html`<div class="eday">In other bays</div>${rows(found[1], true)}`}`
    : html`
      ${rows(today)}
      ${selOlder && rows([selOlder], true)}
      ${older.length > 0 && html`<button class="efold" aria-expanded=${olderOpen} onClick=${flipOlder}>${ICON.down}<b>Older</b><span class="c">${older.length}${more ? "+" : ""}</span></button>
        ${olderOpen && html`${byDay(visible)}${canMore && html`<button class="btn quiet emore" onClick=${() => (older.length > shown ? setShown(shown + 20) : more())}>${ICON.down}Show more</button>`}`}`}`}
  </section>`;
}

function BoardView({ live, hist, more, only, sel, cursor, say, index }) {
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
  const pinnedIn = { waiting: by.pinned.filter(waiting).length, working: by.pinned.filter((s) => s.state === "working").length };
  const n = (k) => by[k].length + (pinnedIn[k] || 0);
  const counts = [["waiting", "n", "waiting"], ["working", "w", "working"], ["cut", "f", "stopped"], ["parked", "", "parked"]].filter(([k]) => n(k) > 0);
  const path = only && (live || []).find((s) => bayOf(s) === only);
  const pages = index && [...new Map((live || []).filter((s) => (only ? bayOf(s) === only : !homeless(s))).flatMap((s) => (s.shown || []).map((p) => [pkey(p), { p, s }]))).values()]
    .sort((a, b) => (Date.parse(b.p.updated || b.p.shown) || 0) - (Date.parse(a.p.updated || a.p.shown) || 0));
  const row = (s, qk, when) => html`<${BoardRow} key=${s.sessionId} s=${s} open=${open.has(s.sessionId)} toggle=${toggle} sel=${sel} cursor=${cursor} say=${say} qk=${qk} when=${when} />`;
  const busy = GROUPS.filter(([k]) => k !== "earlier" && by[k].length);
  return html`
    <div class="bview ${index ? "withindex" : ""}">
      <div class="bmain" id="bscroll">
        <div class="bhead">
          <h1>${only || "Every bay"}</h1>${path && html`<span class="w" title=${tilde(baseDir(path.cwd))}>${clipPath(tilde(baseDir(path.cwd)))}</span>`}
          <span class="bcs">${counts.map(([k, c, w]) => html`<span class="bc ${c}">${n(k)} ${w}</span>`)}</span>
          <span class="r"><button class="btn quiet" onClick=${() => PALETTE_OPEN()} aria-keyshortcuts=${ariaKeys("palette")} title=${tip("palette", "Search and commands")}>${ICON.search}<span class="wide">Search</span></button>
            <${BayMore} only=${only} live=${live} say=${say} /><${BoardToggles} only=${only} />
            <button class="btn primary" onClick=${() => NEW_SESSION()} aria-keyshortcuts=${ariaKeys("new")} title=${tip("new")}>${ICON.plus}New session</button></span>
        </div>
        <div class="bcols" aria-hidden="true"><span></span><span>Session</span><span>Status</span><span>Since</span></div>
        ${busy.map(([k, title]) => html`<section class="bgrp ${k}">
          <${GroupHead} k=${k} title=${title} n=${by[k].length}>${k === "cut" && html`<button class="btn sm quiet seenall" title="Move all of these to Earlier: you know why they stopped and have decided what to do" onClick=${() => dismissEnded(by[k], say)}>Dismiss all</button>`}<//>
          ${by[k].map((s) => row(s, QWERTY[qn++]))}
        </section>`)}
        <${ShellGroup} />
        <${EarlierSection} list=${by.earlier} row=${row} start=${qn} sel=${sel} more=${more} />
        ${!busy.length && !by.earlier.length && html`<p class="calm">Nothing running${only ? ` in ${only}` : ""}. <button class="vlink" onClick=${() => NEW_SESSION()}>Start a session</button></p>`}
      </div>
      ${index && html`<aside class="pindex" aria-label="Pages">
        <div class="ph"><b>Pages</b><span>${pages.length ? `${plural(pages.length, "page")}, newest first` : "No pages yet"}</span></div>
        ${pages.map(({ p, s }) => html`<button class="pirow" onClick=${() => (location.hash = pageLink(keyOf(s), p.name))}>
          <span class="h"><b>${pageTitle(p)}</b><span class="ago" title=${stamp(p.updated || p.shown)}>${age(p.updated || p.shown)}</span></span>
          ${p.note && html`<span class="n">${p.note}</span>`}
          <span class="s">${s.title}</span>
        </button>`)}
      </aside>`}
    </div>`;
}

const useEarlierOpen = () => {
  const [open, set] = useState(() => stored("atc.earlier", false));
  return [open, () => { store("atc.earlier", !open); set(!open); }];
};

function RailList({ live, hist, more, only, sel, cursor, shell, say }) {
  const by = bayLists(live, hist, only);
  let qn = 0;
  const row = (s, qk, when) => html`<${RailRow} key=${s.sessionId} s=${s} sel=${sel} say=${say} cursor=${cursor} qk=${qk} when=${when} />`;
  const busy = GROUPS.filter(([k]) => k !== "earlier" && by[k].length);
  return html`<div class="rail" id="rscroll">
    ${busy.map(([k, title]) => html`<${GroupHead} k=${k} title=${title} n=${by[k].length}>${k === "parked" && html`<span class="r">to resume later</span>`}<//>
      ${by[k].map((s) => row(s, QWERTY[qn++]))}`)}
    <${ShellGroup} cur=${shell} />
    <${EarlierSection} list=${by.earlier} row=${row} start=${qn} sel=${sel} more=${more} />
    ${!busy.length && !by.earlier.length && html`<p class="calm">Nothing here yet. <button class="vlink" onClick=${() => NEW_SESSION()}>Start a session</button></p>`}
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

function LiveStrip({ s }) {
  const now = s.state === "needs-you" ? doingLine(s) || "Waiting on you" : doing(s);
  return html`<a class="ls ${s.state}" href=${`#/s/${keyOf(s)}`}><${StateBlock} s=${s} /><span class="ti" lang=${langOf(s.title)}>${s.title || "Untitled"}</span><span class="bayn">${bayOf(s) || ""}</span>
    <span class="now"><span>${now}</span><span class="el">${s.promptAt ? duration((Date.now() - Date.parse(s.promptAt)) / 1000) : ""}</span></span></a>`;
}

/** The line under the phone's sessions: a tick per session, then a ripple running into the call button. */
function HoldLine({ wait, work, end }) {
  const ref = useRef(null);
  const ticks = useRef();
  ticks.current = [wait, work];
  useEffect(() => {
    const cv = ref.current, g = cv.getContext("2d");
    const [line, amber, blue] = cssColors("dark", ["faint", "needs", "work"]);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf;
    const frame = (ms) => {
      const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1, w = Math.round(r.width * d), h = Math.round(r.height * d);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      g.setTransform(d, 0, 0, d, 0, 0);
      g.clearRect(0, 0, r.width, r.height);
      const stop = r.width - end, mid = r.height / 2, t = ms / 1000;
      g.strokeStyle = line;
      g.lineWidth = 1.5;
      g.beginPath();
      for (let x = 0; x <= stop; x += 2) {
        const u = x / stop, y = mid + u * u * (7 * Math.sin(u * 15 - t * 1.3) + 3 * Math.sin(u * 31 + t * 1.9));
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      const [a, b] = ticks.current, room = Math.floor((stop - 40) / 8);
      for (let i = 0; i < Math.min(a + b, room); i++) {
        g.fillStyle = i < a ? amber : blue;
        g.fillRect(16 + i * 8, mid - (i < a ? 8 : 4), i < a ? 4 : 3, i < a ? 16 : 8);
      }
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [end]);
  return html`<canvas ref=${ref} aria-hidden="true"></canvas>`;
}

function HoldRow({ s, say }) {
  const a = s.asks?.[0];
  const line = s.state === "working" ? doing(s) : headline(s);
  const open = (e) => { e.preventDefault(); location.replace(`#/s/${keyOf(s)}`); };
  return html`<div class="hr ${waiting(s) ? "wt" : ""} ${s.state}">
    <a href=${`#/s/${keyOf(s)}`} onClick=${open}><${StateBlock} s=${s} /><b>${s.title || "Untitled"}</b><span class="by">${bayOf(s) && html`<${IdTick} name=${bayOf(s)} />${bayOf(s)}`}</span>${!a && line && html`<span class="l">${line}</span>`}</a>
    ${a && s.state === "needs-you" && html`<${Ask} s=${s} a=${a} say=${say} compact />`}
  </div>`;
}

const holdEmpty = { wait: "Nothing is waiting on you.", work: "Nothing is running.", recent: "No sessions yet." };

/** What holding the phone's side key opens: how the machines stand, the sessions in three tabs, questions answered in place, the call under the thumb. */
function Hold({ live, me, down, limits, say }) {
  useCall();
  useNow(30000);
  useEffect(() => { if (Call.live()) location.replace(CALL); }, []);
  const brief = useMachineBrief();
  const open = (live || []).filter((s) => s.kind !== "hub");
  const wait = open.filter(waiting).sort((a, b) => (b.state === "needs-you") - (a.state === "needs-you") || byRecent(a, b));
  const work = open.filter((s) => s.state === "working" && !away(s)).sort(byRecent);
  const recent = [...open].sort(byRecent).slice(0, 12);
  const [picked, setTab] = useState(null);
  const tab = picked || (wait.length || !work.length ? "wait" : "work");
  const shown = { wait, work, recent }[tab];
  const call = callOrSetup;
  const to = (hash) => location.replace(hash);
  const sessions = () => { rememberBay(BAY.only, { view: "board" }); to("#/"); };
  const fresh = () => { to("#/"); NEW_SESSION(); };
  useKeyLayer((e) => {
    if (typingIn(e.target)) return false;
    if (e.key === "Escape") return window.leaveHold(), true;
    if (e.key === ".") return call(), true;
    if (e.key === "b") return sessions(), true;
    return false;
  });
  const used = Math.round(Math.max(-1, ...(limits?.windows || []).filter((w) => SHORT[w.key]).map((w) => w.percent)));
  const mem = brief?.machine?.memTotal ? Math.round((brief.machine.memUsed / brief.machine.memTotal) * 100) : -1;
  const offline = down.map((p) => p.name);
  const tile = (label, pct, hash) => html`<button class="htile" onClick=${() => to(hash)}><span>${label}</span><b>${pct < 0 ? "--" : `${pct}%`}</b><${Meter} p=${Math.max(pct, 0)} /></button>`;
  const tabBtn = (id, label, n, cls) => html`<button aria-pressed=${tab === id} onClick=${() => setTab(id)}>${label}${n > 0 && html`<i class=${cls}>${n}</i>`}</button>`;
  return html`<div class="hold">
    <div class="htiles">
      ${(me.hosts || [me.host]).filter(Boolean).map((h) => { const off = offline.includes(h); return html`<div class="htile host"><span>${h}</span><b class=${off ? "off" : "up"}>${off ? "down" : "up"}</b></div>`; })}
      ${tile("usage", used, USAGE)}
      ${tile("mem", mem, RESOURCES)}
    </div>
    <div class="htabs"><span class="seg" role="group" aria-label="Show">
      ${tabBtn("wait", "Waiting", wait.length, "a")}
      ${tabBtn("work", "Working", work.length, "w")}
      ${tabBtn("recent", "Recent", 0)}
    </span></div>
    <div class="hlist">
      ${!live ? [1, 2, 3].map(() => html`<div class="hr sk" aria-hidden="true"><i></i><i></i></div>`)
        : shown.length ? shown.map((s) => html`<${HoldRow} key=${s.sessionId} s=${s} say=${say} />`)
        : html`<p class="none">${holdEmpty[tab]}</p>`}
    </div>
    <div class="hband">
      <div class="hbase">
        <${HoldLine} wait=${wait.length} work=${work.length} end=${72} />
        <button class="sess" onClick=${sessions}><b>Sessions</b><span class="c"><span class="a"><em>${wait.length}</em> waiting</span><span class="w"><em>${work.length}</em> working</span></span></button>
        <button class="dial" onClick=${call} aria-label="Call the assistant" aria-keyshortcuts=".">
          ${ICON.phone}</button>
      </div>
      <div class="hkeys">
        <button onClick=${() => to(ASSIST)}>${ICON.mic}Assistant</button><button onClick=${fresh}>${ICON.plus}New</button><button onClick=${() => to(pagesHash())}>${ICON.page}Pages</button><button onClick=${() => to(BACKLOG)}>${ICON.inbox}Backlog</button>
      </div>
    </div>
  </div>`;
}

function AssistantView({ hub, live, loaded, say, panes, togglePane }) {
  const phone = usePhone();
  useCall();
  const docked = useCallDock() && Call.live() && !phone;
  const [sheet, setSheet] = useState(false);
  const [leftCall, setLeftCall] = useState(false);
  const left = docked ? leftCall : panes.aleft;
  const asked = useRef(false);
  useNow(30000);
  useEffect(() => {
    if (!loaded || hub || asked.current) return;
    asked.current = true;
    api("/api/assist", { method: "POST" }).catch((e) => say(`Couldn't start the assistant: ${e.message}`));
  }, [loaded, !!hub]);
  useKeyLayer((e) => {
    if (typingIn(e.target)) return false;
    if (e.key === "Escape") return !docked && (closeAssistant(), true);
    if (e.key === "[") return (docked ? setLeftCall((v) => !v) : togglePane("aleft")), true;
    if (e.key !== "." || Call.live()) return false;
    if (!e.repeat) callOrSetup();
    return true;
  });

  const since = startOfDay();
  const touched = touchedBy(hub, live, since);
  const groups = [
    ["waiting", "Waiting on you", touched.filter(waiting)],
    ["working", "Working", touched.filter((s) => s.state === "working")],
    ["ended", "Ended", touched.filter((s) => !waiting(s) && s.state !== "working")],
  ];
  const pane = html`<aside class="aleft side" aria-label="Touched today">
    <div class="ph"><b>Touched today</b><span class="w">${touched.length}</span></div>
    <div class="rail" onClick=${(e) => e.target.closest("a") && setSheet(false)}>
      ${groups.filter((g) => g[2].length).map(([k, title, l]) => html`<${GroupHead} k=${k} title=${title} n=${l.length} />${l.map((s) => html`<${RailRow} key=${s.sessionId} s=${s} say=${say} />`)}`)}
      ${touched.length ? html`<p class="anote">Sessions the assistant started or messaged since ${hhmm(since)}.</p>`
        : html`<${Empty}>No sessions touched today yet. Sessions it starts or tells show here.<//>`}
    </div>
  </aside>`;

  const busy = touched.filter((s) => s.state === "working" || s.state === "needs-you").slice(0, 3);
  const strips = busy.length > 0 && html`<div class="alive" aria-label="What it set going">${busy.map((s) => html`<${LiveStrip} s=${s} />`)}</div>`;
  const onCall = Call.live();
  const cmp = {
    prompt: onCall ? html`<span class="apr call"><${CallMark} />${!docked && html`<${Trace} />`}</span>` : null,
    hint: onCall ? "Type while you talk" : "Ask the assistant",
    top: strips,
  };
  const woke = hub?.startedAt;
  const menu = [
    hub && { label: "Zen", icon: "zen", key: "zen", run: () => TX_API?.zen() },
    hub && { label: "Find in the transcript", icon: "search", key: "find", run: () => TX_API?.find() },
    phone && { label: "Touched today", icon: "list", run: () => setSheet(true) },
    !phone && { label: "Close", icon: "x", run: closeAssistant, sub: "esc" },
  ];
  return html`<div class="shell assistv assist ${left && !phone ? "" : "noleft"}">
    ${left && !phone && pane}
    <main class="amain">
      <header class="hd">
        <div class="l1">
          ${hub ? html`<${StateBlock} s=${hub} />` : html`<span class="sb earlier" aria-hidden="true">E</span>`}
          <h1>Assistant</h1>
          <span class="where">${[hub?.host || (MULTI ? HERE : ""), woke && `since ${hhmm(woke)}`].filter(Boolean).join(" · ")}</span>
          <span class="r">
            ${onCall ? html`<button class="btn quiet" onClick=${returnToCall} title="Back to the call (.)">${ICON.phone}On a call</button>`
              : html`<button class="btn primary" onClick=${callOrSetup} aria-keyshortcuts="." title=${tip("call", "Call the assistant")}>${ICON.phone}Call</button>`}
            ${!phone && !docked && html`<${PaneToggle} id="touched" on=${panes.aleft} run=${() => togglePane("aleft")} icon="rail" label="Sessions it started or told today" />`}
            <div class="more"><${Menu} cls="btn quiet icon" aria="Assistant menu" width=${220} items=${menu} /></div>
          </span>
        </div>
      </header>
      ${hub ? html`<${Transcript} key=${hub.sessionId} s=${hub} say=${say} cmp=${cmp} />`
        : html`<div class="blank">${loaded ? "Starting the assistant…" : "Opening…"}</div>`}
    </main>
    ${sheet && html`<${Sheet} cls="asheet" title="Touched today" onClose=${() => setSheet(false)}>${pane}<//>`}
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
const callDoing = (f) => ({
  hearing: "Hearing you",
  thinking: "Thinking",
  tool: `Using ${(f.tool.split("__").pop() || "a tool").replace(/_/g, " ")}`,
  speaking: "Speaking",
})[f.state] || "Listening";
const callWord = (st, f) => st.phase === "ringing" ? st.reason || "calling you"
  : st.phase === "calling" ? st.reason || "calling"
  : st.phase === "ended" ? `call ended${st.why ? `: ${st.why}` : ""}`
  : st.phase !== "active" ? (CAN_CALL ? "not on a call" : "calls need atc's call line and a microphone")
  : st.muffled ? "tap anywhere to hear the call"
  : f.moving ? `connecting to ${onLine(f)}`
  : st.talking ? "talking, let go to send"
  : st.muted ? "muted" : ({ hearing: "hearing you", thinking: "thinking", tool: "working", speaking: st.ptt ? "speaking, hold to cut in" : "speaking, tap to stop it" })[f.state] || (st.ptt ? "hold to talk" : "listening");

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
  if (st.phase === "ringing") return html`<span class="oncall ring"><b>Calling you…</b></span>`;
  return html`<span class="oncall"><b>On a call</b><span class="tm">${st.phase === "active" ? duration((Date.now() - st.since) / 1000) : "ringing"}</span></span>`;
}

function useCallKeys(onEsc, esc) {
  useKeyLayer((e) => {
    if (!Call.live() || typingIn(e.target)) return false;
    if (e.key === "m") return Call.mute(), true;
    if (e.key === "t") return Call.togglePtt(), true;
    if (e.key === " " && Call.get().ptt) return Call.press(), true;
    if (e.key === "E") return Call.hangup(), true;
    if (e.key === "A") return Call.answer(), true;
    if (e.key === ".") return returnToCall(), true;
    if (e.key === "Escape" && esc) return onEsc(), true;
    return false;
  });
}

/** The talk button: the mic is open only while it is held, and letting go sends what was said. */
function TalkButton({ small }) {
  const [st] = useCall();
  return html`<button class="btn talkb ${small ? "small" : ""} ${st.talking ? "on" : ""}" aria-pressed=${st.talking} disabled=${st.phase !== "active"}
    onPointerDown=${(e) => { e.currentTarget.setPointerCapture(e.pointerId); Call.press(); }}
    onPointerUp=${Call.release} onPointerCancel=${Call.release} onLostPointerCapture=${Call.release}
    onContextMenu=${(e) => e.preventDefault()} aria-keyshortcuts="Space" title="Hold to talk (space)">
    ${ICON.mic}${st.talking ? (small ? "Talking" : "Talking, let go to send") : (small ? "Talk" : "Hold to talk")}</button>`;
}

const MuteButton = ({ st, cls = "btn" }) => html`<button class="${cls} ${st.muted ? "on" : ""}" aria-pressed=${st.muted} onClick=${Call.mute} aria-keyshortcuts="m" title=${tip("mute")}>${ICON.muted}${st.muted ? "Unmute" : "Mute"}</button>`;
const EndButton = ({ cls = "btn" }) => html`<button class="${cls} end" onClick=${Call.hangup} aria-keyshortcuts="Shift+E" title=${tip("hangup")}>${ICON.x}End</button>`;

/** Who the call is with: the assistant and the agents that can talk. A tap moves the line; saying so does the same. */
function LineStrip() {
  const [st, f] = useCall();
  const [agents, setAgents] = useState([]);
  const active = st.phase === "active";
  useEffect(() => {
    if (!active) return;
    let off = false;
    const load = () => api("/api/agents").then((l) => { if (!off) setAgents((l || []).filter((a) => a.talk && !a.error)); }, () => {});
    load();
    const t = setInterval(load, 15000);
    return () => { off = true; clearInterval(t); };
  }, [active]);
  if (!active || !agents.length) return null;
  const chip = (name, label, note) => html`<button class="lchip ${f.line === name ? "on" : ""} ${f.line === name && f.moving ? "moving" : ""}" aria-pressed=${f.line === name} disabled=${f.line === name} onClick=${() => callAgent(name)}>
    ${label}${note && html`<em>${note}</em>`}</button>`;
  return html`<div class="lstrip" role="group" aria-label="Who the call is with">
    ${chip("assistant", "Assistant", f.knock && f.line !== "assistant" ? "wants you" : "")}
    ${agents.map((a) => chip(a.name, a.title || a.name, a.state === "working" && f.line !== a.name ? "busy" : ""))}
  </div>
  ${f.knock && f.line !== "assistant" && html`<p class="lknock" aria-live="polite">Assistant: ${f.knock}</p>`}`;
}

/** The call so far, under the persona. It follows the end unless you scrolled back, until you next speak. */
function CallLog({ f }) {
  const ref = useRef(null);
  const following = useRef(true);
  const turns = f.hearing ? extended(f.log, "you", "you", f.hearing) : f.log;
  const yours = f.log.filter((t) => t.by === "you").length;
  useLayoutEffect(() => { following.current = true; }, [yours]);
  useLayoutEffect(() => { if (following.current) ref.current.scrollTop = ref.current.scrollHeight; });
  const onScroll = (e) => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; };
  const speaking = f.state === "speaking";
  return html`<div class="caps" role="log" ref=${ref} onScroll=${onScroll}>
    ${turns.map((t, i) => {
      const end = i === turns.length - 1;
      return html`<div class="cap ${t.by} ${end ? "" : "past"}"><span class="w">${t.who}</span><p>${t.parts.map((part, j) => {
        const newest = end && j === t.parts.length - 1;
        const heard = newest && t.by === "you" && !!f.hearing;
        return html`<span class=${heard ? "heard" : end && speaking && t.by === "it" && !newest ? "spoken" : ""}>${part}${(heard || (newest && speaking && t.by === "it")) && html`<i class="caret"></i>`} </span>`;
      })}</p></div>`;
    })}
  </div>`;
}

/** The call itself: the persona, what it is doing now, the conversation when it is not beside it, and the controls. */
function CallPanel({ hub, live, captions, full, onMin }) {
  const [st, f] = useCall();
  const look = usePersona(f.lang, f.person, f.background);
  const [opts, setOpts] = useState(false);
  useNow(1000);
  const on = Call.live();
  const who = look.person ? `${onLine(f)}, ${look.person.name}` : onLine(f);
  const mine = on && f.line === "assistant" ? touchedBy(hub, live, st.since || Date.now()) : [];
  const busy = st.phase === "active" && !f.moving && !st.muted && !st.talking && f.state !== "speaking";
  const word = busy && f.state === "tool" ? callDoing(f) : busy && f.line === "assistant" && hub?.state === "working" && hub.activity ? doing(hub) : callWord(st, f);
  return html`<aside class="callp ${full ? "full" : ""} ${st.phase}" aria-label=${`Call with ${onLine(f)}`}>
    <div class="cph">
      ${on ? html`<${CallMark} /><span class="w">${who}</span>` : html`<b>${st.phase === "ended" ? "Call ended" : "Call"}</b><span class="w">${who}</span>`}
      <span class="sp"></span>
      <button class="kb" onClick=${onMin} aria-keyshortcuts="Escape" title="Close (esc)">${on ? "Minimize" : "Close"}</button>
    </div>
    <div class="cpers">
      <div class="fr"><${Persona} look=${look} state=${f.state} on=${st.phase === "active"} onTap=${Call.interrupt} /></div>
      <div class="cview"><${Seg} label="View" value=${look.view} set=${look.setView} options=${VIEWS} /></div>
      <p class="st" aria-live="polite">${word}</p>
    </div>
    ${opts && html`<${CallPicks} look=${look} onClose=${() => setOpts(false)} />`}
    ${!opts && html`<${LineStrip} />`}
    ${mine.length > 0 && !opts && html`<div class="cnow">
      <div class="h">${plural(mine.length, "session")} on this call</div>
      <ol class="plan">${mine.map((s, i) => html`<li class=${s.state === "working" ? "run" : ""}>
        <span>${i + 1}</span><a href=${`#/s/${keyOf(s)}`}>${s.title || "Untitled"}</a><em>${away(s) ? "parked" : WORD[s.state] || "earlier"}</em></li>`)}</ol>
    </div>`}
    ${captions && on && !opts && html`<${CallLog} f=${f} />`}
    ${on && st.ptt && html`<div class="ctalk"><${TalkButton} /></div>`}
    <div class="ctl ${on ? "live" : ""}">
      ${st.phase === "ringing" ? html`<${RingButtons} />` : on ? html`
        ${!st.ptt && html`<${MuteButton} st=${st} />`}
        <button class="btn icon ${st.ptt ? "on" : ""}" aria-pressed=${st.ptt} aria-label="Push to talk" onClick=${Call.togglePtt} aria-keyshortcuts="t" title=${tip("ptt", "Push to talk: the microphone stays closed unless you hold Talk")}>${ICON.mic}</button>
        <button class="btn icon ${opts ? "on" : ""}" aria-pressed=${opts} aria-label="Person" onClick=${() => setOpts(!opts)} title="Who the assistant is in each language: character, room and voice">${ICON.user}</button>
        <${EndButton} />`
      : st.phase !== "ended" && html`<button class="btn primary" onClick=${callOrSetup}>${ICON.phone}Call the assistant</button>
        <button class="btn ${opts ? "on" : ""}" aria-pressed=${opts} onClick=${() => setOpts(!opts)}>${ICON.user}Person</button>`}
    </div>
  </aside>`;
}

function RingButtons({ small }) {
  const cls = small ? "btn sm" : "btn";
  return html`<button class="${cls} end" onClick=${Call.hangup} aria-keyshortcuts="Shift+E" title="Decline (shift e)">${ICON.x}Decline</button>
    <button class="${cls} answer" onClick=${Call.answer} aria-keyshortcuts="Shift+A" title=${tip("pickup")}>${ICON.phone}Answer</button>`;
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
    <button class="back" onClick=${returnToCall} aria-label="Back to the call"><${CallMark} /><${Trace} /><span class="w">${onLine(Call.face())}</span></button>
    ${Call.get().phase === "ringing" ? html`<${RingButtons} />`
      : html`${Call.get().ptt && html`<${TalkButton} small />`}<${EndButton} />`}
  </div>`;
}

/** Desktop: the console line while on a call. The line moves only when the panel is minimized, since the persona moves otherwise. */
function CallLine({ docked }) {
  const f = Call.face(), st = Call.get();
  return html`<footer class="console callline" aria-label="Call">
    <button class="back" onClick=${returnToCall} aria-keyshortcuts="." title=${docked ? "The call" : "Back to the call"}>
      <${CallMark} />${!docked && html`<${Trace} />`}<span class="w">${onLine(f)}</span><span class="said">${st.phase === "ringing" ? st.reason : f.said || callDoing(f)}</span></button>
    ${!docked && html`<button class="btn sm quiet" onClick=${returnToCall} tabindex="-1" title="Back to the call (.)">Return</button>`}
    ${st.phase === "ringing" ? html`<${RingButtons} small />` : html`${st.ptt ? html`<${TalkButton} small />` : html`<${MuteButton} st=${st} cls="btn sm" />`}
    <${EndButton} cls="btn sm" />`}
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
const PERSONAS_UNKNOWN = { names: ["orb"], kinds: {}, def: "orb" };
const personaPick = {
  get: () => { try { return localStorage.getItem("atc.persona"); } catch { return null; } },
  set: (n) => { try { localStorage.setItem("atc.persona", n); } catch {} },
};

async function personaList() {
  const index = await (await fetch(PERSONAS + "index.json")).json();
  const all = index.personas || [];
  const kinds = await Promise.all(all.map(({ name }) => fetch(`${PERSONAS}${name}/persona.json`).then((r) => r.json()).then((p) => p.kind).catch(() => null)));
  const usable = all.map((p, i) => [p.name, kinds[i]]).filter(([, k]) => ["illustration", "footage", "rig"].includes(k));
  return { names: ["orb", ...usable.map(([n]) => n)], kinds: Object.fromEntries(usable), revs: Object.fromEntries(all.map((p) => [p.name, p.rev])), def: index.default || "orb" };
}

const kept = (k, or) => { try { return JSON.parse(localStorage.getItem(k)) ?? or; } catch { return or; } };

/** Who is on the line: `own` when an agent there names a person (`ownRoom` when it overrides their background), else who the assistant is in `lang` (before a call says,
 *  the language the last one opened in). And what that person looks like: their character and background, or with nobody picked for the language the character kept in this browser. The
 *  lists are kept too and trusted until the server has answered, so a screen never opens on the orb by mistake. */
function usePersona(lang, own, ownRoom) {
  const [list, setList] = useState(() => kept("atc.personas", PERSONAS_UNKNOWN));
  const [doc, setDoc] = useState(() => kept("atc.persons", { persons: [], langs: {} }));
  const [answered, setAnswered] = useState(false);
  const [name, setName] = useState(personaPick.get);
  const [view, setViewNow] = useState(() => { try { return localStorage.getItem("atc.callView") || "character"; } catch { return "character"; } });
  const setView = (v) => { try { localStorage.setItem("atc.callView", v); } catch {} setViewNow(v); };
  const keep = (d) => {
    setDoc(d);
    try { localStorage.setItem("atc.persons", JSON.stringify(d)); } catch {}
    return d;
  };
  useEffect(() => {
    api("/api/call/persons").then(keep, () => {});
    personaList().then((l) => {
      setList(l);
      try { localStorage.setItem("atc.personas", JSON.stringify(l)); } catch {}
    }).catch(() => {}).finally(() => setAnswered(true));
  }, []);
  const speaking = lang || (() => { try { return localStorage.getItem("atc.callLang"); } catch { return null; } })() || "";
  const person = doc.persons.find((p) => p.id === own) || personOf(doc, speaking);
  const want = person?.character ?? (VIEWS.some(([v]) => v === name) ? null : name) ?? list.def;
  const shown = !answered || list.names.includes(want) ? want : "orb";
  const choose = (l, id) => api("/api/call/persons/pick", { method: "POST", body: { lang: l, id } }).then(keep);
  return { names: list.names, kinds: list.kinds, shown, revs: list.revs, background: ownRoom || person?.background || "", doc, keep, person, lang: speaking, choose,
    view, setView, mark: view !== "character" ? view : null, framed: shown !== "orb" && view === "character" };
}

/** The call's persona slot. Holding it (or a right click) switches to the next view. */
function Persona({ look, state, on, onTap }) {
  const { shown, background, framed, mark } = look;
  const [label, setLabel] = useState(null);
  const hold = useRef(null);
  const held = useRef(false);
  const next = (e) => {
    e?.preventDefault();
    const v = nextView(look.view);
    look.setView(v);
    setLabel(VIEWS.find(([k]) => k === v)[1]);
    setTimeout(() => setLabel(null), 1200);
  };
  const down = () => { held.current = false; hold.current = setTimeout(() => { held.current = true; next(); }, 600); };
  const up = () => clearTimeout(hold.current);
  const tap = () => { if (!held.current) onTap(); };
  return html`<div class="orb persona ${framed ? "framed" : ""}" onPointerDown=${down} onPointerUp=${up} onPointerLeave=${up} onContextMenu=${next}>
    ${mark ? html`<${Mark} key=${mark} style=${mark} state=${state} on=${on} onTap=${tap} />` : shown === "orb" ? html`<${Orb} full state=${state} on=${on} onTap=${tap} />` : html`<${Drawn} key=${`${shown}|${background}`} name=${shown} background=${background} state=${state} on=${on} onTap=${tap} />`}
    ${label && html`<span class="personaname">${label}</span>`}
  </div>`;
}

/** Who the assistant is in each language, in the call panel: a pick shows at once if it is the language being spoken, and
 *  its voice speaks from the next reply. Making and changing persons is Settings' Persons page. */
function CallPicks({ look, onClose }) {
  const [voices, setVoices] = useState(null);
  const [note, setNote] = useState("");
  const [playing, play] = useSample(voices, setNote);
  useEffect(() => { api("/api/call/voices").then(setVoices, () => setNote("The voices are not reachable.")); }, []);
  useKeyLayer((e) => e.key === "Escape" && !typingIn(e.target) && (onClose(), true));
  const { doc } = look;
  const use = async (lang, p) => {
    try { await look.choose(lang, p.id); setNote(`${p.name} speaks ${langName(lang)} from the next reply.`); }
    catch (e) { setNote(`Couldn't switch: ${e.message}`); }
  };
  return html`<div class="picks" role="region" aria-label="Persons">
    <div class="pkh"><b>Person</b><button class="kb" onClick=${onClose} aria-keyshortcuts="Escape" title="Done (esc)">Done</button></div>
    ${doc.persons.length === 0 && html`<p class="sub">Nobody yet. A person is a name, a character, a room and a voice for each language.</p>`}
    ${doc.persons.length > 0 && personLangs(voices, doc).map((lang) => { const all = speakers(doc, lang); return html`
      <h3 class="grp"><b>${langName(lang)}</b><span class="c">${all.length}</span></h3>
      <div role="radiogroup" aria-label=${`The assistant in ${langName(lang)}`}>
        ${all.length === 0 && html`<p class="sub">Nobody has a voice in this language yet.</p>`}
        ${all.map((p) => { const on = doc.langs[lang] === p.id, v = p.voices[lang], k = `${lang}:${v}`; return html`
          <div class="vpick ${on ? "on" : ""}">
            <button class="pick ${on ? "on" : ""}" role="radio" aria-checked=${on} onClick=${() => use(lang, p)}><b>${p.name}</b><span>${voiceName(v)}</span></button>
            <button class="kb" aria-pressed=${playing === k} disabled=${!voices?.[lang]?.sample} onClick=${() => play(lang, v)}>${playing === k ? "Stop" : "Play"}</button>
          </div>`; })}
      </div>`; })}
    <div class="row"><a class="btn" href="#/settings/persons">${doc.persons.length ? "Edit persons" : "Make a person"}</a></div>
    ${note && html`<p class="sub" role="status">${note}</p>`}
  </div>`;
}

/** A person as a call would show them, in the editor. */
function PersonPreview({ character, background }) {
  const none = () => {};
  return character === "orb" ? html`<${Orb} full state="listening" on onTap=${none} />`
    : html`<${Drawn} key=${`${character}|${background}`} name=${character} background=${background} state="listening" on onTap=${none} />`;
}

function SettingsPersons({ sub }) {
  const look = usePersona("");
  return html`<${PersonsPage} api=${api} look=${look} sub=${sub} Preview=${PersonPreview} go=${(h) => { location.hash = h; }} />`;
}

/** The line or bars view: only a mark that moves with the voices, for a call in public. */
function Mark({ style, state, on, onTap }) {
  const ref = useRef(null);
  const now = useRef(state);
  now.current = state;
  useEffect(() => minimal(ref.current, { style }, () => { const [you, it] = Call.levels(); return { state: now.current, you, it }; }), [style]);
  return html`<canvas ref=${ref} class="orb ${on ? "" : "idle"}" onClick=${onTap} aria-label="The assistant. Tap to stop it while it speaks"></canvas>`;
}

function Drawn({ name, background, state, on, onTap }) {
  const ref = useRef(null);
  const now = useRef(state);
  now.current = state;
  useEffect(() => {
    let stop = null, gone = false;
    persona(ref.current, `${PERSONAS}${name}/`, () => { const [you] = Call.levels(), [it, lo, hi] = Call.speech(); return { state: now.current, you, it, lo, hi }; }, { background: background && ROOMS + background })
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
    <div class="app login">
      <nav class="bays"><span class="brand"><span class="on">atc on</span>${location.hostname}</span></nav>
      <main class="lstage">
        <form class="lbox" onSubmit=${submit}>
          <span class="mark" aria-hidden="true">atc</span>
          <h1>Log in to atc</h1>
          <p class="lede">This device has no token for this server yet.</p>
          <label for="ltok">Token</label>
          <div class="frm">
            <input id="ltok" type="password" autocomplete="current-password" placeholder="Paste a token" value=${tok} onInput=${(e) => setTok(e.target.value)} ref=${focusOnMount} />
            <button class="btn primary">Log in</button>
          </div>
          ${err && html`<p class="err" role="alert">${err}</p>`}
          <div class="ways">
            <div class="h">Two ways to get one</div>
            <div class="w">${ICON.term}<div>On this server, run <code>atc token</code> and paste what it prints.</div></div>
            <div class="w">${ICON.link}<div>On a device that is logged in: <b>Settings, Devices, Pair by QR</b>, then scan it here.</div></div>
          </div>
        </form>
      </main>
      <footer class="console"><span class="last">Not logged in on this device.</span><span class="addr">${location.origin}</span></footer>
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

const svgIcon = (d) => html`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: d }}></svg>`;
const ICON = Object.fromEntries(Object.entries(ICON_PATHS).map(([k, d]) => [k, svgIcon(d)]));

const cmdName = (c) => {
  const seg = c.split(/&&|\|\||;|\|/).map((x) => x.trim()).find((x) => x && !/^(cd|export|set|[A-Z_]+=\S*)(\s|$)/.test(x)) || c;
  return seg.replace(/^((sudo|env|time|nohup|timeout\s+\S+)\s+)+/, "").split(/\s+/)[0].split("/").pop();
};

function doing(s) {
  const [, mcp, args] = (s.activity || "").match(/^(mcp__\S+)\s*(.*)$/) || [];
  if (mcp) return args ? `${toolName(mcp)}: ${oneLine(args)}` : toolName(mcp);
  const a = oneLine(s.activity), m = a.match(/^(\w+)\s+(.+)$/);
  if (!m) return a || "Working…";
  const [, tool, rest] = m, file = rest.split("/").filter(Boolean).pop();
  if (tool === "Bash") return /[&|;$<>`]|^(cd|cat|sed|grep|ls|find|curl|git|ssh|python3?|node|go|make|npm|uv)\s/.test(rest) ? `Running ${cmdName(rest)}` : rest;
  return { Read: `Reading ${file}`, Edit: `Editing ${file}`, MultiEdit: `Editing ${file}`, Write: `Writing ${file}`, Grep: `Searching for ${rest}`,
    Glob: `Looking for ${rest}`, WebFetch: `Reading ${rest}`, WebSearch: `Searching the web for ${rest}`, Agent: `Agent: ${rest}`, Task: `Agent: ${rest}` }[tool]
    || `${toolName(tool)}: ${rest}`;
}

const headline = (s) => {
  if (s.state === "needs-you" && s.activity) return `Waiting on you: ${oneLine(s.activity).replace(/^AskUserQuestion\s+/, "")}`;
  const t = s.summary?.status?.replace(/^[A-Z][a-z]+:\s+/, "") || oneLine(s.preview || s.lastReply) || oneLine(s.lastPrompt);
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
  const menu = (e) => { e?.preventDefault(); e?.stopPropagation(); QUICK(s, e?.clientX ? { left: e.clientX, top: e.clientY, bottom: e.clientY } : e?.currentTarget?.getBoundingClientRect()); };
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
let openAgent = () => {};
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
const IdTick = ({ name, hue }) => html`<i class="idtick" style=${`--idc: ${idColor(hue ?? hueOf(name))}`} aria-hidden="true"></i>`;
const distinctHues = (names) => {
  const used = new Set();
  return new Map(names.map((n) => {
    let i = HUES.indexOf(hueOf(n));
    for (let k = 0; used.has(HUES[i]) && k < HUES.length; k++) i = (i + 1) % HUES.length;
    used.add(HUES[i]);
    return [n, HUES[i]];
  }));
};
const RANK = { "needs-you": 0, "your-turn": 1, working: 2 };
function projectTabs(live, keep) {
  const by = new Map();
  for (const x of live) {
    if (x.state === "past" || x.state === "stopped" || homeless(x)) continue;
    const n = projectOf(x);
    if (!by.has(n)) by.set(n, { name: n, pips: [], own: false, n: 0, resting: 0 });
    const t = by.get(n);
    t.own ||= !x.agent;
    t.n++;
    if (!countsOnBay(x)) t.resting++;
    if (countsOnBay(x) && RANK[x.state] !== undefined) t.pips.push(x.state);
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

const resumeSession = (s) => api(`/api/sessions/${s.sessionId}/resume`, { method: "POST" });
const openTerm = (s, tries = 30) => {
  if (!SESSION_API || SESSION_API.s.sessionId !== s.sessionId) go(keyOf(s));
  const t = () => (SESSION_API?.s.sessionId === s.sessionId ? SESSION_API.canAttach && SESSION_API.mode("term") : tries-- > 0 && setTimeout(t, 100));
  t();
};

const DOOMED = new Map();
let SHOW_LIVE = () => {};
const doomed = (x) => DOOMED.has(x.sessionId);
const canDelete = (s) => !!s.id && !s.private && s.kind !== "hub";
const isOpen = (s) => [s.id, s.sessionId].some((k) => k && location.hash.startsWith(`#/s/${k}`));
function deleteLater(s, say, leave) {
  if (DOOMED.has(s.sessionId)) return Promise.resolve(false);
  return ask({ title: `Delete “${s.title || "Untitled"}”?`, body: "Its conversation stays in history, where you can resume it.", ok: "Delete", danger: true })
    .then((ok) => { if (ok) dropSession(s, say, leave); return !!ok; });
}

function dropSession(s, say, leave) {
  if (DOOMED.has(s.sessionId)) return;
  if ((leave || isOpen(s)) && location.hash) (leave || backHome)();
  DOOMED.set(s.sessionId, s);
  SHOW_LIVE();
  api(`/api/sessions/${s.id}`, { method: "DELETE" })
    .catch((e) => { DOOMED.delete(s.sessionId); SHOW_LIVE(); say(`Couldn't delete “${s.title || "Untitled"}”: ${e.message}`); });
}

function sessionActions(s, say, { rename, open, after, leave, delKey = "delete" } = {}) {
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
  if (open) items.push({ label: "Open", icon: "fwd", key: "open", run: () => go(keyOf(s)) });
  if (open && s.attachable) items.push({ label: "Open the terminal", icon: "term", key: "term", run: () => openTerm(s) });
  items.push("-", { label: "Rename…", icon: "file", run: rename || (() => ask({ title: "Rename session", input: { value: s.title, placeholder: "Session name" }, ok: "Rename", busy: "Renaming…",
    run: (name) => name !== s.title && patch({ name }) }).then(after)) });
  items.push({ label: s.pinned ? "Unpin" : "Pin to the top", icon: "pin", run: run(() => patch({ pinned: !s.pinned }), () => say(s.pinned ? "Unpinned." : "Pinned.")) });
  items.push("-", { label: s.parked ? "Unpark" : "Park", icon: "park", sub: s.parked ? "back in the list" : "out of the list until it needs you", run: run(() => patch({ parked: !s.parked }), () => say(s.parked ? "Unparked." : "Parked.", { undo: () => patch({ parked: !!s.parked }) })) });
  if (!s.attachable && s.kind !== "interactive")
    items.push({ label: "Resume", icon: "play", run: run(() => resumeSession(s), (r) => go(r.id)) });
  if (!s.private) items.push({ label: "Put on the backlog", icon: "inbox", title: "Stop it and take it off the list; its backlog item resumes the same conversation. A working session stops when its turn ends", run: () => putAside(s, say).then(() => after && after()) });
  if (s.agent && s.state !== "past") items.push({ label: "Start over", icon: "refresh", title: "It writes a handover note and a new conversation starts from it", run: run(() => agentApi(s.agent, "reset"), () => say(`${s.title} is starting over.`)) });
  items.push("-");
  if (s.attachable) items.push({ label: "Stop", icon: "stop", run: run(() => api(`/api/sessions/${s.id}/stop?device=${encodeURIComponent(DEVICE)}`, { method: "POST" }), () => say("Stopped. Resume it any time.")) });
  if (s.id && s.private)
    items.push({ label: "Erase…", icon: "x", danger: true, run: () => ask({ title: `Erase “${s.title || "Untitled"}”?`, body: "It ends, and its conversation, folder and files are deleted for good.",
      ok: "Erase", busy: "Erasing…", danger: true, run: () => api(`/api/sessions/${s.id}`, { method: "DELETE" }) })
      .then((r) => { r && isOpen(s) && location.replace("#/"); after && after(); }) });
  else if (canDelete(s)) items.push({ label: "Delete", icon: "x", danger: true, key: delKey, title: "Its conversation stays in history, where you can resume it", run: () => { deleteLater(s, say, leave); after && after(); } });
  items.push("-");
  return items;
}

function QuickMenu({ quick, say, onClose }) {
  const { s, rect } = quick;
  const sheet = usePhone() || touch || !rect;
  const items = sessionActions(s, say, { open: true });
  const box = useRef();
  const pick = (it) => { onClose(); it.run(); };
  useMenuKeys(box, true, onClose);
  useEffect(() => {
    const rows = document.querySelectorAll(`[data-sid="${CSS.escape(s.sessionId)}"]`);
    rows.forEach((el) => el.classList.add("ctx"));
    return () => rows.forEach((el) => el.classList.remove("ctx"));
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (sheet || !el) return;
    const h = el.offsetHeight, below = rect.bottom + 4, above = rect.top - 4 - h;
    el.style.top = `${Math.max(8, below + h <= innerHeight - 8 ? below : above >= 8 ? above : innerHeight - 8 - h)}px`;
    el.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 8 - el.offsetWidth))}px`;
  }, [rect]);
  if (sheet) return html`<${MenuSheet} aria=${`Actions for ${s.title || "Untitled"}`} onClose=${onClose}
    head=${html`<div class="mhead"><${StateBlock} s=${s} /><span class="tx"><b lang=${langOf(s.title)}>${s.title || "Untitled"}</b><small>${[s.host, s.branch && !["HEAD", "main", "master"].includes(s.branch) && s.branch, ago(s)].filter(Boolean).join(" · ")}</small></span></div>`}
    foot=${s.state !== "past" && s.state !== "stopped" && html`<p class="mtip">In the list, swipe right to park and left to reply.</p>`}>
    <div ref=${box}><${MenuItems} items=${items} onPick=${pick} sheet /></div><//>`;
  return html`<div class="quick"><div ref=${box} class="menu" role="menu" aria-label=${`Actions for ${s.title || "Untitled"}`} style="position: fixed; max-height: calc(100vh - 16px); overflow-y: auto">
    <${MenuItems} items=${items} onPick=${pick} /></div></div>`;
}

const SESSION_PAGE = "atc.sessionPage";
const paneFor = () => "chat";

const STATE_LETTER = { "needs-you": ["N", "needs"], "your-turn": ["T", "turn"], working: ["W", "working"] };
function StateBlock({ s, mini }) {
  const [l, c] = away(s) ? ["P", "parked"] : STATE_LETTER[s.state] || ["E", "earlier"];
  const old = staleAt(s);
  return html`<span class="sb ${c} ${mini ? "mini" : ""} ${old ? "hatch" : ""}" role="img" aria-label=${`${away(s) ? "parked" : WORD[s.state] || "earlier"}${old ? `, as of ${hhmm(old)}` : ""}`}>${l}</span>`;
}
const CtxMeter = ({ n, max = n > 200000 ? 1000000 : 200000 }) => html`<span class="meter" aria-hidden="true"><i style=${`width:${Math.min(100, Math.round((n / max) * 100))}%`}></i></span>`;

function scrollWhenThere(sel, tries = 20) {
  const el = document.querySelector(sel);
  if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  else if (tries > 0) setTimeout(() => scrollWhenThere(sel, tries - 1), 100);
}

function Session({ s, say, live, panes, togglePane, back = backHome, pageTab }) {
  const canAttach = s.attachable;
  const hasTerm = s.kind !== "hub";
  const auto = useRef(AUTO_PANE);
  const shown = usePages(s);
  const [kept] = useState(() => { const n = !auto.current && !routePage() && stored(SESSION_PAGE, {})[s.sessionId]; return n && shown.some((p) => p.name === n) ? n : null; });
  const agentPage = !pageTab && !auto.current && !routePage() && !kept && !!s.agent && shown[0]?.name;
  const [mode, setMode] = useState(() => { AUTO_PANE = null; return auto.current || (routePage() || kept || agentPage ? "page" : paneFor(s)); });
  const [pg, setPg] = useState(() => splitRef(routePage())[0] || kept || agentPage);
  const [at, setAt] = useState(() => atOf(routePage()));
  const [split, setSplitRaw] = useState(() => { const v = AUTO_SPLIT || !!agentPage || stored(PAGE_SPLIT, true); AUTO_SPLIT = false; return v; });
  const setSplit = (v) => { setSplitRaw(v); store(PAGE_SPLIT, v); };
  const wideNow = useWide();
  const sideBySide = mode === "page" && split && wideNow && shown.length > 0;
  const onPage = mode === "page" && shown.length > 0;
  const [pageZenWanted, setPageZenRaw] = useState(false);
  const pageZen = pageZenWanted && onPage;
  const setPageZen = (on) => { setPageZenRaw(on); zenHistory(on); };
  const zen = onPage ? () => (!sideBySide || document.activeElement?.closest?.(".ppane") ? setPageZen(true) : TX_API?.zen()) : null;
  useZenBack(pageZenWanted, () => setPageZenRaw(false));
  useEffect(() => { if (pageZenWanted && !onPage) setPageZen(false); }, [pageZenWanted, onPage]);
  useLayoutEffect(() => {
    document.body.classList.toggle("pagezen", pageZen);
    if (pageZen) document.querySelector(".ppane iframe:not(.next)")?.focus();
    return () => document.body.classList.remove("pagezen");
  }, [pageZen]);
  useKeyLayer((e) => {
    if (typingIn(e.target)) return false;
    if (e.key === "z" || e.key === "Escape") return setPageZen(false), true;
    return e.key.length === 1 && e.key !== " ";
  }, pageZen);
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
  const choose = (m) => { if (m === "page") return openPage(pg || shown[0]?.name); leavePage(m); };
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
    if (idle && wideNow && split && mode !== "page" && p.kind !== "browser" && !document.body.classList.contains("zen")) openPage(pageRef(p));
    else { const where = isPhone() ? "It's in the Page tab." : "It's on the page button up top."; say(p.kind === "browser" ? `It opened a browser tab. ${where}` : `Showing you “${pageTitle(p)}”. ${where}`); }
  }, [shown.map((p) => p.name + p.shown).join()]);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

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
  const outs = useOutputs(s, panes?.state || mode === "state" ? 10000 : 60000);
  const [showUse, setShowUse] = useState(false);
  useEffect(() => {
    SESSION_API = { s, canAttach, mode: choose, page: openPage, pages: shown, zen, outputs: () => showStateSection(".outs"), usage: () => setShowUse(true), rename: () => setRenaming(true) };
    return () => { SESSION_API = null; };
  });
  USAGE_PROFILE = s.profile || "";
  const use = useSessionUsage(s, showUse || s.state === "working" ? 15000 : 90000);
  const outCount = outs ? outs.servers.length + outs.files.filter((f) => f.kind !== "text").length + outs.links.length : 0;

  const renameBox = html`<input class="rn" ref=${focusOnMount} value=${s.title} aria-label="Session title" onKeyDown=${(e) => {
      if (e.key === "Enter") { patch({ name: e.target.value }); setRenaming(false); }
      if (e.key === "Escape") setRenaming(false);
    }} onBlur=${() => setRenaming(false)} />`;
  const phoneNow = usePhone();
  const openState = () => (phoneNow ? setMode("state") : togglePane("state"));
  const showStateSection = (sel) => {
    if (phoneNow) { setMode("state"); return scrollWhenThere(`.stab ${sel}`); }
    if (!panes?.state) togglePane("state");
    scrollWhenThere(`.statep ${sel}`);
  };
  const where = [MULTI && s.host, s.profile, s.branch && s.branch !== "HEAD" && s.branch].filter(Boolean).join(" · ");
  const elsewhere = phoneNow ? (live || []).filter((x) => x.sessionId !== s.sessionId && x.state === "needs-you" && !away(x) && !hiddenRun(x)).length : 0;
  const pagesFresh = phoneNow && shown.some(pageFresh);
  useEffect(() => {
    const k = (e) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector(".veil, .pghome, .palone, .keys-ov")) return;
      if (e.key === "`" && hasTerm) { e.preventDefault(); choose(mode === "term" ? "chat" : "term"); }
      else if (e.key === "\\") { e.preventDefault(); openState(); }
      else if (e.key === "]" && shown.length) { e.preventDefault(); choose(mode === "page" ? paneFor(s) : "page"); }
      else if (e.key === "x") { e.preventDefault(); document.querySelector(".hd .more button")?.click(); }
      else if (e.key === "Delete" && !e.defaultPrevented && canDelete(s) && !document.querySelector("[role=menu]")) { e.preventDefault(); deleteLater(s, say, back); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });
  const facts = [
    ["Machine", s.host],
    ["Folder", s.cwd && tilde(s.cwd)],
    ["Branch", s.branch !== "HEAD" && s.branch],
    ["Model", engineTag(s) || (s.model && model(s.model))],
    ["Context", s.context > 0 && html`<span class="ctx"><${CtxMeter} n=${s.context} />${Math.round(s.context / 1000)}k</span>`],
    ["Cost", use?.total > 0 && html`<button class="link" onClick=${() => setShowUse(true)}>${withWk(use.cost, usd)}</button>`],
    ["Started", s.startedAt && agoLong(s.startedAt)],
    ["Steps", s.steps > 0 && `${s.steps}${s.failed > 0 ? `, ${s.failed} failed` : ""}`],
    ["Permissions", s.permissionMode === "bypassPermissions" ? "no prompts" : s.permissionMode],
    ["Account", s.profile],
    [s.lastFrom ? `From ${s.lastFrom}` : "Your last", s.lastPrompt && oneLine(s.lastPrompt)],
    ["Reports to", s.reportsTo && (live?.find((x) => (x.root || x.sessionId) === s.reportsTo)?.title || "a session")],
    ["Pinned", s.pinned && "yes"],
    ["Session", s.id],
  ].filter(([, v]) => v);
  const [view, setView] = useState(null);
  useEffect(() => setView(null), [s.sessionId, mode]);
  const viewing = view && !phoneNow && mode !== "state";
  const statePane = html`
    <div class="statep-in">
      <section class="ssum"><h3>Summary</h3>
        <p class="now">${headline(s) || WORD[s.state] || s.state}</p>
        ${s.summary && html`<${SummaryParts} x=${s.summary} />`}
        ${replyable(s) && html`<${Replies} list=${s.summary.replies} pick=${(text) => api(`/api/sessions/${s.id}/send`, { method: "POST", body: { text, suggested: true } }).catch((e) => say(e.message))} />`}
        ${s.summary && html`<button class="btn quiet sagain" onClick=${() => api(`/api/sessions/${s.sessionId}/summary`, { method: "POST" }).then(() => say("Summarizing again…"), (e) => say(e.message))}>${ICON.refresh}Summarize again</button>`}
      </section>
      <${Outputs} s=${s} data=${outs} pages=${shown} open=${openPage} sel=${view} view=${setView} />
      <${SessionResources} s=${s} />
      <section class="facts"><h3>Facts</h3><dl class="kv">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></section>
    </div>`;
  const tabs = [["chat", "Chat"], hasTerm && ["term", "Terminal"], shown.length > 0 && ["page", "Page"], ["state", "State"]].filter(Boolean);
  const chatMenu = mode === "chat" || sideBySide;

  return html`
    <header class="hd">
      <div class="l1">
        <button class="kb back" onClick=${back} aria-label="Back">${ICON.back}<span class="bk">Back</span>${elsewhere > 0 && html`<i class="bdot" title=${`${elsewhere} more waiting on you`}></i>`}</button>
        <${StateBlock} s=${s} />
        ${renaming ? renameBox : html`<h1 onDblClick=${() => setRenaming(true)} title=${s.title} lang=${langOf(s.title)}>${s.title || "Untitled"}</h1>`}
        ${where && html`<span class="where">${where}</span>`}
        <span class="r">
          ${(use?.total > 0 || s.context > 0) && html`<button class="usechip sescost" onClick=${() => setShowUse(true)}
            title=${[s.model && `Model ${s.model}`, s.context > 0 && `${Math.round(s.context / 1000)}k context in use`, use?.total > 0 && `${withWk(use.cost, usd)} at API prices`].filter(Boolean).join(", ") + ". Click for the breakdown"}>
            ${!phoneNow && s.model && html`<span class="pc">${modelName(s.model)}</span>`}
            ${!phoneNow && s.context > 0 && html`<span class="pc"><${CtxMeter} n=${s.context} />${Math.round(s.context / 1000)}k</span>`}
            ${use?.total > 0 && html`<span class="v">${usd(use.cost)}</span>`}${use?.total > 0 && wk(use.cost) && html`<span class="pc">${wk(use.cost).replace(/ wk$/, "")}</span>`}</button>`}
          ${!phoneNow && s.load && html`<button class="usechip ${hotLoad(s.load) ? "hotload" : ""}" title="This session's processes, in State" onClick=${() => showStateSection(".sres")}><span class="pc">${shortLoad(s.load)}</span></button>`}
          ${!phoneNow && shown.length > 0 && html`<${PagesButton} list=${shown} open=${openPage} on=${mode === "page"} />`}
          ${!phoneNow && hasTerm && html`<button class="btn quiet ${mode === "term" ? "on" : ""}" aria-pressed=${mode === "term"} aria-keyshortcuts="\`" title=${tip("term", "Terminal")} onClick=${() => choose(mode === "term" ? "chat" : "term")}>${ICON.term}Terminal</button>`}
          ${!phoneNow && panes && back === backHome && !panes.rail && html`<${PaneToggle} id="rail" run=${() => togglePane("rail")} icon="rail" label="The bay's sessions beside the transcript" />`}
          ${!phoneNow && panes && html`<${PaneToggle} id="state" on=${panes.state} run=${openState} icon="side" label="State: summary, outputs and facts" />`}
          <div class="more"><${Menu} cls="btn quiet icon" busy=${busy} aria="Session menu" title=${tip("menu", "More")} width=${260}
            items=${[
              ...(onPage && !sideBySide ? [{ label: "Zen", icon: "zen", key: "zen", run: () => setPageZen(true) }] : []),
              ...(chatMenu ? [{ label: "Zen", icon: "zen", key: "zen", run: () => TX_API?.zen() }, { label: "Find in the transcript", icon: "search", key: "find", run: () => TX_API?.find() }, { label: "Contents", icon: "list", key: "contents", run: () => TX_API?.contents() }, { label: "Outline, story or everything", icon: "doc", key: "level", run: () => TX_API?.level() }] : []),
              "-", { icon: "phone", ...callSession(s, say) }, { label: "Files, commits and deploys", icon: "folder", run: () => showStateSection(".outs") },
              { label: "Usage", icon: "chart", run: () => setShowUse(true) }, ...(s.agent ? [{ label: "Agent details", icon: "people", run: () => openAgent(s.agent, "details") }] : []),
              ...sessionActions(s, say, { rename: () => setRenaming(true), after: () => setBusy(false), leave: back, delKey: "session.delete" })]} /></div>
        </span>
      </div>
      ${phoneNow && html`<nav class="stabs" aria-label="View">
        ${tabs.map(([m, label]) => {
          const on = mode === m;
          return html`<button class=${on ? "on" : ""} aria-current=${on ? "page" : null} onClick=${() => (m === "state" ? setMode("state") : choose(m))}>${label}${m === "page" && !on && pagesFresh && html`<i class="dot" aria-label="new"></i>`}</button>`;
        })}
      </nav>`}
    </header>
    <div class="sbody ${panes?.state && !phoneNow ? "withstate" : ""}">
    <div class="smain">
    ${mode !== "chat" && !sideBySide && !pageZen && s.asks?.length > 0 && html`<div class="askstrip"><${Ask} compact s=${s} a=${s.asks[0]} say=${say} /></div>`}
    ${mode !== "chat" && mode !== "state" && mode !== "term" && !sideBySide && !pageZen && html`<${SummaryBar} s=${s} say=${say} onFull=${() => setMode("chat")} />`}
    ${viewing && html`<${OutView} s=${s} v=${view} set=${setView} say=${say} inline />`}
    ${mode === "state" ? html`<div class="stab">${statePane}</div>`
    : mode === "page" && shown.length > 0
      ? (() => {
          const pane = html`<${PagePane} s=${s} list=${shown} cur=${pg} at=${at} pick=${openPage} split=${sideBySide} setSplit=${wideNow ? setSplit : null} say=${say} onZen=${() => setPageZen(true)}
            onClose=${() => leavePage(paneFor(s))} />`;
          return sideBySide
            ? html`<${PageSplit}><${Transcript} s=${s} say=${say} resume=${() => resume("chat")} busy=${busy} />${pane}<//>`
            : pane;
        })()
    : mode === "term" && hasTerm
      ? canAttach
        ? html`<${Term} key=${s.id} s=${s} say=${say} />`
        : html`<div class="stage"><div class="cover">${Unattachable(s, () => resume(), busy, setMode)}</div></div>`
      : html`<${Transcript} s=${s} say=${say} resume=${() => resume("chat")} busy=${busy} />`}
    </div>
    ${panes?.state && !phoneNow && html`<aside class="statep" aria-label="State"><div class="phd"><b>State</b><span class="sub">${s.summary?.at ? `updated ${agoLong(s.summary.at)}` : clipWords(s.title, 40)}</span><button class="btn quiet icon" aria-label="Close the State pane" title=${tip("state", "Close")} onClick=${() => togglePane("state")}>${ICON.x}</button></div>${statePane}</aside>`}
    </div>
    ${phoneNow && view && html`<${OutView} s=${s} v=${view} set=${setView} say=${say} />`}
    ${pageZen && html`<button class="kb pzenout" onClick=${() => setPageZen(false)} title="Leave zen (z)">Leave zen</button>`}
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
const PHONE = matchMedia(BP.phone);

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
        <button class="icon sumx" onClick=${hide} title="Hide until the next reply" aria-label="Hide the summary">${ICON.x}</button>
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
  return html`<div><p class="h">${s.state === "stopped" ? "Stopped" : "Not running"}</p>${s.state === "stopped" && s.ended?.text && s.ended.cause !== "unknown" && html`<p>${s.ended.text}</p>`}<p>Resume it to pick up where it left off. The whole conversation comes back.</p><div class="row"><button class="btn primary" disabled=${busy} onClick=${resume}>${busy ? "Resuming…" : "Resume"}</button></div></div>`;
}

const menuList = (items) => {
  const list = items.filter(Boolean), out = [];
  const bad = list.filter((it) => it !== "-" && it.danger);
  for (const it of [...list.filter((it) => !bad.includes(it)), ...(bad.length ? ["-", ...bad] : [])])
    if (it !== "-" || (out.length && out.at(-1) !== "-")) out.push(it);
  while (out.at(-1) === "-") out.pop();
  return out;
};

function MenuItems({ items, busy, onPick, sheet }) {
  return menuList(items).map((it) => it === "-" ? html`<hr class="msep" />` : html`
    <button class="mitem ${it.danger ? "danger" : ""} ${it.on ? "on" : ""} ${it.cls || ""}" role="menuitem" title=${it.title} disabled=${busy} onClick=${() => onPick(it)}>
      <span class="ic" aria-hidden="true">${it.icon && ICON[it.icon]}</span><span class="lb">${it.label}</span>${!sheet && it.sub && html`<span class="sub">${it.sub}</span>`}${!sheet && it.key && keyFor(it.key) && html`<kbd aria-hidden="true">${keyFor(it.key)}</kbd>`}
    </button>`);
}

function useMenuKeys(box, open, close) {
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement;
    const all = () => [...(box.current?.querySelectorAll(".mitem:not(:disabled)") || [])];
    if (!touch) all()[0]?.focus({ preventScroll: true });
    const k = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); back?.focus?.({ preventScroll: true }); return; }
      if (e.key === "Tab") return close();
      const d = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 }[e.key], l = all();
      if (!d || !l.length) return;
      e.preventDefault(); e.stopPropagation();
      l[(l.indexOf(document.activeElement) + d + l.length) % l.length].focus();
    };
    const out = (e) => !box.current?.parentElement?.contains(e.target) && close();
    addEventListener("keydown", k, true);
    addEventListener("pointerdown", out);
    return () => { removeEventListener("keydown", k, true); removeEventListener("pointerdown", out); };
  }, [open]);
}

function MenuSheet({ aria, head, foot, onClose, children }) {
  return html`<div class="veil mveil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="msheet" role="menu" aria-label=${aria}><i class="grab" aria-hidden="true"></i>${head}${children}${foot}</div></div>`;
}

function Menu({ busy, items, label = ICON.more, cls = "icon", aria = "More actions", width = 200, left, up, title }) {
  const [open, setOpen] = useState(false);
  const box = useRef();
  const bottom = usePhone();
  const close = () => setOpen(false);
  const pick = (it) => { close(); it.run(); };
  useMenuKeys(box, open, close);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || bottom) return;
    const r = el.getBoundingClientRect(), shift = r.left < 8 ? 8 - r.left : r.right > innerWidth - 8 ? innerWidth - 8 - r.right : 0;
    if (shift) el.style.transform = `translateX(${shift}px)`;
  }, [open]);
  return html`
    <div class="mwrap">
      <button class=${cls} aria-label=${aria} title=${title} aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen(!open)}>${label}</button>
      ${open && bottom && html`<${MenuSheet} aria=${aria} onClose=${close}><div ref=${box}><${MenuItems} items=${items} busy=${busy} onPick=${pick} sheet /></div><//>`}
      ${open && !bottom && html`
        <div ref=${box} class="menu" role="menu" aria-label=${aria} style="${left ? "left" : "right"}: 0; ${up ? "bottom" : "top"}: calc(100% + 6px); ${typeof width === "number" ? `min-width: min(${width}px, calc(100vw - 16px))` : `width: ${width}`}">
          <${MenuItems} items=${items} busy=${busy} onPick=${pick} />
        </div>`}
    </div>
  `;
}

const TERM_COLORS = ["background", "foreground", "cursor", "cursorAccent", "selectionBackground",
  ...["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((c) => [c, `bright${c[0].toUpperCase()}${c.slice(1)}`])];
const TERM_THEMES = {};
const atcScheme = () => document.documentElement.dataset.scheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const termTheme = () => {
  const key = `${atcScheme()} ${LOOK.theme}`;
  if (!TERM_THEMES[key]) {
    const v = cssColors(atcScheme(), TERM_COLORS.map((c) => `ansi-${c}`));
    TERM_THEMES[key] = Object.fromEntries(TERM_COLORS.map((c, i) => [c, v[i]]));
  }
  return TERM_THEMES[key];
};
const termContrast = () => (CLAUDE_THEME === atcScheme() ? 1 : 4.5);

const KEYS = [
  ["esc", "\x1b"], ["tab", "\t"], ["shift tab", "\x1b[Z"], ["ctrl", null],
  ["left", "\x1b[D", "prev"], ["up", "\x1b[A", "up"], ["down", "\x1b[B", "down"], ["right", "\x1b[C", "next"], ["ctrl c", "\x03"], ["/", "/"],
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

let lastInput = Date.now(), lastBeat = 0, touchedAt = 0;
const beat = () => {
  if (document.visibilityState !== "visible" || !document.hasFocus() || Date.now() - lastInput > 120000 || Date.now() - lastBeat < 20000) return;
  lastBeat = Date.now();
  fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: DEVICE }) }).catch(() => {});
};
const acted = (e) => { if (e.isTrusted === false) return; lastInput = touchedAt = Date.now(); beat(); };
for (const ev of ["keydown", "pointerdown", "wheel", "touchstart"]) addEventListener(ev, acted, { passive: true, capture: true });
let mouseAt = "";
addEventListener("mousemove", (e) => {
  if (!e.isTrusted) return;
  const at = `${e.screenX},${e.screenY}`;
  if (at !== mouseAt) lastInput = touchedAt = Date.now();
  mouseAt = at;
}, { passive: true, capture: true });
addEventListener("message", (e) => { if (e.data?.atc === 1 && e.data.op === "active") acted({}); });
addEventListener("focus", beat);
setInterval(beat, 30000);

let TIME_ON = null;
const ATTENTION = attention();
const SCREEN_NAMES = { ...SCREENS, board: "Board and session list", pages: "Pages", assistant: "Assistant", shell: "Shell", settings: "Settings" };
const openNow = ({ sel, screen }) => sel?.sessionId ? { sessionId: sel.sessionId, title: sel.title || "", cwd: sel.cwd || "", host: sel.host || "", profile: sel.profile || "" }
  : SCREEN_NAMES[screen] ? { sessionId: `screen:${screen}`, title: SCREEN_NAMES[screen], cwd: "", host: "" } : null;
const tickTime = () => ATTENTION.tick(Date.now(), { on: TIME_ON, here: document.visibilityState === "visible" && document.hasFocus(), input: touchedAt });
const sendTicks = async () => {
  const sessions = ATTENTION.take(Date.now());
  if (!sessions.length) return;
  const ok = await fetch("/api/time", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: DEVICE, rule: RULE, sessions }), keepalive: true }).then((r) => r.ok, () => false);
  if (!ok) ATTENTION.back(sessions);
};
setInterval(tickTime, 5000);
setInterval(sendTicks, 30000);
addEventListener("visibilitychange", () => document.visibilityState === "hidden" && sendTicks());
addEventListener("pagehide", sendTicks);

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

const dock = (s) => dockAt(s.id, `/api/sessions/${s.id}/attach?`);

function dockAt(id, path, alive) {
  let d = DOCK.get(id);
  if (!d) {
    d = makeDock(id, path, alive);
    DOCK.set(id, d);
  }
  d.used = Date.now();
  const spare = [...DOCK.values()].filter((x) => !x.box && x !== d).sort((p, q) => p.used - q.used);
  while (DOCK.size > DOCK_KEEP && spare.length) spare.shift().dispose();
  return d;
}

function makeDock(id, path, alive) {
  const el = document.createElement("div");
  el.className = "termhost";
  shelf().append(el);
  const term = new Terminal({
    fontFamily: '"Recursive Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono", "Noto Sans Symbols 2", "Noto Sans Symbols", monospace',
    fontSize: touch ? 12.5 : 14,
    lineHeight: 1.1,
    theme: termTheme(),
    minimumContrastRatio: termContrast(),
    allowProposedApi: true,
    scrollback: 2000,
    macOptionIsMeta: true,
    cursorStyle: "bar",
    linkHandler: { activate: (_, uri) => openOut(uri) },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_, uri) => openOut(uri)));
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new ClipboardAddon.ClipboardAddon(undefined, { readText: (sel) => sel === "c" ? navigator.clipboard.readText() : "", writeText: (sel, text) => (sel === "" || sel.includes("c")) && copyText(text) }));
  term.open(el);
  fit.fit();

  const enc = new TextEncoder();
  const d = { id, el, term, box: null, used: Date.now(), state: { cover: null, foreign: null, retrying: false, size: null }, ui: null, hooks: {} };
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
    ws = new WebSocket(`${proto}//${location.host}${path}${q}`);
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
          emit({ foreign: null, size: `${term.cols}×${term.rows}` });
        } else {
          term.resize(c.cols, c.rows);
          if (d.box) requestAnimationFrame(() => scale(true));
          emit({ foreign: d.box ? c.holder || "another screen" : null, size: `${c.cols}×${c.rows}` });
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
      if (tries >= 20) return emit({ cover: "lost", lostAt: heard || Date.now() });
      emit({ retrying: true });
      const retry = () => { if (!dead) timer = setTimeout(connect, Math.min(1000 * 2 ** tries++, 8000)); };
      if (!alive) return retry();
      alive().then((yes) => { if (yes !== false) return retry(); exited = true; emit({ cover: "detached", retrying: false }); }, retry);
    };
    ws.onerror = () => {};
  };
  connect();

  term.onData((data) => d.send(d.hooks.data ? d.hooks.data(data) : data));
  term.onResize(({ cols, rows }) => owner && emit({ size: `${cols}×${rows}` }));
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

function Term({ s, say, sh }) {
  const keyboard = useKeyboard();
  const key_ = sh ? shellKey(sh) : s.id;
  const box = useRef();
  const api_ = useRef({});
  const picker = useRef();
  const [dropping, setDropping] = useState(false);
  const upload = useRef();
  upload.current = async (files) => {
    for (const f of files) {
      try {
        const path = await uploadFile(sh ? `/api/uploads${hostQ(sh.host, HERE)}` : `/api/sessions/${s.sessionId}/upload`, f);
        if (!api_.current.send?.(` \x1b[200~${quotePath(path)}\x1b[201~`)) say(`Uploaded, but the terminal is not connected, so it did not get the path: ${path}`);
      } catch (e) {
        say(`Upload failed: ${e.message}`);
      }
    }
    api_.current.focus?.();
  };
  const [gen, setGen] = useState(0);
  const [st, setSt] = useState({ cover: null, foreign: null, retrying: false, size: null });
  const { cover, foreign, retrying, lostAt, size } = st;
  const downAt = !sh && STALE.hosts[s.host];
  const reopen = () => { DOCK.get(key_)?.dispose(); setGen(gen + 1); };
  useEffect(() => {
    if (sh && cover === "detached") SHELLS.load().then(() => {
      if ((SHELLS.list || []).some((x) => x.id === sh.id) || location.hash !== shellHash(sh)) return;
      DOCK.get(key_)?.dispose();
      location.replace(SHELL_FROM || "#/");
    });
  }, [cover]);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  useEffect(() => {
    const d = sh ? shellDock(sh) : dock(s);
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
  }, [key_, gen]);

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
    <div class="stage ${dropping ? "dropping" : ""}" ...${drop}>
      <input type="file" multiple hidden ref=${picker} onChange=${(e) => { upload.current([...e.target.files]); e.target.value = ""; }} />
      <div class="tsize" role="status">
        ${retrying && !cover ? html`<span class="who">Reconnecting…</span>` : size && html`<span class="mono">${size}</span><span class="who">${foreign || "this screen"}</span>`}
        <span class="sp"></span>
        ${foreign && !cover && !retrying && html`<button class="btn sm" onClick=${() => api_.current.claim?.()} title="Size the terminal for this screen">Take size</button>`}
        <button class="btn quiet sm tatt" title="Attach a file (or paste or drop one)" aria-label="Attach a file" onClick=${() => picker.current.click()}>${ICON.attach}<span>Attach</span></button>
      </div>
      <div class="term" ref=${box}></div>
      ${downAt ? html`<${StaleLine} retry=${reopen}>The screen as it was at <span class="tm">${hhmm(downAt)}</span>. Typing is off until ${s.host} answers.<//>`
        : cover === "lost" ? html`<${StaleLine} retry=${reopen}>Connection lost at <span class="tm">${hhmm(lostAt)}</span>. The ${sh ? "shell" : "session"} keeps running.<//>`
        : null}
      ${cover === "detached" && !downAt && html`
        <div class="cover">
          <div>
            <p class="h">${sh ? "The shell ended" : "Detached"}</p>
            <p>${sh ? "It exited, or someone closed it." : "The terminal closed. The session keeps running."}</p>
            <div class="row">
              ${sh
                ? html`<button class="btn primary" onClick=${() => startShell(sh.host, sh.dir || "~").catch((e) => say(e.message))}>New shell here</button>`
                : html`<button class="btn primary" onClick=${reopen}>Reopen</button>`}
              <button class="btn" onClick=${() => go(null)}>Back to list</button>
            </div>
          </div>
        </div>`}
      <div class="keys ${keyboard ? "show" : ""}" onPointerDown=${(e) => e.preventDefault()}>
        ${KEYS.map(([label, seq, icon]) => html`<button class=${`${label === "ctrl" && ctrl ? "on" : ""} ${icon ? "ar" : ""}`} aria-label=${icon ? label : null} aria-pressed=${label === "ctrl" ? ctrl : null} onClick=${() => key(label, seq)}>${icon ? ICON[icon] : label}</button>`)}
        <button class="ar" aria-label="Attach a file" onClick=${() => picker.current.click()}>${ICON.attach}</button>
      </div>
    </div>
  `;
}

const SHELLS = {
  list: null, subs: new Set(), at: 0,
  set(l) { SHELLS.list = (l || []).sort((a, b) => Date.parse(a.started) - Date.parse(b.started)); SHELLS.subs.forEach((f) => f(SHELLS.list)); },
  load() { SHELLS.at = Date.now(); return api("/api/shells").then((l) => SHELLS.set(l), () => {}); },
};
let NEW_SHELL = () => {};
let SHELL_FROM = null;
const shellKey = (sh) => `sh-${sh.id}`;
const shellHash = (sh) => `#/sh/${encodeURIComponent(sh.host || HERE)}/${sh.id}`;
const shellRoute = () => {
  const m = location.hash.match(/^#\/sh\/([^/]+)\/([0-9a-f]{8})$/);
  return m && { host: decodeURIComponent(m[1]), id: m[2] };
};
const shellOn = (host) => (host && host !== HERE ? `host=${encodeURIComponent(host)}&` : "");
const shellDock = (sh) => dockAt(shellKey(sh), `/api/shells/${sh.id}/attach?${shellOn(sh.host)}`,
  () => api(`/api/shells?${shellOn(sh.host)}local=1`).then((l) => (l || []).some((x) => x.id === sh.id)));

function useShells() {
  const [list, set] = useState(SHELLS.list);
  useEffect(() => {
    SHELLS.subs.add(set);
    if (Date.now() - SHELLS.at > 5000) SHELLS.load();
    return () => SHELLS.subs.delete(set);
  }, []);
  return list;
}

async function startShell(host, dir, run) {
  const sh = await api(`/api/shells${hostQ(host, HERE)}`, { method: "POST", body: { dir, run } });
  SHELLS.set([...(SHELLS.list || []).filter((x) => x.id !== sh.id), sh]);
  if (!shellRoute()) SHELL_FROM = location.hash;
  location.hash = shellHash(sh);
  return sh;
}

const shellIdle = (sh) => !sh.run && /^-?(zsh|bash|fish|sh|dash|ksh|tcsh)$/.test(sh.cmd || "");
const killShell = (sh) => api(`/api/shells/${sh.id}${hostQ(sh.host, HERE)}`, { method: "DELETE" });
const closeShell = (sh, say) => (shellIdle(sh) ? killShell(sh).then(() => true, (e) => say(e.message))
  : ask({ title: "Close this shell?", body: `Whatever runs in it on ${sh.host || HERE} stops.`, ok: "Close", busy: "Closing…", danger: true, run: () => killShell(sh) }))
  .then((r) => {
    if (!r) return;
    DOCK.get(shellKey(sh))?.dispose();
    SHELLS.set((SHELLS.list || []).filter((x) => x.id !== sh.id));
    if (location.hash === shellHash(sh)) location.replace(SHELL_FROM || "#/");
    say("Shell closed.");
  });

const shellWhere = (sh) => [MULTI && sh.host, sh.run ? "" : sh.cmd].filter(Boolean).join(" · ");
const shellName = (sh) => sh.run || (sh.dir ? tilde(sh.dir) : "Shell");

function ShellGroup({ cur }) {
  const list = useShells();
  if (!list?.length) return null;
  return html`<section class="shgrp">
    <h2 class="grp"><b>Shells</b><span class="c">${list.length}</span><span class="r"><button class="kb" onClick=${() => NEW_SHELL()}>New shell</button></span></h2>
    ${list.map((x) => html`<button class="shrow ${cur?.id === x.id ? "on" : ""}" aria-current=${cur?.id === x.id ? "page" : null} onClick=${() => (location.hash = shellHash(x))}>
      <span class="ic" aria-hidden="true">$</span><span class="t">${shellName(x)}</span><span class="m">${shellWhere(x)}</span><span class="ago" title=${stamp(x.started)}>${age(x.started)}</span>
    </button>`)}
  </section>`;
}

function ShellView({ at, say }) {
  const list = useShells();
  const sh = { dir: "", ...(list || []).find((x) => x.id === at.id && (x.host || HERE) === at.host), id: at.id, host: at.host };
  return html`
    <header class="hd">
      <div class="l1">
        <button class="kb back" onClick=${() => go(null)} aria-label="Back">${ICON.back}<span class="bk">Back</span></button>
        <span class="shmark" aria-hidden="true">$</span>
        <h1 title=${sh.run || sh.dir}>${shellName(sh)}</h1>
        <span class="where">${MULTI ? `shell on ${sh.host}` : "shell"}${sh.run ? ` in ${tilde(sh.dir)}` : sh.cmd ? `, running ${sh.cmd}` : ""}</span>
        <span class="r">
          <button class="kb" onClick=${() => NEW_SHELL({ host: sh.host, dir: sh.dir })}>New shell</button>
          <button class="kb" onClick=${() => closeShell(sh, say)}>Close</button>
          <div class="more shmore"><${Menu} cls="kb" aria="Shell menu" label="More"
            items=${[{ label: "New shell", run: () => NEW_SHELL({ host: sh.host, dir: sh.dir }) }, { label: "Close this shell", danger: true, run: () => closeShell(sh, say) }]} /></div>
        </span>
      </div>
    </header>
    <div class="sbody"><div class="smain"><${Term} key=${shellKey(sh)} sh=${sh} say=${say} /></div></div>`;
}

function NewShell({ start, hosts, down = [], home, live, onClose }) {
  const [host, setHost] = useState(() => (start?.host && hosts.includes(start.host) ? start.host : home));
  const [dir, setDir] = useState(() => (start?.dir ? tilde(start.dir) : "~"));
  const [run, setRun] = useState("");
  const dirs = useDirs(host, home);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const f = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    if (!touch) requestAnimationFrame(() => document.getElementById("ns-folder")?.focus());
    return () => removeEventListener("keydown", f);
  }, []);
  const open = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await startShell(host, dir.trim() || "~", run.trim());
      onClose();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return html`
    <div class="nsveil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <form class="nsdlg" role="dialog" aria-modal="true" aria-label="New shell" onSubmit=${(e) => { e.preventDefault(); open(); }}>
        <div class="dh"><b>New shell</b><span class="r"><button type="button" class="kb" onClick=${onClose} aria-keyshortcuts="Escape" title="Close (esc)">Close</button></span></div>
        <div class="db">
          <p class="nshint">A login shell with no Claude in it. It keeps running when you close the tab; close it from its header or with <code>exit</code>. With a command, it runs only that and closes on a key when done; <code>$ command</code> in the palette does the same.</p>
          <${FolderField} dirs=${dirs} folder=${dir} pick=${setDir} host=${host} live=${live} home=${home} onStart=${open} />
          <div class="nsfld"><label class="nslb" for="ns-run">Command <span>optional</span></label>
            <input id="ns-run" class="nsin mono" value=${run} onInput=${(e) => setRun(e.target.value)} placeholder="Leave empty for a shell" autocomplete="off" spellcheck="false" /></div>
          ${hosts.length > 1 && html`<div class="nsrow2"><div class="nsfld"><div class="nslb" id="ns-hl">Host</div>
            <${HostPick} hosts=${hosts} down=${down} host=${host} setHost=${(h) => { setHost(h); setDir("~"); setErr(null); }} /></div></div>`}
          ${err && html`<div class="nserr" role="alert" ref=${intoView}><b>Couldn't open a shell on ${host}.</b> ${err}</div>`}
        </div>
        <div class="df">
          <span class="sum">${run.trim() && html`<b>${run.trim()}</b> in `}<b>${dir}</b> on ${host}</span>
          <button type="button" class="btn nsx" onClick=${onClose}>Cancel</button>
          <button class="btn primary go" disabled=${busy}>${busy ? `Opening on ${host}…` : "Open"}</button>
        </div>
      </form>
    </div>`;
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
          ${remove && html`<button type="button" class="icon" aria-label=${`Remove ${f.name}`} onClick=${() => remove(i)}>${ICON.x}</button>`}
        </div>`)}
    </div>`;
}

const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);
const uploadFile = async (url, file, name = file.name || "pasted.png") => {
  const fd = new FormData();
  fd.append("file", file, name);
  const res = await fetch(url, { method: "POST", body: fd });
  if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
  return (await res.json()).path;
};

const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const tokens = (n) => {
  n = n || 0;
  for (const [d, u] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) if (n >= d) return `${(n / d).toFixed(n >= d * 10 ? 0 : 1)}${u}`;
  return String(n);
};
const dollars = (c) => (c > 0 && c < 0.01 ? "<$0.01" : c >= 100 ? `$${Math.round(c).toLocaleString("en-US")}` : `$${(c || 0).toFixed(2)}`);
const resetText = (at) => {
  const t = Date.parse(at);
  if (!t) return "";
  const d = (t - Date.now()) / 1000;
  return d <= 0 ? "Resetting now" : `Resets in ${duration(d)}, ${whenAt(t)}`;
};
const level = (p) => (p >= 90 ? "high" : p >= 75 ? "warn" : "");
const Meter = ({ p }) => html`<span class="meter ${level(p)}"><i style=${`width: ${Math.min(100, Math.max(0, p))}%`}></i></span>`;
const SHORT = { session: "Session", weekly_all: "Week" };
const modelName = (m) => {
  const n = m.replace(/^claude-/, "").replace(/-(\d+)-(\d{1,2})(-\d{8})?$/, " $1.$2").replace(/-(\d+)(-\d{8})?$/, " $1");
  return n[0].toUpperCase() + n.slice(1);
};

// Every Claude account has its own limits, so its own windows; USAGE_PROFILE is the one the screen being drawn is about.
const WINS = {}, winsAt = {}, winsLoading = {};
let USAGE_PROFILE = "";
const profQ = (p, sep = "?") => (p ? `${sep}profile=${encodeURIComponent(p)}` : "");
function loadWindows(fresh, profile = "") {
  if (!fresh && Date.now() - (winsAt[profile] || 0) < 120000) return Promise.resolve(WINS[profile] ?? null);
  return (winsLoading[profile] ||= api(`/api/usage/windows${profQ(profile)}`).then((w) => { WINS[profile] = w; winsAt[profile] = Date.now(); return w; }, () => WINS[profile] ?? null).finally(() => delete winsLoading[profile]));
}
let PROFILES = null;
const loadProfiles = () => (PROFILES ||= api("/api/profiles").then((p) => p?.profiles || [], () => { PROFILES = null; return []; }));
const winOf = (u, key) => u?.windows?.find((w) => w.key === key);
const perPct = (w) => (w?.cost > 0 && w.percent >= 1 ? w.cost / w.percent : null);
const pct = (x) => (x < 0.1 ? "<0.1%" : x < 10 ? `${x.toFixed(1)}%` : `${Math.round(x)}%`);
const usd = (c) => (c > 0 && c < 0.01 ? "<$0.01" : `~${dollars(c)}`);
const weekRate = () => perPct(winOf(WINS[USAGE_PROFILE], "weekly_all"));
const wk = (c) => (c > 0 && weekRate() ? `${pct(c / weekRate())} wk` : "");
const withWk = (c, money = dollars) => (wk(c) ? `${money(c)} (${wk(c)})` : money(c));

const useSessionUsage = (s, every) => useUsage(`/api/sessions/${s.sessionId}/usage`, every, s.profile);

function useUsage(path, every, profile = "") {
  const [data, setData] = useState(null);
  useEffect(() => setData(null), [path]);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () => loadWindows(false, profile).then((u) => {
      const q = [["week", winOf(u, "weekly_all")], ["fiveHour", winOf(u, "session")]].filter(([, w]) => w).map(([k, w]) => `${k}=${Math.floor(Date.parse(w.from) / 1000)}`);
      if (q.length && profile) q.push(`profile=${encodeURIComponent(profile)}`);
      return api(`${path}${q.length ? `?${q.join("&")}` : ""}`);
    }).then((d) => live && setData({ ...d, wins: WINS[profile] }), () => live && setData((d) => d || { failed: true }));
    load();
    const t = setInterval(load, every);
    return () => { live = false; clearInterval(t); };
  }, [path, every, profile]);
  return data;
}

const shares = (use) => {
  if (!use || use.failed || (use.local?.length && !use.cost)) return [];
  return [["week", "weekly_all", use.weekCost], ["5-hour window", "session", use.fiveHourCost]]
    .map(([name, key, cost]) => ({ name, cost, w: winOf(use.wins, key) }))
    .filter((x) => x.cost != null && x.w);
};

function Dialogs() {
  const [queue, setQueue] = useState([]);
  useEffect(() => {
    ASK = (d) => setQueue((q) => [...q, d]);
    return () => { ASK = null; };
  }, []);
  const d = queue[0];
  return d ? html`<${Dialog} key=${d.id} d=${d} onGone=${() => setQueue((q) => q.slice(1))} />` : null;
}

const leaveDialog = (id, finish) => {
  let t;
  const left = () => { removeEventListener("popstate", left); clearTimeout(t); finish(); };
  if (history.state?.atcDialog === id) {
    addEventListener("popstate", left);
    t = setTimeout(left, 400);
    history.back();
  } else left();
};

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
    leaveDialog(id, () => { onGone(); done(r); });
  };
  const cancel = () => !busyNow.current && end(null);
  useLayoutEffect(() => {
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
    first.current?.focus({ preventScroll: true });
    input && first.current?.select();
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
          <button class="btn ${danger ? "danger primary" : "primary"}" ref=${input ? undefined : first} disabled=${busy || (input && !val.trim())}>
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
          <button class="icon" onClick=${onClose} aria-label="Close">${ICON.x}</button>
        </header>
        ${children}
      </div>
    </div>`;
}

const ESTIMATE = (asOf) => `Dollar figures are estimated from the transcripts at Claude API list prices${asOf ? ` (${asOf})` : ""}. A Claude subscription is not billed per token; this is what the same work would cost on the API.`;
const WK_SCALE = () => (weekRate() ? `100% wk is one week of your plan's limit, about ${dollars(weekRate() * 100)} at this week's rate.` : "");
const WK_NOTE = () => (weekRate() ? `${WK_SCALE()} Every amount uses that one rate, whichever weeks it was spent in. The rate is what this week has spent so far divided by its percentage; Anthropic reports whole percents, so it is rough while the week is in single digits.` : "");

const ShareRows = ({ rows, onPick }) => {
  const top = Math.max(...rows.map((r) => r.cost));
  return html`
  <div class="shares">
    ${rows.map((r) => html`
      <button class="srow ${onPick ? "" : "flat"}" disabled=${!onPick} onClick=${() => onPick?.(r)} title=${r.hint || r.label}>
        <span class="sl">${r.label}${r.sub && html`<small>${r.sub}</small>`}</span>
        <span class="sv">${usd(r.cost)}${wk(r.cost) && html`<small>${wk(r.cost)}</small>`}</span>
        <i style=${`width: ${top > 0 ? Math.max(1, (r.cost / top) * 100) : 0}%`}></i>
      </button>`)}
  </div>`;
};

const dayAt = (d) => new Date(d + "T12:00");

const RANGES = [["24h", "24h", "the last 24 hours", "hours=24"], ["week", "Week", "this week, since the weekly limit reset", null, "same length of time before the reset"], ["7d", "7d", "the last 7 days", "days=7"], ["30d", "30d", "the last 30 days", "days=30"], ["90d", "90d", "the last 90 days", "days=90"], ["all", "All", "all time", "days=all"]];
const REPORTS = {};

function useReport(q) {
  const [rep, setRep] = useState(REPORTS[q] || null);
  useEffect(() => {
    if (!q) return setRep(null);
    let live = true;
    const load = () => api(`/api/usage/report?${q}`).then((r) => { REPORTS[q] = r; live && setRep(r); }, () => live && setRep((x) => (x && !x.failed ? x : { days: [], sessions: [], failed: true })));
    setRep(REPORTS[q] ? { ...REPORTS[q], loading: true } : null);
    load();
    const t = setInterval(load, 120000);
    return () => { live = false; clearInterval(t); };
  }, [q]);
  return rep;
}


function limitRow(w, x) {
  const from = Date.parse(x?.from), end = Date.parse(w.resetsAt), now = Date.now();
  const gone = from && end > from ? Math.min(1, Math.max(0, (now - from) / (end - from))) : null;
  const name = w.key === "session" ? "This 5-hour window" : w.label;
  const reset = w.key === "session" && from ? `${hhmm(from)} to ${hhmm(end)}` : `resets ${stamp(end)}`;
  const r = { w, name, reset, spent: x?.cost, used: Math.min(100, w.percent), pace: gone != null ? gone * 100 : null };
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
    : r.hit ? html`Runs out <b>about ${whenAt(at100)}</b>, ${duration((end - at100) / 1000)} before it resets.`
    : html`Lasts to the reset at this rate, about ${Math.round(r.proj)}% by ${stamp(end)}.`;
  r.when = r.hit && whenAt(at100);
  r.left = r.hit && duration((end - at100) / 1000);
  r.why = {
    used: `${Math.round(w.percent)}% of ${name.toLowerCase()}, since ${stamp(from)}${x?.cost > 0 ? `; about ${usd(x.cost)} at API prices` : ""}. Anthropic reports whole percents.`,
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

const Info = ({ xp, why }) => html`<span class="xi"><${X} xp=${xp} why=${why} label=${html`${ICON.info}<span class="sr">How it is worked out</span>`} /></span>`;
const Kpi = ({ k, xp }) => html`<div class="ukpi ${k.big ? "big" : ""}"><span class="l">${k.l}${k.why && xp && html`<${Info} xp=${xp} why=${k.why} />`}</span><b>${k.v}</b><span class="s">${k.s}</span></div>`;
const UsageSkel = ({ label }) => html`<div class="uskel" role="status" aria-busy="true"><span class="sr">${label}</span>
  <div class="ukpis">${[1, 2, 3, 4, 5].map((i) => html`<div class="ukpi ${i === 1 ? "big" : ""}"><span class="l"><i class="skelv sm"></i></span><i class="skelv"></i><span class="s"><i class="skelv md"></i></span></div>`)}</div>
  <div class="ubskel" aria-hidden="true">${[38, 62, 45, 80, 30, 55, 70].map((h) => html`<i style=${`height:${h}%`}></i>`)}</div></div>`;

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
  ? `${weekday(bucketDate(k))} ${k.slice(11)}:00`
  : dayLabel(dayAt(k));
const bucketTick = (k, n) => k.length > 10 ? `${k.slice(11)}` : n <= 7 ? weekday(dayAt(k)) : dateLabel(dayAt(k));
const tickEvery = (hourly, n) => (hourly ? 6 : n <= 7 ? 1 : n <= 16 ? 2 : n <= 40 ? 7 : 14);

const costVal = (c) => html`${dollars(c)}<small>${wk(c)}</small>`;

function PickSection({ title, rows, on, onPick, name = (r) => r.name, sub, color, amount = (r) => r.cost, val = costVal }) {
  const [all, setAll] = useState(false);
  const top = all ? rows : rows.slice(0, 8);
  const total = rows.reduce((a, r) => a + amount(r), 0);
  return html`
    <section class="sec"><div class="sh"><h2>${title}</h2></div>
    <div class="upicks">
      ${top.map((r) => html`<button class="upick" aria-pressed=${on === r.name} onClick=${() => onPick(on === r.name ? null : r.name)}>
        <span class="nm">${color && html`<i class="umsw" style=${`background:${color(r.name)}`}></i>`}${name(r)}${sub && html`<small>${sub(r)}</small>`}</span>
        <span class="v">${val(amount(r))}</span>
        <i class="b" style=${`width:${total > 0 ? Math.max(0.5, (amount(r) / total) * 100) : 0}%`}></i></button>`)}
      ${rows.length > 8 && html`<button class="clr" onClick=${() => setAll(!all)}>${all ? "Show fewer" : `Show all ${rows.length}`}</button>`}
    </div></section>`;
}

const SPEND_BARS = { what: "Spend", max: niceMax, axis: (c) => dollars(c), say: (c) => withWk(c), short: (c) => dollars(c), least: 0.005, color: (m) => modelColor(m), name: (m) => modelName(m), rank: (p, q) => modelRank(p) - modelRank(q) };

function UsageBars({ days, data, models, sel, hourly, onPick, onPickModel, partial, on: picked = sel.model, as = SPEND_BARS }) {
  const [hover, setHover] = useState(null);
  const box = useRef();
  const n = days.length;
  const top = as.max(Math.max(0, ...days.map((d) => data.buckets[d]?.cost || 0)));
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
        <div class="uaxis"><span>${as.axis(top)}</span><span>${as.axis(top / 2)}</span><span></span></div>
        <div class=${`ucols ${sel.bucket ? "has" : ""}`} ref=${box} role="group" aria-label=${`${as.what} per ${hourly ? "hour" : "day"}. Pick one to see its sessions.`}>
          ${days.map((d, i) => {
            const x = data.buckets[d], parts = Object.entries(x?.models || {}).sort((p, q) => as.rank(p[0], q[0]));
            return html`<button class="ucol ${sel.bucket === d ? "on" : ""} ${d === partial ? "now" : ""}" tabindex=${i === focusAt ? 0 : -1} aria-pressed=${sel.bucket === d}
              aria-label=${`${bucketName(d)}, ${as.short(x?.cost || 0)}`} onClick=${() => onPick(sel.bucket === d ? null : d)}
              onPointerEnter=${() => matchMedia("(hover: hover)").matches && setHover(d)} onFocus=${() => setHover(d)} onBlur=${() => setHover(null)}>
              <span class="st" style=${`height:${x ? Math.max(1, (x.cost / top) * 100) : 0}%`}>${parts.map(([m, c]) => html`<i style=${`flex-grow:${c};background:${as.color(m)}`}></i>`)}</span></button>`;
          })}
        </div>
      </div>
      <div class="uticks" aria-hidden="true">${days.map((d, i) => html`<span>${(n - 1 - i) % every === 0 ? html`<em class=${d === partial ? "now" : ""}>${bucketTick(d, n)}</em>` : ""}</span>`)}</div>
      ${models.length > 1 && html`<div class="ulegend">${models.map((m) => html`<button aria-pressed=${picked === m.name} onClick=${() => onPickModel(picked === m.name ? null : m.name)}><i class="umsw" style=${`background:${as.color(m.name)}`}></i>${as.name(m.name)}</button>`)}</div>`}
      <div class="ro" aria-live="polite">${at
        ? html`<span>${bucketName(at)}${at === partial ? ", so far" : ""}</span><b>${b ? as.say(b.cost) : "nothing"}</b>
            ${b && html`<span>${plural(b.sessions, "session")}</span><span class="wide">${Object.entries(b.models).filter(([, c]) => c >= as.least).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([m, c]) => `${as.name(m)} ${as.short(c)}`).join(", ")}</span>`}`
        : html`<span>${touch ? "Tap" : "Pick"} a ${hourly ? "bar for that hour's" : "bar for that day's"} biggest sessions</span>`}</div>
    </div>`;
}

const SPEND_HOURS = { what: "cost per hour", label: "Cost per hour", least: 0.01, say: (c) => withWk(c, usd), short: (c) => usd(c), note: ". Every bay and model, not just your selection" };

function HoursMap({ days, hourly, range, filtered, as = SPEND_HOURS }) {
  const [cell, setCell] = useState(null);
  useEffect(() => setCell(null), [range]);
  if (hourly || !days.length) return null;
  const byDay = days.length <= 7;
  const rows = byDay ? days.map((d) => ({ key: d.day, label: weekday(dayAt(d.day)), long: dayLabel(dayAt(d.day)), hours: d.hours || Array(24).fill(0) }))
    : [1, 2, 3, 4, 5, 6, 0].map((wd) => {
      const hours = Array(24).fill(0);
      for (const d of days) if (new Date(`${d.day}T12:00`).getDay() === wd) (d.hours || []).forEach((c, h) => (hours[h] += c));
      const label = weekday(new Date(2024, 0, 7 + wd));
      return { key: `w${wd}`, label, long: `${label}s`, hours };
    });
  const hmax = Math.max(as.least, ...rows.flatMap((r) => r.hours));
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
    <section class="sec"><div class="sh"><h2>Hours</h2><span class="n">${as.what}${byDay ? "" : ", by weekday"}${filtered ? as.note : ""}</span></div>
      <div class="hm" tabindex="0" role="grid" aria-label=${`${as.label}. Arrow keys move; the line below reads the cell.`} onKeyDown=${moveCell}
        onPointerLeave=${() => matchMedia("(hover: hover)").matches && setCell(null)}>
        ${rows.map((r, di) => html`<span class="dl ${isNow(r) ? "today" : ""}">${r.label}</span>${r.hours.map((c, h) => html`
          <i class="${fut(r, h) ? "fut" : !c ? "z" : ""} ${at[0] === di && at[1] === h ? "on" : ""} ${r.key === todayKey && h === nowH ? "nowc" : ""}" style=${`--o:${lvl(c)}`}
            onPointerEnter=${() => !fut(r, h) && matchMedia("(hover: hover)").matches && setCell([di, h])} onClick=${() => !fut(r, h) && setCell([di, h])}></i>`)}`)}
      </div>
      <div class="hx"><span></span>${["0", "6", "12", "18"].map((t) => html`<span>${t}</span>`)}</div>
      ${atRow && html`<div class="ro" aria-live="polite"><span>${atRow.long}, ${String(at[1]).padStart(2, "0")}:00 to ${String((at[1] + 1) % 24).padStart(2, "0")}:00${atRow.key === todayKey && at[1] === nowH ? ", so far" : ""}</span>
        <b>${atCost > 0 ? as.say(atCost) : "nothing"}</b>
        <span class="scale">less ${[0.14, 0.3, 0.5, 0.7, 0.9].map((o) => html`<i style=${`opacity:${o}`}></i>`)} more, max ${as.short(hmax)} an hour</span></div>`}
    </section>`;
}

const gb = (n) => n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(n >= 100 * 2 ** 30 ? 0 : 1)} GB` : n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${Math.round(n || 0)} B`;
const procCount = (n) => `${n} ${n === 1 ? "process" : "processes"}`;
const ioRate = (r, w) => (r + w) < 1024 ? "" : `${gb(r)}/s read, ${gb(w)}/s written`;
const ioShort = (r, w) => (r + w) < 1024 ? "" : `${gb(r + w)}/s`;
const shortLoad = (l) => [l.mem > 0 && gb(l.mem), l.cpu > 0 && `${l.cpu}% CPU`].filter(Boolean).join(", ");
const hotLoad = (l) => l.mem >= 4 * 2 ** 30 || l.cpu >= 300;
const LoadTag = ({ s, short }) => s.load ? html`<span class="load ${hotLoad(s.load) ? "hot" : ""}" title=${`This session and its processes: ${[s.load.mem > 0 && gb(s.load.mem), s.load.cpu > 0 && `${s.load.cpu}% of a core`].filter(Boolean).join(", ")}`}>${short ? [s.load.mem > 0 && gb(s.load.mem), s.load.cpu >= 300 && `${s.load.cpu}%`].filter(Boolean).join(" ") : shortLoad(s.load)}</span>` : null;


const RES_RANGES = [["1h", 1], ["6h", 6], ["24h", 24], ["7d", 168]];
const RES_SERIES = 5;
const resId = (g) => `${g.o}/${g.k}`;

function resRows(raw) {
  return (raw || []).map((r) => ({ ...r, by: new Map((r.g || []).map((g) => [resId(g), g])) }));
}

function resSeries(rows) {
  const seen = new Map();
  for (const r of rows) {
    for (const g of r.g || []) {
      const x = seen.get(resId(g)) || { id: resId(g), title: g.l || g.k, kind: g.o, peak: 0, cpu: 0 };
      x.peak = Math.max(x.peak, g.m);
      x.cpu += g.c / rows.length;
      if (g.l) x.title = g.l;
      seen.set(x.id, x);
    }
  }
  const last = rows[rows.length - 1];
  const score = (x) => x.peak / (last?.total || 1) + x.cpu / (100 * (last?.cores || 1));
  const all = [...seen.values()].sort((a, b) => score(b) - score(a));
  return { all: new Map(all.map((x) => [x.id, x])), top: all.slice(0, RES_SERIES).sort((a, b) => a.id.localeCompare(b.id)).map((x, i) => ({ ...x, color: `var(--series-${i + 1})` })) };
}

function ResChart({ name, rows, series, of, whole, max, say, tick, hours, t0, t1, at, onAt, onPin, pinned }) {
  const box = useRef();
  const W = 1000, H = 100;
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (v) => H - (Math.min(v, max) / max) * H;
  const step = rows.length > 1 ? (rows[rows.length - 1].t - rows[0].t) / (rows.length - 1) : 60;
  const parts = [[]];
  rows.forEach((r, i) => {
    if (i && r.t - rows[i - 1].t > Math.max(step * 3, 180)) parts.push([]);
    parts[parts.length - 1].push(r);
  });
  const area = (part, lo, hi) => part.length < 2 ? "" : `M${part.map((r) => `${x(r.t).toFixed(1)} ${y(hi(r)).toFixed(2)}`).join("L")}L${[...part].reverse().map((r) => `${x(r.t).toFixed(1)} ${y(lo(r)).toFixed(2)}`).join("L")}Z`;
  const under = (r, n) => { let v = 0; for (let i = 0; i < n; i++) v += of(r.by.get(series[i].id)); return v; };
  const near = (e) => {
    const b = box.current.getBoundingClientRect();
    const t = t0 + ((e.clientX - b.left) / b.width) * (t1 - t0);
    let best = -1, d = Infinity;
    rows.forEach((r, i) => { const n = Math.abs(r.t - t); if (n < d) { d = n; best = i; } });
    return best;
  };
  const cur = at != null ? rows[at] : null;
  return html`
    <div class="rchart">
      <div class="rc-h"><b>${name}</b><span>${cur ? `${whenAt((cur.t) * 1000)}  ${say(whole(cur))}` : ""}</span></div>
      <div class="rc-p">
        <div class="rc-ax"><span>${tick(max)}</span><span>${tick(max / 2)}</span><span></span></div>
        <div class="rc-plot" ref=${box} role="img" aria-label=${`${name} over time, by session. The table below has the numbers.`}
          onPointerMove=${(e) => matchMedia("(hover: hover)").matches && onAt(near(e))} onPointerLeave=${() => onAt(null)} onClick=${(e) => onPin(near(e))}>
          <svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            ${parts.map((part) => html`
              ${series.map((s, i) => html`<path d=${area(part, (r) => under(r, i), (r) => under(r, i + 1))} fill=${s.color} />`)}
              <path class="rest" d=${area(part, (r) => under(r, series.length), (r) => Math.max(whole(r), under(r, series.length)))} />`)}
          </svg>
          ${cur && html`<i class="rc-x" style=${`left:${(x(cur.t) / W) * 100}%`}></i>`}
          ${pinned != null && rows[pinned] && html`<i class="rc-x pin" style=${`left:${(x(rows[pinned].t) / W) * 100}%`}></i>`}
        </div>
      </div>
    </div>`;
}

function ResTree({ procs }) {
  const has = new Set(procs.map((p) => p.pid));
  const kids = new Map();
  for (const p of procs) {
    const up = has.has(p.ppid) ? p.ppid : 0;
    kids.set(up, [...(kids.get(up) || []), p]);
  }
  const out = [];
  const walk = (pid, depth) => { for (const p of (kids.get(pid) || []).sort((a, b) => b.mem - a.mem)) { out.push([p, depth]); walk(p.pid, depth + 1); } };
  walk(0, 0);
  return html`<div class="rtree">${out.map(([p, depth]) => html`
    <div class="rp" title=${p.cmd}>
      <span class="n" style=${`padding-left:${Math.min(depth, 6) * 12}px`}>${p.name}<small>${p.pid}</small></span>
      <span class="m">${gb(p.mem)}</span><span class="c">${Math.round(p.cpu)}%</span><span class="a">${p.age > 0 ? duration(p.age) : ""}</span>
      <span class="cmd">${p.cmd}</span>
    </div>`)}</div>`;
}

function ResGroup({ g, colorOf, open, onToggle, peak }) {
  const color = colorOf(`${g.kind}/${g.key}`);
  const tops = g.top || [];
  const link = g.kind === "session" ? `#/s/${g.key}` : g.sessionId ? `#/s/${g.sessionId}` : null;
  const expandable = g.procs?.length > 0;
  return html`
    <div class="rg ${open ? "open" : ""}">
      <div class="rrow" role=${expandable ? "button" : null} tabindex=${expandable ? 0 : null} aria-expanded=${expandable ? open : null}
        onClick=${expandable ? onToggle : null} onKeyDown=${(e) => expandable && e.key === "Enter" && e.target === e.currentTarget && onToggle()}>
        <span class="who">
          <span class="t">${color && html`<i class="umsw" style=${`background:${color}`}></i>`}${link ? html`<a href=${link} onClick=${(e) => e.stopPropagation()}>${g.title}</a>` : html`<b>${g.title}</b>`}</span>
          <span class="s">${g.detail ? tilde(g.detail) : tops.slice(0, 3).map((t) => `${t.n} ${gb(t.m)}`).join(", ")}</span>
        </span>
        <span class="v">${gb(g.mem)}</span>
        <span class="v">${Math.round(g.cpu)}%</span>
        <span class="v wide" title=${ioRate(g.read, g.write)}>${ioShort(g.read, g.write)}</span>
        <span class="v wide">${g.count || ""}</span>
        <span class="v wide peak">${peak ? gb(peak) : ""}</span>
      </div>
      ${open && expandable && html`
        ${g.rssOnly && html`<p class="rnote">Each process here shows resident memory, which counts shared memory in every process, so they add up to more than the group's total.</p>`}
        <${ResTree} procs=${g.procs} />`}
    </div>`;
}

function ResTile({ label, value, rows, of, say, peakAt }) {
  const box = useRef();
  const [at, setAt] = useState(null);
  const pts = rows.map((r) => ({ t: r.t, v: of(r) }));
  const now = Date.now() / 1000, t0 = Math.max(now - RES_PANE_HOURS * 3600, pts[0]?.t ?? 0);
  const top = Math.max(1, ...pts.map((p) => p.v));
  const x = (t) => ((t - t0) / (now - t0)) * 100;
  const y = (v) => 24 - (v / top) * 22;
  const parts = [[]];
  pts.forEach((p, i) => { if (i && p.t - pts[i - 1].t > 300) parts.push([]); parts[parts.length - 1].push(p); });
  const drawn = parts.filter((part) => part.length > 1);
  const pick = (e) => {
    const b = box.current.getBoundingClientRect(), t = t0 + ((e.clientX - b.left) / b.width) * (now - t0);
    setAt(pts.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), pts[0]));
  };
  const peak = pts.length ? pts.reduce((a, p) => (p.v > a.v ? p : a), pts[0]) : null;
  const clock = (t) => whenAt(t * 1000);
  return html`
    <div class="rt">
      <span class="l">${label}</span>
      <b>${value}</b>
      ${drawn.length > 0 && html`<div class="spark" ref=${box} role="img" aria-label=${`${label} over the last ${RES_PANE_HOURS} hours, highest ${say(peak.v)} at ${clock(peak.t)}`}
        onPointerMove=${pick} onPointerDown=${pick} onPointerLeave=${() => setAt(null)}>
        <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
          ${drawn.map((part) => html`
            <path class="a" d=${`M${x(part[0].t)} 24L${part.map((p) => `${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`).join("L")}L${x(part[part.length - 1].t)} 24Z`} />
            <path class="n" d=${`M${part.map((p) => `${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`).join("L")}`} />`)}
        </svg>
        ${at && html`<i style=${`left:${x(at.t)}%`}></i>`}
      </div>`}
      <span class="s">${at ? `${clock(at.t)}, ${say(at.v)}` : peak && drawn.length > 0 ? `peak ${say(peak.v)} at ${clock(peak.t)}` : ""}</span>
    </div>`;
}

const RES_PANE_HOURS = 6;
const RES_OWN_PARTS = new Set(["Claude", "Browser tool", "atc tools"]);

function SessionResources({ s }) {
  const [rep, setRep] = useState(null);
  const [raw, setRaw] = useState([]);
  const [tree, setTree] = useState(false);
  const key = keyOf(s);
  const q = s.host ? `&host=${encodeURIComponent(s.host)}` : "";
  useEffect(() => {
    const load = () => document.visibilityState === "visible" && api(`/api/resources?${q.slice(1)}`).then(setRep, () => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [q]);
  useEffect(() => {
    const load = () => document.visibilityState === "visible" && api(`/api/resources/history?hours=${RES_PANE_HOURS}&key=${encodeURIComponent(key)}${q}`).then(setRaw, () => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [key, q]);
  const rows = useMemo(() => (raw || []).map((r) => ({ t: r.t, g: (r.g || [])[0] })).filter((r) => r.g), [raw]);
  if (!rep) return null;
  const mine = (g) => g.key === key || (g.sessionId && g.sessionId === s.sessionId);
  const g = (rep.sessions || []).find(mine) || (rep.left || []).find(mine);
  if (!g) return null;
  const parts = partsOf(g.procs || []);
  const disk = (rep.disk || []).filter((d) => d.sessions?.includes(s.title) && d.size >= 100 * 2 ** 20);
  return html`
    <section class="sres">
      <div class="sresh"><h3>Resources</h3><a href=${RESOURCES}>All on ${s.host || "this machine"}</a></div>
      ${g.kind === "left" && html`<p class="rnote">This session ended and these kept running.</p>`}
      <div class="rts">
        <${ResTile} label="Memory" value=${gb(g.mem)} rows=${rows} of=${(r) => r.g.m} say=${gb} />
        <${ResTile} label="CPU" value=${`${Math.round(g.cpu)}%`} rows=${rows} of=${(r) => r.g.c} say=${(c) => `${Math.round(c)}%`} />
      </div>
      <ul class="rparts">${parts.map((p) => html`
        <li>
          <div class="ln"><b>${p.name}</b>${p.cpu >= 1 && html`<span class="c">${Math.round(p.cpu)}%</span>`}<span class="m">${gb(p.mem)}</span></div>
          <i class="bar"><i style=${`width:${g.mem ? Math.max(1, (p.mem / g.mem) * 100) : 0}%`}></i></i>
          ${!RES_OWN_PARTS.has(p.name) && html`<div class="dt">${[p.port && `:${p.port}`, p.folder, p.procs.length > 1 && procCount(p.procs.length), p.age > 0 && `up ${duration(p.age)}`].filter(Boolean).join(", ")}</div>`}
        </li>`)}</ul>
      ${g.read + g.write >= 1024 && html`<p class="rline"><span>Disk now</span><b>${ioShort(g.read, g.write)}</b></p>`}
      ${disk.map((d) => html`<p class="rline" title=${d.path}><span>${d.path.split("/").pop()} on disk</span><b>${gb(d.size)}</b></p>`)}
      <button class="kb rtgl" aria-expanded=${tree} onClick=${() => setTree((x) => !x)}>${tree ? "Hide processes" : `Show ${procCount(g.count)}`}</button>
      ${tree && html`<${ResTree} procs=${g.procs || []} />`}
    </section>`;
}

const RES_SORT = { mem: ["Memory", (g) => g.mem], cpu: ["CPU", (g) => g.cpu], io: ["Disk", (g) => g.read + g.write] };

function ResSection({ title, note, groups, colorOf, peaks, sort, opened, toggle, tail }) {
  if (!groups.length) return null;
  return html`
    <section class="sec rsec">
      <div class="sh"><h2>${title}</h2>${note && html`<span class="n">${note}</span>`}</div>
      <div class="rrow rhead" aria-hidden="true"><span></span><span class="v">Memory</span><span class="v">CPU</span><span class="v wide">Disk</span><span class="v wide">Procs</span><span class="v wide" title="Highest in this range. Kept only above 500 MB or 10% of a core.">Peak</span></div>
      ${[...groups].sort((a, b) => RES_SORT[sort][1](b) - RES_SORT[sort][1](a)).map((g) => html`<${ResGroup} key=${g.kind + g.key} g=${g} colorOf=${colorOf} peak=${peaks.get(`${g.kind}/${g.key}`)} open=${opened === g.kind + g.key} onToggle=${() => toggle(g.kind + g.key)} />`)}
      ${tail}
    </section>`;
}

function ResourcesPage({ hosts, home, live }) {
  const [v, setV] = useState(() => ({ range: "6h", sort: "mem", ...stored("atc.resources", {}) }));
  const set = (p) => setV((x) => { const n = { ...x, ...p }; store("atc.resources", n); return n; });
  const host = hosts.includes(v.host) ? v.host : home;
  const hours = (RES_RANGES.find((r) => r[0] === v.range) || RES_RANGES[1])[1];
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState(null);
  const [raw, setRaw] = useState(null);
  const [hover, setHover] = useState(null);
  const [pin, setPin] = useState(null);
  const [opened, setOpened] = useState(null);
  const q = host === home ? "" : `host=${encodeURIComponent(host)}`;
  useEffect(() => {
    setRep(null); setErr(null);
    const load = () => document.visibilityState === "visible" && api(`/api/resources${q && `?${q}`}`).then((r) => { setRep(r); setErr(null); }, (e) => setErr(e.message || "unreachable"));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [q]);
  useEffect(() => {
    setPin(null); setHover(null);
    const load = () => document.visibilityState === "visible" && api(`/api/resources/history?hours=${hours}${q && `&${q}`}`).then(setRaw, () => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [q, hours]);
  const rows = useMemo(() => resRows(raw), [raw]);
  const { all, top } = useMemo(() => resSeries(rows), [rows]);
  const colorOf = (id) => top.find((s) => s.id === id)?.color;
  const peaks = useMemo(() => new Map([...all.values()].map((x) => [x.id, x.peak])), [all]);
  const m = rep?.machine;
  const now = rep ? Date.parse(rep.at) / 1000 : Date.now() / 1000;
  const t0 = now - hours * 3600;
  const moment = pin != null && rows[pin] ? rows[pin] : null;
  const shown = hover ?? pin;
  const cores = m?.cores || rows[rows.length - 1]?.cores || 1;
  const total = m?.memTotal || rows[rows.length - 1]?.total || 1;
  const past = moment && (moment.g || []).map((g) => ({ key: g.k, kind: g.o, title: g.l || g.k, cpu: g.c, mem: g.m, read: g.r || 0, write: g.w || 0, top: g.p }));
  const named = (g) => ({ ...g, top: g.top || resTops(g.procs) });
  const groupsOf = (kind) => (past ? past.filter((g) => g.kind === kind) : ((kind === "session" ? rep?.sessions : kind === "left" ? rep?.left : rep?.outside) || []).map(named));
  const bayByKey = useMemo(() => { const m = new Map(); for (const x of live || []) { const n = bayOf(x) || "other"; if (x.id) m.set(x.id, n); m.set(x.sessionId, n); } return m; }, [live]);
  const allSessions = groupsOf("session"), left = groupsOf("left"), outside = groupsOf("outside");
  const bayNames = [...new Set(allSessions.map((g) => bayByKey.get(g.key) || "other"))];
  const bayMem = (b) => allSessions.filter((g) => (bayByKey.get(g.key) || "other") === b).reduce((a, g) => a + g.mem, 0);
  const bayPicked = bayNames.includes(v.bay) ? v.bay : null;
  const sessions = bayPicked ? allSessions.filter((g) => (bayByKey.get(g.key) || "other") === bayPicked) : allSessions;
  const sum = (l) => (l || []).reduce((a, g) => a + g.mem, 0);
  const toggle = (id) => setOpened((x) => (x === id ? null : id));
  const disk = m?.disks?.[0];
  const pressure = m?.pressure > 0 ? `${m.pressure.toFixed(1)}%` : "0%";
  const kpis = m ? [
    { l: "Memory", big: true, v: `${gb(m.memUsed)} of ${gb(m.memTotal)}`, s: `sessions ${gb(sum(rep.sessions))}${rep.left?.length ? `, outlived ${gb(sum(rep.left))}` : ""}, rest ${gb(Math.max(0, m.memUsed - sum(rep.sessions) - sum(rep.left)))}` },
    { l: "CPU", v: `${Math.round(m.cpu / cores)}%`, s: `of ${m.cores} cores, load ${m.load.toFixed(1)}` },
    { l: "Waiting on memory", v: pressure, s: `of the last minute${m.swapTotal > 0 ? `, swap ${gb(m.swapUsed)} of ${gb(m.swapTotal)}` : ""}` },
    m.ramDisk > 0 && { l: "Files in RAM", v: gb(m.ramDisk), s: "/tmp and /dev/shm, owned by no process" },
    disk && { l: "Disk", v: `${gb(disk.size - disk.used)} free`, s: `of ${gb(disk.size)}${m.read + m.write >= 1024 ? `, ${gb(m.read + m.write)}/s now` : ""}` },
  ].filter(Boolean) : [];
  const status = err ? `${host} did not answer: ${err}` : !rep ? "Measuring…" : !rep.at || !Date.parse(rep.at) ? "Measuring…"
    : `${bayPicked ? `${bayPicked}: ` : ""}${plural(sessions.length, "session")} using ${gb(sum(sessions))}`;
  return html`
    <section class="scrpane usage res" aria-label="Resources">
      <header class="phd">
        <h1>Resources</h1><span class="where" title=${rep?.cost > 0 ? `Measuring takes about ${Math.round(rep.cost * 1000)} ms every 10 s` : null}>${host} · ${status}</span>
      </header>
      <div class="scroll"><div class="ubody">
        <div class="sec rtools">
          ${hosts.length > 1 && html`<span class="seg" role="group" aria-label="Machine">${hosts.map((h) => html`<button aria-pressed=${h === host} onClick=${() => { set({ host: h }); setOpened(null); }}>${h}</button>`)}</span>`}
          <span class="seg" role="group" aria-label="Range">${RES_RANGES.map(([k]) => html`<button aria-pressed=${k === v.range} onClick=${() => set({ range: k })}>${k}</button>`)}</span>
          <span class="seg" role="group" aria-label="Sort by">${Object.entries(RES_SORT).map(([k, [n]]) => html`<button aria-pressed=${k === v.sort} onClick=${() => set({ sort: k })}>${n}</button>`)}</span>
        </div>
        ${kpis.length > 0 && html`<div class="sec ukpis">${kpis.map((k) => html`<div class="ukpi ${k.big ? "big" : ""}"><span class="l">${k.l}</span><b>${k.v}</b><span class="s">${k.s}</span></div>`)}</div>`}
        <section class="sec rcharts">
          ${rows.length < 2 ? html`<p class="none">History starts now: a point a minute, kept for a week.</p>` : html`
            <${ResChart} name="Memory" rows=${rows} series=${top} of=${(g) => g?.m || 0} whole=${(r) => r.mem} max=${total} say=${gb} tick=${(n) => `${Math.round(n / 2 ** 30)} GB`} hours=${hours} t0=${t0} t1=${now} at=${shown} onAt=${setHover} onPin=${(i) => setPin((p) => (p === i ? null : i))} pinned=${pin} />
            <${ResChart} name="CPU" rows=${rows} series=${top} of=${(g) => g?.c || 0} whole=${(r) => r.cpu} max=${cores * 100} say=${(c) => `${(c / 100).toFixed(1)} cores`} tick=${(c) => `${Math.round(c / 100)} cores`} hours=${hours} t0=${t0} t1=${now} at=${shown} onAt=${setHover} onPin=${(i) => setPin((p) => (p === i ? null : i))} pinned=${pin} />
            <div class="rc-t" aria-hidden="true"><span>${whenAt((t0) * 1000)}</span><span>${whenAt(((t0 + now) / 2) * 1000)}</span><span>now</span></div>
            <div class="ulegend rleg">${top.map((s) => html`<span><i class="umsw" style=${`background:${s.color}`}></i>${s.title}</span>`)}<span><i class="umsw rest"></i>everything else</span></div>`}
        </section>
        ${moment ? html`<p class="sec rat"><b>At ${whenAt((moment.t) * 1000)}</b> ${moment.ram > 0 ? `${gb(moment.ram)} of files in RAM. ` : ""}Only what used over 500 MB or 10% of a core is kept per minute. <button class="btn" onClick=${() => setPin(null)}>Back to now</button></p>`
          : rows.length > 1 && html`<p class="sec rat quiet">${touch ? "Tap" : "Click"} a chart to see who was using what at that moment.</p>`}
        ${!moment && html`<${ResIncidents} q=${q} />`}
        <${ResSection} title="Outlived their session" note="Their session ended, these kept running. Some are on purpose, like a dev stack other sessions use, so look before stopping one." groups=${left} colorOf=${colorOf} peaks=${peaks} sort=${v.sort} opened=${opened} toggle=${toggle} />
        ${bayNames.length > 1 && html`<div class="sec rbays" role="group" aria-label="Sessions of one bay">
          <button aria-pressed=${!bayPicked} onClick=${() => set({ bay: null })}>All<span>${gb(sum(allSessions))}</span></button>
          ${[...bayNames].sort((a, b) => bayMem(b) - bayMem(a)).map((b) => html`<button aria-pressed=${b === bayPicked} onClick=${() => set({ bay: b === bayPicked ? null : b })}>${b}<span>${gb(bayMem(b))}</span></button>`)}
        </div>`}
        <${ResSection} title=${bayPicked ? `Sessions in ${bayPicked}` : "Sessions"} note="Each with every process it started. Memory is each process's own share, so shared pages are not counted twice." groups=${sessions} colorOf=${colorOf} peaks=${peaks} sort=${v.sort} opened=${opened} toggle=${toggle} />
        <${ResSection} title="Outside sessions" note="Containers and services, by cgroup." groups=${outside} colorOf=${colorOf} peaks=${peaks} sort=${v.sort} opened=${opened} toggle=${toggle}
          tail=${!moment && rep?.rest?.count > 0 && html`<p class="rnote">And ${procCount(rep.rest.count)} more: ${gb(rep.rest.mem)}, ${Math.round(rep.rest.cpu)}% CPU.</p>`} />
        ${!moment && rep?.ramDirs?.length > 0 && html`
          <section class="sec rsec rdisk">
            <div class="sh"><h2>Files in RAM</h2><span class="n">The biggest folders in /tmp. They count as memory until deleted, whoever made them.</span></div>
            ${rep.ramDirs.map((d) => html`<div class="rd-row"><span class="who"><span class="t mono">${d.path}</span></span><span class="v">${gb(d.size)}</span></div>`)}
          </section>`}
        ${!moment && rep?.disk?.length > 0 && html`
          <section class="sec rsec rdisk">
            <div class="sh"><h2>On disk</h2><span class="n">Repos and worktrees sessions work in, plus Claude's own files. Added up every hour${rep.diskAt ? `, last ${agoLong(rep.diskAt)}` : ""}.</span></div>
            ${rep.disk.filter((d) => d.size >= 2 ** 20).slice(0, 24).map((d) => html`
              <div class="rd-row"><span class="who"><span class="t mono" title=${tilde(d.path)}>${clipPath(tilde(d.path), 56)}</span><span class="s">${d.kind === "claude" ? "Claude Code" : d.sessions?.length ? d.sessions.join(", ") : `${d.kind}, no session in it`}</span></span><span class="v">${gb(d.size)}</span></div>`)}
          </section>`}
      </div></div>
    </section>`;
}

function resTops(procs = []) {
  const by = new Map();
  for (const p of procs) by.set(p.name, (by.get(p.name) || 0) + p.mem);
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, m]) => ({ n, m }));
}

const EndTag = ({ s }) => unexpected(s) && s.ended.short
  ? html`<span class="endtag ${s.ended.cause === "oom" || s.ended.cause === "crashed" ? "bad" : ""}" title=${s.ended.text}>${s.ended.short}</span>` : null;
const SRC_TAG = { "Claude's daemon log": "claude", "kernel log": "kernel", systemd: "systemd", atc: "atc", "atc resources": "res" };

function Evidence({ lines }) {
  if (!lines?.length) return null;
  return html`<ol class="evid" aria-label="What it rests on">${lines.map((l) => html`<li>
    <span class="tm">${hhmm(l.at, true)}</span><span class="src ${SRC_TAG[l.source] || ""}">${l.source}</span>
    <span class="tx">${l.text}${l.raw && html`<details><summary>Log line</summary><pre>${l.raw}</pre></details>`}</span></li>`)}</ol>`;
}

function IncidentView({ inc, self }) {
  const rows = useMemo(() => resRows(inc.rows), [inc]);
  const { top } = useMemo(() => resSeries(rows), [rows]);
  const [hover, setHover] = useState(null);
  const killAt = Date.parse(inc.kills?.[0]?.at || inc.at) / 1000;
  const mark = rows.length ? rows.reduce((b, r, i) => (Math.abs(r.t - killAt) < Math.abs(rows[b].t - killAt) ? i : b), 0) : null;
  const t0 = rows[0]?.t, t1 = rows[rows.length - 1]?.t;
  const who = (l) => html`<a href=${`#/s/${l.id}`} aria-current=${self && (l.sessionId === self || l.id === self) ? "true" : null}>${l.title}</a>`;
  return html`<div class="incident">
    <p class="it">${inc.text}</p>
    ${rows.length > 1 && html`<div class="ichart">
      <${ResChart} name="Memory" rows=${rows} series=${top} of=${(g) => g?.m || 0} whole=${(r) => r.mem} max=${inc.total || rows[rows.length - 1].total || 1} say=${gb}
        tick=${(n) => `${Math.round(n / 2 ** 30)} GB`} hours=${1} t0=${t0} t1=${t1} at=${hover} onAt=${setHover} onPin=${() => {}} pinned=${mark} />
      <div class="rc-t" aria-hidden="true"><span>${whenAt((t0) * 1000)}</span><span>${whenAt(((t0 + t1) / 2) * 1000)}</span><span>${whenAt((t1) * 1000)}</span></div>
      <div class="ulegend rleg">${top.map((x) => html`<span><i class="umsw" style=${`background:${x.color}`}></i>${x.title}</span>`)}<span><i class="umsw rest"></i>everything else</span>
        ${mark != null && html`<span><i class="ikill"></i>${inc.kills?.length ? "the kill" : "the warning"}</span>`}</div>
    </div>`}
    ${inc.lost?.length > 0 && html`<p class="ilost"><span>Stopped with it</span>${inc.lost.map(who)}</p>`}
    ${inc.closed?.length > 0 && html`<p class="ilost"><span>Closed for memory</span>${inc.closed.map(who)}</p>`}
    <${Evidence} lines=${inc.evidence} />
  </div>`;
}

function EndWhy({ s, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { setD(null); api(`/api/sessions/${s.sessionId}/ended${onHost(s)}`).then(setD, (e) => setErr(e.message)); }, [s.sessionId, s.ended?.at]);
  const inc = d?.incident;
  return html`<section class="endwhy" aria-label="Why it stopped"><div class="cols"><div class="cx">
    <div class="ewh"><h3>${inc ? inc.title : "Why it stopped"}</h3><button class="btn" onClick=${onClose}>Close</button></div>
    ${err ? html`<p class="none">${err}</p>` : !d ? html`<p class="none">Reading the logs…</p>`
      : inc ? html`<${IncidentView} inc=${inc} self=${s.sessionId} />`
      : html`<p class="it">${d.ending?.text}</p><${Evidence} lines=${d.ending?.evidence} />`}
  </div></div></section>`;
}

function ResIncidents({ q }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [full, setFull] = useState(null);
  useEffect(() => { setOpen(null); api(`/api/resources/incidents${q && `?${q}`}`).then(setList, () => setList([])); }, [q]);
  useEffect(() => { setFull(null); open && api(`/api/resources/incidents/${open}${q && `?${q}`}`).then(setFull, () => {}); }, [open, q]);
  if (!list?.length) return null;
  return html`<section class="sec rsec rinc">
    <div class="sh"><h2>Memory incidents</h2><span class="n">The last week: when memory ran out, what the kernel or Claude's daemon stopped, and which sessions it cost.</span></div>
    ${list.map((i) => html`<div class="ri ${open === i.id ? "open" : ""}">
      <button class="rirow" aria-expanded=${open === i.id} onClick=${() => setOpen((o) => (o === i.id ? null : i.id))}>
        <span class="when">${whenAt(i.at)}</span>
        <span class="what"><b>${i.title}</b><span>${i.text}</span></span>
        <span class="v">${i.lost?.length ? `${plural(i.lost.length, "session")} stopped` : i.closed?.length ? `${i.closed.length} closed` : ""}</span>
      </button>
      ${open === i.id && (full ? html`<${IncidentView} inc=${full} />` : html`<p class="none">Reading the logs…</p>`)}
    </div>`)}
  </section>`;
}

function useMachineBrief() {
  const [b, setB] = useState(null);
  useEffect(() => {
    const load = () => document.visibilityState === "visible" && api("/api/resources?brief=1").then(setB, () => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  return b;
}

function UsageTabs({ at, accounts, on, onPick }) {
  const view = (key, label, hash) => html`<button aria-pressed=${at === key} onClick=${() => at !== key && location.replace(hash)}>${label}</button>`;
  return html`<span class="utabs">
    ${accounts.length > 0 && html`<span class="seg" role="group" aria-label="Claude account">${accounts.map(([k, label]) => html`<button aria-pressed=${k === on} onClick=${() => onPick(k)}>${label}</button>`)}</span>`}
    <span class="seg" role="group" aria-label="Spend or time">${view("usage", "Spend", USAGE)}${view("time", "Time", TIME)}</span></span>`;
}

const TIME_HOW = "Counted in 5-second ticks while atc is the visible, focused window, for what is open in it. Input keeps it counting for 30 seconds; a longer pause counts its first 30 seconds only. Two devices at once count once. Left out: other apps, a terminal attached with atc attach, voice calls, and anything another session or a schedule typed.";
const TIME_RANGES = [["1", "Today", "today", "yesterday"], ["7", "7d", "the last 7 days", "the 7 days before"], ["30", "30d", "the last 30 days", "the 30 days before"], ["all", "All", "all time"]];
const TIME_COLS = [["title", "Session", ""], ["bay", "Bay", "c-bay"], ["count", "Days", "n c-st"], ["secs", "Time", "n"], ["share", "Share", "c-sh"], ["spend", "Spend", "n c-m"], ["last", "Last", "n"]];
const TIME_SERIES = 5;
const spanMax = (secs) => [300, 900, 1800, 3600, 7200, 14400, 21600, 28800, 43200, 86400].find((x) => x >= secs) || Math.ceil(secs / 86400) * 86400;
const OTHER_BAYS = "other";

function useTimeReport(days) {
  const [t, setT] = useState(null);
  useEffect(() => {
    let on = true;
    setT(null);
    const load = () => api(`/api/time?days=${days}`).then((x) => on && setT(x), () => on && setT((x) => x || { failed: true }));
    load();
    const i = setInterval(load, 60000);
    return () => { on = false; clearInterval(i); };
  }, [days]);
  return t;
}

function useAccountReports(days, profs) {
  const [reps, setReps] = useState({});
  const names = profs.map((p) => (p.default ? "" : p.name)).join();
  useEffect(() => {
    let on = true;
    setReps({});
    for (const p of profs) api(`/api/usage/report?days=${days}${profQ(p.default ? "" : p.name, "&")}`).then((r) => on && setReps((x) => ({ ...x, [p.name]: r })), () => {});
    return () => { on = false; };
  }, [days, names]);
  return profs.length > 0 && profs.every((p) => reps[p.name]) ? reps : null;
}

// One day reads per bay; a range reads one line per day, each block in its bay's colour.
function DayLine({ runs, color, what }) {
  const [at, setAt] = useState(null);
  const H = 3600000, sinceMidnight = (r, t) => (t - new Date(`${r.day}T00:00`).getTime()) / H;
  const oneDay = runs.every((r) => r.day === runs[0].day);
  const rows = useMemo(() => {
    const m = new Map();
    for (const r of runs) {
      const k = oneDay ? r.s.bay : r.day;
      const row = m.get(k) || { name: oneDay ? r.s.bay : dayLabel(dayAt(r.day)), key: k, secs: 0, runs: [] };
      row.secs += r.secs;
      const last = row.runs[row.runs.length - 1];
      if (last && last.s === r.s && r.from - last.to <= 60000) { last.to = r.to; last.secs += r.secs; } else row.runs.push({ ...r });
      m.set(k, row);
    }
    return [...m.values()].sort(oneDay ? (a, b) => b.secs - a.secs : (a, b) => (a.key < b.key ? 1 : -1));
  }, [runs]);
  useEffect(() => setAt(null), [runs]);
  const h0 = Math.floor(Math.min(...runs.map((r) => sinceMidnight(r, r.from)))), h1 = Math.max(h0 + 1, Math.ceil(Math.max(...runs.map((r) => sinceMidnight(r, r.to)))));
  const x = (r, t) => ((sinceMidnight(r, t) - h0) / (h1 - h0)) * 100;
  const step = Math.max(1, Math.ceil((h1 - h0) / 8));
  const marks = Array.from({ length: h1 - h0 + 1 }, (_, i) => h0 + i).filter((h) => (h - h0) % step === 0);
  const pos = (h) => `left:${((h - h0) / (h1 - h0)) * 100}%`;
  return html`<section class="sec udayl"><div class="sh"><h2>${oneDay ? bucketName(runs[0].day) : "Day by day"}</h2><span class="n">${oneDay ? "when you were in which bay" : `when you were in which bay, ${what}`}</span></div>
    <div class="dl-rows ${oneDay ? "" : "days"}" role="img" aria-label=${rows.map((r) => `${r.name} ${duration(r.secs)}`).join(", ")} onPointerLeave=${() => setAt(null)}>
      ${rows.map((row) => html`<span class="dl-n">${row.name}</span><span class="dl-t">${marks.map((h) => html`<em style=${pos(h)}></em>`)}${row.runs.map((r) => html`
        <i class=${at && at.from === r.from ? "on" : ""} style=${`left:${x(r, r.from)}%;width:${x(r, r.to) - x(r, r.from)}%;background:${color(r.s.bay)}`} onPointerEnter=${() => setAt(r)} onClick=${() => setAt(r)}></i>`)}</span><span class="dl-v">${duration(row.secs)}</span>`)}
      <span></span><span class="dl-x">${marks.map((h) => html`<em style=${pos(h)}>${h % 24}</em>`)}</span><span></span>
    </div>
    <div class="ro" aria-live="polite">${at ? html`<span>${oneDay ? "" : `${weekday(dayAt(at.day))} `}${hhmm(at.from)} to ${hhmm(at.to)}</span><b>${duration(at.secs)}</b><span>${at.s.title || at.s.sessionId.slice(0, 8)}${oneDay ? "" : `, ${at.s.bay}`}</span>`
      : html`<span>${touch ? "Tap" : "Point at"} a block for its session</span>`}</div></section>`;
}

function TimePage({ live, onOpen }) {
  const xp = useExplain();
  useNow(60000);
  const [v, setV] = useState(() => {
    const x = { sort: "secs", dir: -1, q: "", range: "7", account: "", ...stored("atc.timepage", {}) };
    return TIME_COLS.some(([k]) => k === x.sort) ? x : { ...x, sort: "secs", dir: -1 };
  });
  const set = (p) => setV((x) => { const n = { ...x, ...p }; store("atc.timepage", n); return n; });
  const def = TIME_RANGES.find((r) => r[0] === v.range) || TIME_RANGES[1];
  const [profs, setProfs] = useState([]);
  useEffect(() => { loadProfiles().then(setProfs); }, []);
  const account = profs.some((p) => p.name === v.account) ? v.account : "";
  const [sel, setSel] = useState({});
  const [more, setMore] = useState(false);
  const pick = (p) => { setSel((x) => ({ ...x, ...p })); setMore(false); };
  const t = useTimeReport(def[0]);
  const reps = useAccountReports(def[0], profs);
  const sessions = useMemo(() => (t?.sessions || []).map((x) => ({ ...x, bay: x.screen ? OUTSIDE : project(x.cwd).name || "other" })), [t]);
  const scope = { ...sel, profile: account };
  const data = useMemo(() => timeCube(sessions, t?.runs || [], scope), [sessions, t, sel, account]);
  const topBays = useMemo(() => timeCube(sessions, [], { profile: account }).bays.map((b) => b.name).filter((b) => b !== OUTSIDE).slice(0, TIME_SERIES), [sessions, account]);
  const spend = useMemo(() => reps && costs(reps, account), [reps, account]);
  const cost = useMemo(() => spend && againstSpend(data.rows, spend, sel.bucket), [spend, data, sel.bucket]);
  const bayHue = useMemo(() => distinctHues(topBays), [topBays]);
  const color = (b) => (bayHue.has(b) ? idColor(bayHue.get(b)) : "var(--um-other)");
  const seriesOf = (b) => (topBays.includes(b) || b === OUTSIDE ? b : OTHER_BAYS);
  const rankOf = (b) => (topBays.includes(b) ? topBays.indexOf(b) : b === OTHER_BAYS ? 8 : 9);
  const bars = useMemo(() => ({ buckets: Object.fromEntries(Object.entries(data.buckets).map(([d, b]) => [d, { ...b, models: Object.entries(b.models).reduce((m, [k, n]) => ({ ...m, [seriesOf(k)]: (m[seriesOf(k)] || 0) + n }), {}) }])) }), [data, topBays]);
  const barsAs = { what: "Time", max: spanMax, axis: (n) => duration(n).replace(/ 00m$/, ""), say: duration, short: duration, least: 30, color, name: (b) => b, rank: (p, q) => rankOf(p) - rankOf(q) };
  const hoursAs = { what: "your time per hour", label: "Your time per hour", least: 60, say: duration, short: duration, note: ", in your selection" };
  const liveBy = new Map(live.map((x) => [x.sessionId, x]));
  const today = new Date().toLocaleDateString("en-CA");
  const days = (t?.days || []).filter((d) => d >= t.first);
  const active = Object.values(data.buckets).filter((b) => b.cost >= 60);
  const perDay = active.length ? active.reduce((a, b) => a + b.cost, 0) / active.length : 0;
  const busiest = Object.entries(data.buckets).sort((a, b) => b[1].cost - a[1].cost)[0];
  const ruleFrom = t?.ruleFrom ? Date.parse(t.ruleFrom) : null;
  const comparable = def[3] && !sel.bucket && t?.days && ruleFrom && ruleFrom <= new Date(`${t.days[0]}T00:00`).getTime() - t.days.length * 864e5;
  const looser = t?.days?.length > 0 && (!ruleFrom || ruleFrom > new Date(`${t.days[0]}T00:00`).getTime()) && data.range > 0;
  const inSessions = data.rows.filter((r) => !r.screen);
  const outside = data.rows.filter((r) => r.screen).reduce((a, r) => a + r.secs, 0);
  const sessSecs = data.total - outside;
  const chips = [sel.bucket && ["bucket", bucketName(sel.bucket)], sel.bay && ["bay", sel.bay]].filter(Boolean);
  const kpis = [
    { l: chips.length ? "In this selection" : "Your time", v: duration(data.total), big: true, s: chips.length ? `of ${duration(data.range)} ${def[2]}`
      : comparable && def[0] === "1" ? `${duration(data.before)} in all ${def[3]}` : comparable ? `${data.total >= data.before ? "+" : "-"}${duration(Math.abs(data.total - data.before))} from ${def[3]} (${duration(data.before)})` : def[2] },
    sel.bucket || def[0] === "1" ? { l: "Outside sessions", v: duration(outside), s: "board, lists, pages, settings" }
      : { l: "Per active day", v: duration(perDay), s: busiest ? `busiest ${bucketName(busiest[0])}, ${duration(busiest[1].cost)}` : "" },
    { l: "Sessions", v: inSessions.length.toLocaleString("en-US"), s: inSessions.length ? `${duration(sessSecs / inSessions.length)} each; the top 5 took ${Math.round((inSessions.slice(0, 5).reduce((a, r) => a + r.secs, 0) / sessSecs) * 100)}%` : "" },
    { l: "Longest stretch", v: data.longest ? duration(data.longest.secs) : "n/a", s: data.longest ? `${whenAt(data.longest.from)}; ${data.stretches.length === 1 ? "1 stretch" : `${data.stretches.length} stretches`}, ${duration(data.typical)} typical, ${(data.switches / (data.counted / 3600)).toFixed(0)} switches an hour` : "nothing timed to the minute yet" },
    { l: "Spend per hour of yours", v: cost ? (sessSecs >= 600 && cost.opened > 0 ? dollars(cost.opened / (sessSecs / 3600)) : "n/a") : html`<i class="skelv" aria-label="Adding up…"></i>`, s: cost ? cost.opened > 0 && `${dollars(cost.opened)} in sessions you had open${cost.unopened && !sel.bay ? `; ${dollars(cost.rest)} in ${cost.unopened} you didn't` : ""}` : "" },
  ];
  const keyOfRow = (r, k) => k === "title" ? (r.title || "").toLowerCase() : k === "last" ? -Date.parse(r.last || 0) : k === "share" ? r.secs : k === "spend" ? (cost ? cost.of(spend[r.sessionId]) : 0) : r[k];
  const ql = v.q.trim().toLowerCase();
  const matched = data.rows.filter((r) => !ql || `${r.title} ${r.bay}`.toLowerCase().includes(ql))
    .sort((a, b) => { const A = keyOfRow(a, v.sort), B = keyOfRow(b, v.sort); return (A > B ? 1 : A < B ? -1 : 0) * v.dir; });
  const shown = more ? matched : matched.slice(0, SHOWN_ROWS);
  const sortBy = (k) => set({ sort: k, dir: v.sort === k ? -v.dir : ["title", "bay", "last"].includes(k) ? 1 : -1 });
  const maxRow = Math.max(1, ...matched.map((r) => r.secs));
  const hourDays = days.filter((d) => t.runsFrom && d >= t.runsFrom).map((d) => ({ day: d, hours: data.hours[d] }));
  const multi = profs.length > 1;
  return html`
    <section class="scrpane usage" aria-label="Time">
      <header class="phd">
        <h1>Time</h1><span class="where">yours, in atc</span>
        <span class="r"><${UsageTabs} at="time" accounts=${multi ? [["", "all"], ...profs.map((p) => [p.name, p.name])] : []} on=${account} onPick=${(a) => { set({ account: a }); setSel({}); }} /></span>
      </header>
      <div class="scroll"><div class="ubody"><div class="uspend">
        <div class="ubar">
          <div class="sh"><h2>Your time</h2><span class="n">${account ? `sessions on the ${account} account` : "with atc in front of you"}</span><${Info} xp=${xp} why=${TIME_HOW} />
            <span class="r"><span class="seg" role="group" aria-label="Range">${TIME_RANGES.map((r) => html`<button aria-pressed=${r[0] === def[0]} aria-label=${r[2]} onClick=${() => { set({ range: r[0] }); setSel({}); }}>${r[1]}</button>`)}</span></span></div>
          ${chips.length > 0 && html`<div class="uchips">
            ${chips.map(([k, l]) => html`<button class="uchip" aria-label=${`Remove ${l}`} onClick=${() => pick({ [k]: null })}>${l}<span aria-hidden="true">×</span></button>`)}
            ${chips.length > 1 && html`<button class="clr" onClick=${() => setSel({})}>Clear all</button>`}</div>`}
        </div>
        ${!t ? html`<${UsageSkel} label="Adding up…" />` : t.failed ? html`<${Err} what="Couldn't read the time log." />`
        : !data.range ? html`<${Empty}>No time counted for ${def[2]}${account ? ` on the ${account} account` : ""} yet.</${Empty}>`
        : html`
          <div class="ukpis">${kpis.map((k) => html`<${Kpi} k=${k} xp=${xp} />`)}</div>
          ${looser && html`<p class="ufloor">${ruleFrom ? `Counted this way since ${whenAt(ruleFrom)}.` : "Nothing is counted this way yet."} Earlier time was counted more loosely (a minute or more after the last input), so it reads higher and is not compared.</p>`}
          ${days.length > 1 && html`<${UsageBars} days=${days} data=${bars} models=${data.bays.filter((b) => topBays.includes(b.name))} sel=${sel} on=${sel.bay} partial=${today} as=${barsAs}
            onPick=${(d) => pick({ bucket: d })} onPickModel=${(b) => pick({ bay: b })} />`}
          ${data.runs.length > 0 ? html`<${DayLine} runs=${data.runs} color=${color} what=${chips.length ? chips.map((c) => c[1]).join(", ") : def[2]} />`
            : sel.bucket && html`<p class="ufloor">Only a total was kept for this day. Times of day are kept ${t.runsFrom ? `from ${dateLabel(dayAt(t.runsFrom))}` : "from now"} on.</p>`}
          <div class="ugrid">
            <section class="sec usess"><div class="sh"><h2>Sessions</h2><span class="n">${chips.length ? chips.map((c) => c[1]).join(", ") : def[2]}</span>
              <span class="r tools"><input class="filt" type="search" placeholder="Filter sessions" aria-label="Filter sessions" value=${v.q} onInput=${(e) => set({ q: e.target.value })} /></span></div>
              <table><thead><tr>${TIME_COLS.map(([k, n, c]) => html`<th class=${c} aria-sort=${v.sort === k ? (v.dir > 0 ? "ascending" : "descending") : "none"}><button class="sort" onClick=${() => sortBy(k)}>${n}</button></th>`)}</tr></thead>
                <tbody>${shown.map((r) => { const ls = liveBy.get(r.sessionId), c = cost ? cost.of(spend[r.sessionId]) : 0; return html`<tr>
                  <td class="t"><span class="uses">${r.screen ? null : ls ? html`<${StateBlock} s=${ls} />` : html`<span class="sb earlier" role="img" aria-label="earlier">E</span>`}
                    ${r.screen ? html`<span class="scn">${r.title}</span>` : html`<a href=${`#/s/${r.sessionId}`} onClick=${(e) => { e.preventDefault(); onOpen(r); }}>${r.title || r.sessionId.slice(0, 8)}</a>`}<span class="bay2">${r.screen ? r.bay : [r.bay, c > 0 && dollars(c)].filter(Boolean).join(", ")}</span></span></td>
                  <td class="c-bay">${r.bay}</td><td class="n c-st">${r.count}</td><td class="n">${duration(r.secs)}</td>
                  <td class="c-sh"><span class="wb" style=${`width:${Math.round((r.secs / maxRow) * 70)}px`}></span></td>
                  <td class="n c-m">${c > 0 ? dollars(c) : ""}</td><td class="n m" title=${stamp(r.last)}>${age(r.last)}</td></tr>`; })}
                  ${!shown.length && html`<tr><td colspan="7" class="none">No session matches${ql ? ` “${v.q}”` : ""}. <button class="clr" onClick=${() => { setSel({}); set({ q: "" }); }}>Clear the filter</button></td></tr>`}</tbody>
                <tfoot><tr><td>${plural(matched.length, "row")}</td><td class="c-bay"></td><td class="c-st"></td><td class="n">${duration(matched.reduce((a, r) => a + r.secs, 0))}</td><td class="c-sh"></td><td class="c-m"></td><td></td></tr></tfoot></table>
              ${matched.length > SHOWN_ROWS && html`<button class="btn umore" onClick=${() => setMore(!more)}>${more ? "Show fewer" : `Show all ${matched.length}`}</button>`}
            </section>
            <div class="ubreak">
              <${PickSection} title="Per bay" rows=${data.bays} on=${sel.bay} onPick=${(b) => pick({ bay: b })} sub=${(r) => plural(r.sessions, r.name === OUTSIDE ? "screen" : "session")} color=${color} amount=${(r) => r.cost} val=${duration} />
              ${data.devices.length > 0 && html`<section class="sec"><div class="sh"><h2>Per device</h2></div><div class="upicks">${data.devices.map((d) => html`<div class="upick flat">
                <span class="nm">${d.name}</span><span class="v">${duration(d.cost)}</span><i class="b" style=${`width:${Math.max(0.5, (d.cost / data.counted) * 100)}%`}></i></div>`)}</div></section>`}
            </div>
          </div>
          <${HoursMap} days=${hourDays} range=${def[0]} filtered=${chips.length > 0} as=${hoursAs} />`}
      </div>
      </div></div>
      <${Explain} at=${xp.at} />
    </section>`;
}

function UsagePage({ limits: mine, live, down, onOpen }) {
  useNow(60000);
  const [v, setV] = useState(() => {
    const x = { sort: "cost", dir: -1, q: "", range: "7d", profile: "", ...stored("atc.usage", {}) };
    return USAGE_COLS.some(([k]) => k === x.sort) ? x : { ...x, sort: "cost", dir: -1 };
  });
  const set = (p) => setV((x) => { const n = { ...x, ...p }; store("atc.usage", n); return n; });
  const [profs, setProfs] = useState([]);
  useEffect(() => { loadProfiles().then(setProfs); }, []);
  const prof = profs.some((p) => p.name === v.profile && !p.default) ? v.profile : "";
  USAGE_PROFILE = prof;
  const [u, setU] = useState(() => WINS[prof] ?? null);
  useEffect(() => { setU(WINS[prof] ?? null); loadWindows(true, prof).then(setU); }, [prof]);
  const [theirs, setTheirs] = useState(null);
  useEffect(() => {
    setTheirs(null);
    if (!prof) return;
    let on = true;
    const load = () => api(`/api/usage/limits${profQ(prof)}`).then((l) => on && setTheirs(l), () => {});
    load();
    const t = setInterval(load, 120000);
    return () => { on = false; clearInterval(t); };
  }, [prof]);
  const limits = prof ? theirs : mine;
  const [sel, setSel] = useState({});
  const [more, setMore] = useState(false);
  const pickSel = (p) => { setSel((x) => ({ ...x, ...p })); setMore(false); };
  const rangeDef = RANGES.find((r) => r[0] === v.range) || RANGES[2];
  const weekFrom = Date.parse(winOf(u, "weekly_all")?.from);
  const span0 = rangeDef[0] !== "week" ? rangeDef[3] : weekFrom ? `since=${Math.floor(weekFrom / 1000)}` : null;
  const rep = useReport(span0 && span0 + profQ(prof, "&"));
  const xp = useExplain();
  const scroll = useRef(), sessionsRef = useRef();
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = stored("atc.usage.scroll", 0); }, [!!rep]);

  const ws = limits?.windows || [];
  const rows = ws.map((w) => limitRow(w, winOf(u, w.key)));
  const hit = rows.find((r) => r.hit);
  const isDown = (h) => down.some((p) => p.name === h);
  const noLimits = prof ? `The ${prof} account reports no plan limits; an account billed per token has none` : `Limits are not available here${limits?.error ? `: ${limits.error}` : ""}`;
  const status = !limits ? "Checking the limits…" : !ws.length ? noLimits
    : hit ? `${hit.name} runs out ${hit.when} at this rate, ${hit.left} before the reset` : "Every limit lasts to its reset at this rate";
  const src = limits && (limits.source === "cached" || limits.source === "statusline") ? `read ${agoLong(limits.fetchedAt)}` : "";

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
  const span = rep?.first && !["24h", "week", "7d"].includes(rangeDef[0]) && (trimmed || rangeDef[0] === "all");

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
      s: [wk(data.total), filtered ? `of ${dollars(data.range)}`
        : delta != null ? `${delta >= 0 ? "+" : "-"}${dollars(Math.abs(data.total - rep.previous))} from the ${rangeDef[4] || rangeDef[2].replace("the last", "previous")} (${dollars(rep.previous)})`
        : rangeDef[2]].filter(Boolean).join(", "), big: true, why: `What the transcripts in ${rangeDef[2]} would cost at API list prices.${weekRate() ? ` ${WK_SCALE()}` : ""}` },
    sel.bucket
      ? { l: `Against the average ${unit}`, v: perUnit > 0 ? `${(data.total / perUnit).toFixed(1)}×` : "0", s: `average ${withWk(perUnit)} a ${unit}` }
      : { l: `Per active ${unit}`, why: `The total divided by the ${unit}s that spent anything.`, v: dollars(perUnit), s: [wk(perUnit), busiest && busiest[1].cost > 0 && `busiest ${bucketName(busiest[0])}, ${dollars(busiest[1].cost)}`].filter(Boolean).join(", ") },
    { l: "Sessions", why: "Sessions with any spend in this range.", v: data.rows.length.toLocaleString("en-US"), s: data.rows.length > 5 ? `the top 5 took ${withWk(top5)}` : data.rows.length ? `${withWk(data.total / data.rows.length)} each` : "" },
    { l: "Replies", why: "Replies Claude wrote in this range, and what each cost on average.", v: data.msgs.toLocaleString("en-US"), s: data.msgs ? `${dollars(data.total / data.msgs)} each` : "" },
    { l: "Tokens", why: "Input, output and cache tokens together, and the cost per million of them.", v: tokens(data.tokens), s: data.tokens ? `${dollars(data.total / (data.tokens / 1e6))} a million` : "" },
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
      <header class="phd">
        <h1>Usage</h1><span class="where" title=${status}>${[`Claude Code${MULTI ? " on every host" : ""}${limits?.plan ? `, ${limits.plan} plan` : ""}`, src && `limits ${src}`].filter(Boolean).join(" · ")}</span>
        <span class="r"><${UsageTabs} at="usage" accounts=${profs.length > 1 ? profs.map((p) => [p.default ? "" : p.name, p.name]) : []} on=${prof} onPick=${(p) => { set({ profile: p }); setSel({}); }} /></span>
      </header>
      <div class="scroll" ref=${scroll} onScroll=${(e) => store("atc.usage.scroll", e.currentTarget.scrollTop)}>
        <div class="ubody">
          <section class="sec" aria-labelledby="u-lim">
            <div class="sh"><h2 id="u-lim">Limits</h2>${hit && html`<span class="n hitn">${status}</span>`}${limits && ws.length > 0 && html`<${Info} xp=${xp} why=${`Read from Claude Code's ${limits.source === "statusline" ? "status line" : "last check"}${MULTI ? " on every host" : ""}. Each number explains itself: ${touch ? "tap" : "point at"} it.`} />`}</div>
            ${!ws.length && html`<p class="none">${limits ? `${noLimits}.` : "Checking…"}</p>`}
            ${rows.map((r) => html`
              <div class="lim ${r.hit ? "hit" : ""}">
                <div class="nm"><b>${r.name}</b><span>${r.reset}${r.spent > 0 ? `, ${dollars(r.spent)} so far` : ""}</span></div>
                <div class="gauge" role="img" aria-label=${`${Math.round(r.used)}% used${r.pace != null ? `; even pace ${Math.round(r.pace)}%` : ""}${r.proj != null ? `; ${r.hit ? "projected to run out" : `about ${Math.round(r.proj)}% at the reset`}` : ""}`}>
                  <span class="tr"></span><span class="used" style=${`width:${r.used}%`}></span>
                  ${r.proj > r.used && html`<span class="prj" style=${`left:${r.used}%;width:${r.proj - r.used}%`}></span>`}
                  <span class="ticks"></span>
                  ${r.pace != null && html`<span class="pace" style=${`left:calc(${r.pace}% - 1px)`} data-l=${`pace ${Math.round(r.pace)}%`}></span>`}
                </div>
                <div class="pct"><${X} xp=${xp} why=${r.why.used} label=${html`${Math.round(r.w.percent)}<small>%</small>`} /><${Info} xp=${xp} why=${r.why.pace || r.why.used} /></div>
                <div class="say"><${X} xp=${xp} why=${r.why.proj} label=${r.say} /></div>
              </div>`)}
            ${rows.length > 0 && html`<div class="legend"><span><i class="u"></i>used</span><span><i class="p"></i>at this rate, by the reset</span><span><i class="t"></i>even pace: where you would be if it lasted exactly</span></div>`}
          </section>
          <div class="uspend ${rep?.loading ? "loading" : ""}">
            <div class="ubar">
              <div class="sh"><h2>Spend</h2><span class="n">${prof ? `the ${prof} account, at API prices` : "at API prices"}</span><${Info} xp=${xp} why=${`${prof ? `Dollar figures are estimated from the ${prof} account's transcripts at Claude API list prices. If that account is billed per token, this is close to what it pays.` : ESTIMATE()} ${WK_NOTE()}`} />
                <span class="r"><span class="seg" role="group" aria-label="Range">${RANGES.map((r) => html`<button aria-pressed=${r[0] === rangeDef[0]} aria-label=${r[2]} onClick=${() => { set({ range: r[0] }); pickSel({ bucket: null }); }}>${r[1]}</button>`)}</span></span></div>
              ${chips.length > 0 && html`<div class="uchips">
                ${chips.map(([k, l]) => html`<button class="uchip" aria-label=${`Remove ${l}`} onClick=${() => pickSel({ [k]: null })}>${l}<span aria-hidden="true">×</span></button>`)}
                ${chips.length > 1 && html`<button class="clr" onClick=${() => setSel({})}>Clear all</button>`}</div>`}
            </div>
            ${span && html`<p class="ufloor">Transcripts go back to ${dateLabel(dayAt(rep.first))}. Claude Code deletes older ones, so there is nothing further to add up.</p>`}
            ${!rep && rangeDef[0] === "week" && u && !weekFrom ? html`<p class="none">The weekly limit's reset is not known here, so there is no week to add up.</p>`
            : !rep ? html`<${UsageSkel} label="Adding up the transcripts…" />` : rep.failed ? html`<${Err} what="Couldn't add up the transcripts." />`
            : empty && rangeDef[0] === "all" ? html`
              <div class="uempty"><h2>No usage yet</h2><p>atc reads usage from Claude Code once a session has run. Spend per day, bay, model and session fill in from the first session on.</p>
                <button class="btn primary" onClick=${() => NEW_SESSION()}>New session</button></div>`
            : empty ? html`<${Empty}>No sessions ran in ${rangeDef[2]}.</${Empty}>`
            : html`
            <div class="ukpis">${kpis.map((k) => html`<${Kpi} k=${k} xp=${xp} />`)}</div>
            <${UsageBars} days=${dayKeys} data=${data} models=${data.models} sel=${sel} hourly=${hourly} partial=${partial} onPick=${pickBucket} onPickModel=${(m) => pickSel({ model: m })} />
            <div class="ugrid">
              <section class="sec usess" ref=${sessionsRef}><div class="sh"><h2>Biggest sessions</h2><span class="n">${sliceName}</span>
                <span class="r tools"><input class="filt" type="search" placeholder="Filter sessions" aria-label="Filter sessions" value=${v.q} onInput=${(e) => set({ q: e.target.value })} /></span></div>
                <table><thead><tr>${USAGE_COLS.map(([k, n, c]) => html`<th class=${c} aria-sort=${v.sort === k ? (v.dir > 0 ? "ascending" : "descending") : "none"}><button class="sort" onClick=${() => sortBy(k)}>${n}</button></th>`)}</tr></thead>
                  <tbody>${shown.map((r) => { const ls = liveBy.get(r.sessionId); return html`<tr>
                    <td class="t"><span class="uses">${ls ? html`<${StateBlock} s=${ls} />` : html`<span class="sb earlier" role="img" aria-label="earlier">E</span>`}
                      <a href=${`#/s/${r.sessionId}`} onClick=${(e) => { e.preventDefault(); onOpen(r); }}>${r.title || r.sessionId.slice(0, 8)}</a><span class="bay2">${r.bay}${r.model ? `, ${modelName(r.model)}` : ""}</span></span></td>
                    <td class="c-bay">${r.bay}</td><td class="m c-m">${r.model ? modelName(r.model) : ""}</td><td class="n c-st">${r.msgs.toLocaleString("en-US")}</td>
                    <td class="n">${dollars(r.cost)}<small class="wk">${wk(r.cost)}</small></td>
                    <td class="c-sh"><span class="wb" style=${`width:${Math.round((r.cost / maxRow) * 70)}%`}></span></td>
                    <td class="n m">${isDown(r.host) ? html`<span class="stale" title=${`${r.host} is unreachable; this is what it used until then`}>${age(r.last)}</span>` : age(r.last)}</td></tr>`; })}
                    ${!shown.length && html`<tr><td colspan="7" class="none">No session matches${ql ? ` “${v.q}”` : ""}. <button class="clr" onClick=${() => { setSel({}); set({ q: "" }); }}>Clear the filter</button></td></tr>`}</tbody>
                  <tfoot><tr><td>${plural(matched.length, "session")}</td><td class="c-bay"></td><td class="c-m"></td><td class="n c-st">${sumShown("msgs").toLocaleString("en-US")}</td><td class="n">${dollars(sumShown("cost"))}<small class="wk">${wk(sumShown("cost"))}</small></td><td class="c-sh"></td><td></td></tr></tfoot></table>
                ${matched.length > SHOWN_ROWS && html`<button class="btn umore" onClick=${() => setMore(!more)}>${more ? "Show fewer" : `Show all ${matched.length}`}</button>`}
              </section>
              <div class="ubreak">
                <${PickSection} title="Per bay" rows=${data.bays} on=${sel.bay} onPick=${(b) => pickThenShow({ bay: b })} sub=${(r) => plural(r.sessions, "session")} />
                <${PickSection} title="Per model" rows=${data.models} on=${sel.model} onPick=${(m) => pickThenShow({ model: m })} name=${(r) => modelName(r.name)} color=${modelColor} />
                ${(data.hosts.length > 1 || sel.host) && html`<${PickSection} title="Per host" rows=${data.hosts} on=${sel.host} onPick=${(h) => pickThenShow({ host: h })} sub=${(r) => plural(r.sessions, "session")} />`}
                <section class="sec"><div class="sh"><h2>What it paid for</h2></div>
                  <div class="upicks">${KINDS.map((k, i) => [k, data.kinds[i]]).sort((a, b) => b[1] - a[1]).map(([k, c]) => html`<div class="upick flat">
                    <span class="nm">${k}</span><span class="v">${dollars(c)}<small>${wk(c)}</small></span>
                    <i class="b" style=${`width:${data.total > 0 ? Math.max(0.5, (c / data.total) * 100) : 0}%`}></i></div>`)}</div></section>
              </div>
            </div>
            <${HoursMap} days=${shownDays} hourly=${hourly} range=${rangeDef[0]} filtered=${filtered} />`}
          </div>
        </div>
      </div>
      <${Explain} at=${xp.at} />
    </section>`;
}

function SessionUsage({ s, use, onClose, agent }) {
  const sub = use?.subagents;
  const convs = use?.conversations || [];
  const what = agent ? "agent" : "session";
  const day = dateLabel;
  const sh = shares(use);
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
    ["Subagents", sub.count ? `${sub.count} · ${tokens(sub.total)} tokens · ${withWk(sub.cost, usd)}` : "none"],
    ["Wall time", use.start ? `${duration(use.wallSeconds)}, since ${stamp(use.start)}` : "n/a"],
  ];
  return html`
    <${Sheet} cls="usage" title="Usage" sub=${s.profile ? `${s.title} · ${s.profile} account` : s.title} onClose=${onClose}>
      ${!use ? html`<p class="note">Reading the transcript${agent ? "s" : ""}…</p>` : use.failed ? html`<p class="note">Couldn't read this ${what}'s usage.</p>` : html`
        <div class="tiles">
          ${sh.map((x) => html`<div>
            <span class="n">${usd(x.cost)}</span>
            <span class="l">in this ${x.name}${wk(x.cost) ? ` · ${wk(x.cost)}` : ""}</span>
            <span class="l faint">${x.name === "week" ? `limit at ${Math.round(x.w.percent)}%, resets ${stamp(x.w.resetsAt)}` : `limit at ${Math.round(x.w.percent)}%, resets in ${duration((Date.parse(x.w.resetsAt) - Date.now()) / 1000)}`}</span>
          </div>`)}
          <div>
            <span class="n">${usd(use.cost)}</span>
            <span class="l">${agent ? `all ${convs.length} conversation${convs.length === 1 ? "" : "s"}` : "whole session"}${wk(use.cost) ? ` · ${wk(use.cost)}` : ""}</span>
            <span class="l faint">${tokens(use.total)} tokens</span>
          </div>
          <div>
            <span class="n">${duration(use.activeSeconds)}</span>
            <span class="l">${s.harness || "Claude"} working</span>
            ${use.activeSeconds > 60 && use.cost > 0 && html`<span class="l faint">${usd(use.cost / (use.activeSeconds / 3600))} per working hour</span>`}
          </div>
        </div>
        ${use.local?.length > 0 && html`<p class="quiet">${use.local.join(", ")} is not Claude: its part costs nothing and doesn't count toward your plan.</p>`}
        ${convs.length > 1 && html`
          <h4>Conversations</h4>
          <${ShareRows} onPick=${(r) => { onClose(); go(r.id); }}
            rows=${convs.map((c) => ({ id: c.sessionId, label: c.title || "Untitled", cost: c.cost,
              sub: [c.start && (c.end && day(c.end) !== day(c.start) ? `${day(c.start)} to ${day(c.end)}` : day(c.start)), `${c.turns} turns`, `${tokens(c.total)} tokens`, c.profile && `${c.profile} account`].filter(Boolean).join(" · ") }))} />`}
        ${kinds && use.cost > 0 && html`
          <h4>Where the cost goes</h4>
          <${ShareRows} rows=${kinds} />`}
        ${use.models?.length > 0 && html`
          <h4>Models</h4>
          <${ShareRows}
            rows=${use.models.map((m) => ({ label: modelName(m.model), sub: `${tokens(m.total)} tokens · ${m.messages} replies`, cost: m.cost }))} />`}
        <h4>Activity</h4>
        <dl class="facts">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        ${!agent && s.agent && AGENT_INFO[s.agent] && html`<button class="btn" onClick=${() => { onClose(); openAgent(s.agent, "usage"); }}>All of ${agentLabel(AGENT_INFO[s.agent])}'s conversations</button>`}
        <p class="note">${sh.length ? `The week and 5-hour tiles count only this ${what}'s spend${convs.some((c) => c.profile) ? " on your default account" : ""} since that window opened. ` : ""}${WK_NOTE()} ${s.profile
          ? `Dollar figures are estimated from the transcript at Claude API list prices${use.pricesAsOf ? ` (${use.pricesAsOf})` : ""}. This ${what} runs on the ${s.profile} account; if that account is billed per token, this is close to what it pays.`
          : ESTIMATE(use.pricesAsOf)}${use.unpriced?.length ? ` No price known for ${use.unpriced.join(", ")}, so it counts as $0.` : ""} Working time adds up the gaps between messages in each turn, at most 10 minutes per gap.</p>`}
    <//>`;
}

const serverURL = (s, port) => `http://${s.host || location.hostname}:${port}/`;

function openOut(url) {
  const abs = new URL(url, location.href).href;
  if (!/^https?:/.test(abs)) return;
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

const agoLong = (at) => { const a = age(at); return a === "now" ? "just now" : a ? `${a} ago` : ""; };
const KIND_LABEL = { browser: "Browser", table: "Table", image: "Image", html: "Page", markdown: "Notes", pdf: "PDF", video: "Video", audio: "Audio", text: "File" };
const baseName = (p) => p.split("/").pop();
const dirName = (p) => tilde(p.slice(0, p.lastIndexOf("/")) || "/");

function useTurnIndex(s) {
  const [turns, setTurns] = useState(null);
  useEffect(() => {
    let on = true;
    api(`/api/sessions/${s.sessionId}/turns`).then((r) => on && setTurns(r.turns || []), () => on && setTurns((t) => t || []));
    return () => { on = false; };
  }, [s.sessionId, s.updated]);
  return turns;
}

const fileMeta = (f) => [KIND_LABEL[f.kind], f.size && fileSize(f.size)].filter(Boolean).join(" · ");
function Outputs({ s, data, pages = [], open: openPage, sel, view }) {
  const turns = useTurnIndex(s);
  if (!data) return html`<section class="outs"><h3>Outputs</h3><p class="empty">Looking through this session…</p></section>`;
  const made = data.files.filter((f) => f.kind !== "text"), code = data.files.filter((f) => f.kind === "text"), files = [...made, ...code];
  const badges = (turns || []).flatMap((t) => t.badges || []);
  const commits = [...new Map(badges.filter((b) => b.kind === "commit" && b.ref).map((b) => [b.ref, b])).values()].reverse();
  const shipped = [...new Set(badges.filter((b) => (b.kind === "push" || b.kind === "deploy") && b.ok).map((b) => b.kind === "deploy" ? `Deployed ${b.ref || b.text}` : b.text))];
  const n = pages.length + data.servers.length + files.length + data.links.length + commits.length;
  const open = (f) => view({ list: files, at: files.indexOf(f) });
  const row = ({ key, icon, name, sub, right, on, run, mono }) => html`<li key=${key}><button class="orow ${on ? "on" : ""}" aria-current=${on ? "true" : null} onClick=${run}>
    <span class="oi" aria-hidden="true">${ICON[icon]}</span><span class="on"><span class=${`onm ${mono ? "mono" : ""}`}>${name}</span>${sub && html`<span class="osub">${sub}</span>`}</span>${right && html`<span class="ort">${right}</span>`}</button></li>`;
  const group = (title, list) => list.length > 0 && html`<h4>${title}</h4><ul class="olist">${list.map(row)}</ul>`;
  return html`<section class="outs"><h3>Outputs${n > 0 && html`<span class="n">${n}</span>`}</h3>
    ${!n && html`<p class="empty">${data.failed ? "Couldn't read this session's outputs." : "Nothing yet. Pages it shows you, files it writes, servers it starts and commits it makes show up here."}</p>`}
    ${group("Pages", pages.map((p) => ({ key: pkey(p), icon: "page", name: pageTitle(p), right: age(p.updated || p.shown), run: () => openPage(p.name) })))}
    ${group("Running", data.servers.map((v) => ({ key: v.url, icon: "play", name: v.url.replace(/^https?:\/\//, "").replace(/\/$/, ""), mono: true, sub: v.localOnly ? `Listens on localhost only, so it opens on ${s.host || "that machine"} itself` : "Started by this session", run: () => openOut(v.url) })))}
    ${group("Files", made.map((f) => ({ key: f.path, icon: "file", name: baseName(f.path), mono: true, sub: fileMeta(f), right: age(f.at), on: sel?.list?.[sel.at] === f || sel?.list?.[sel.at]?.path === f.path, run: () => open(f) })))}
    ${group("Links", data.links.map((l) => { const u = new URL(l.url); return { key: l.url, icon: "out", name: u.host, sub: (u.pathname + u.search).replace(/^\/$/, ""), right: age(l.at), run: () => openOut(l.url) }; }))}
    ${group("Commits", commits.map((c) => ({ key: c.ref, icon: "branch", name: c.text || c.ref, right: html`<span class="mono">${c.ref.slice(0, 7)}</span>`, on: sel?.sha === c.ref, run: () => view({ sha: c.ref }) })))}
    ${shipped.length > 0 && html`<p class="oship">${shipped.join(" · ")}</p>`}
    ${group("Code it touched", code.map((f) => ({ key: f.path, icon: "file", name: html`<span class="mono">${baseName(f.path)}</span> <span class="osub in">${dirName(f.path)}</span>`, right: f.op, on: sel?.list?.[sel.at]?.path === f.path, run: () => open(f) })))}
  </section>`;
}

function OutView({ s, v, set, say, inline }) {
  const [repo, setRepo] = useState("");
  useEffect(() => { if (v.sha) api(`/api/sessions/${s.sessionId}/ref/repo`).then((r) => setRepo(r.repo || ""), () => {}); }, [s.sessionId, !!v.sha]);
  const close = () => set(null);
  if (v.sha) return html`<${CommitView} key=${v.sha} s=${s} sha=${v.sha} repo=${repo} say=${say} open=${(sha) => set({ sha })} onClose=${close} inline=${inline} />`;
  return html`<${Viewer} list=${v.list} at=${v.at} setAt=${(at) => set({ ...v, at })} onClose=${close} inline=${inline} />`;
}

function FilePeek({ f, ext }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch(f.url, { headers: { Range: "bytes=0-2047" } }).then((r) => (r.ok ? r.text() : "")).then(setText, () => setText(""));
  }, [f.url]);
  return text ? html`<${Peek} kind=${f.kind} text=${text} tsv=${f.path.endsWith(".tsv")} />` : html`<span class="ext">${ext}</span>`;
}

function Peek({ kind, text, tsv }) {
  if (kind === "markdown") return html`<div class="pvtext md" dangerouslySetInnerHTML=${{ __html: md(text) }}></div>`;
  if (kind !== "table") return html`<pre class="pvtext">${text}</pre>`;
  const rows = parseRows(text, tsv ? "\t" : ",").slice(0, 12);
  return html`<div class="pvtext"><table class="data">${rows.map((r, i) => html`<tr>${r.slice(0, 6).map((c) => (i ? html`<td>${c}</td>` : html`<th>${c}</th>`))}</tr>`)}</table></div>`;
}

const ClipPath = ({ p }) => html`<span class="vpath" title=${tilde(p)}><bdi>${tilde(p)}</bdi></span>`;
function Viewer({ list, at, setAt, onClose, inline }) {
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
  const meta = [KIND_LABEL[f.kind], f.size && fileSize(f.size), f.at && `${f.op || "written"} ${agoLong(f.at)}`].filter(Boolean).join(" · ");
  return html`
    <div class="viewer ${inline ? "inline" : ""}" role=${inline ? "region" : "dialog"} aria-label=${baseName(f.path)}>
      <header>
        <button class="btn quiet icon" onClick=${onClose} aria-label="Close" title=${tip("close", "Close")}>${ICON.x}</button>
        <${ClipPath} p=${f.path} />
        ${list.length > 1 && html`<span class="vn">${at + 1} of ${list.length}</span><button class="btn quiet icon" disabled=${at === 0} onClick=${() => setAt(at - 1)} aria-label="Previous" title=${tip("viewer", "Previous")}>${ICON.prev}</button>
        <button class="btn quiet icon" disabled=${at === list.length - 1} onClick=${() => setAt(at + 1)} aria-label="Next" title=${tip("viewer", "Next")}>${ICON.next}</button>`}
        <button class="btn quiet" onClick=${() => openOut(f.url)}>${ICON.out}${APP ? "Open outside" : "New tab"}</button>
      </header>
      ${meta && html`<div class="vmeta"><span>${meta}</span>${!touch && html`<span class="vk">esc closes${list.length > 1 ? ", ← → step through outputs" : ""}</span>`}</div>`}
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
        : html`<${CodeFile} text=${text.t} path=${f.path} line=${f.line} end=${f.end} />`}
    </div>`;
}

const MOST_HIGHLIGHTED = 300 << 10;
function CodeFile({ text, path, line, end }) {
  const box = useRef(null), lines = useMemo(() => text.replace(/\n$/, "").split("\n").length, [text]);
  const body = useMemo(() => {
    const lang = baseName(path).split(".").pop().toLowerCase();
    return text.length < MOST_HIGHLIGHTED && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text);
  }, [text, path]);
  useEffect(() => {
    const el = box.current?.querySelector(".hit");
    if (el) el.scrollIntoView({ block: "center" });
  }, [body, line]);
  const span = line ? Math.max(1, (end || line) - line + 1) : 0;
  return html`<div class="fcode" ref=${box}>
    <div class="gut" aria-hidden="true">${Array.from({ length: lines }, (_, i) => `${i + 1}\n`).join("")}</div>
    <div class="src">${span > 0 && html`<i class="hit" style=${`top: calc(${line - 1} * var(--fl)); height: calc(${span} * var(--fl))`}></i>`}<pre dangerouslySetInnerHTML=${{ __html: body }}></pre></div>
  </div>`;
}

function CommitView({ s, sha, span, repo, say, open, onClose, inline }) {
  const [c, setC] = useState(null);
  useEffect(() => {
    let on = true;
    api(span ? `/api/sessions/${s.sessionId}/ref/range?range=${span}` : `/api/sessions/${s.sessionId}/ref/commit?sha=${sha}`).then((x) => on && setC(x), (e) => { if (on) { say(e.message); onClose(); } });
    const k = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    addEventListener("keydown", k, true);
    return () => { on = false; removeEventListener("keydown", k, true); };
  }, [sha, span]);
  const patch = useMemo(() => (c?.patch ? (diffBlock("diff", c.patch, paintLine) || `<pre><code>${esc(c.patch)}</code></pre>`).replace('class="mdiff', 'class="open mdiff') : ""), [c]);
  const list = c?.commits, title = span ? (list ? `${plural(list.length, "commit")} pushed` : span) : c ? c.subject : sha;
  const sub = span ? (list?.length ? span : c ? "No new commits, only a move" : "Reading the push…") : c ? `${sha}, ${c.author}, ${stamp(c.date)}` : "Reading the commit…";
  const web = repo && (span ? `${repo}/compare/${span.replace("...", "..").replace("..", "...")}` : `${repo}/commit/${c?.sha || sha}`);
  return html`<div class="viewer commitv ${inline ? "inline" : ""}" role=${inline ? "region" : "dialog"} aria-label=${title}>
    <header>
      <button class="btn quiet icon" onClick=${onClose} aria-label="Close" title=${tip("close", "Close")}>${ICON.x}</button>
      <div class="who"><div class="n">${title}</div><div class="d">${sub}</div></div>
      ${web && html`<button class="btn quiet" onClick=${() => openOut(web)}>${ICON.out}GitHub</button>`}
    </header>
    <div class="fbody"><article class="md">
      ${c?.body && html`<p class="cbody">${c.body}</p>`}
      ${list?.length > 0 && html`<ul class="clist">${list.map((x) => html`<li><button onClick=${() => open(x.sha)}><code>${x.sha}</code><span class="l">${x.subject}</span><span class="w">${x.author}</span></button></li>`)}</ul>`}
      ${patch ? html`<div dangerouslySetInnerHTML=${{ __html: patch }}></div>` : c && html`<p class="empty">This commit changes no files.</p>`}
      ${c?.truncated && html`<p class="empty">The rest of this commit is too long to show here.</p>`}
    </article></div>
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
const PIN = "+pinned";
const isPin = (p) => p?.session === PIN;
const pinOf = (p) => (isPin(p) ? p.name : p?.pin || null);
const ownerRef = (p, s) => (p.session.startsWith("@") || isPin(p) ? p.session : linkSlug(s?.title || p.of) || p.session);
const idRef = (r) => r === PIN || r.startsWith("@") || r.startsWith("+proj-") || /^[0-9a-f]{8}(-[0-9a-f-]*)?$/.test(r);
const splitRef = (r) => { const i = (r || "").indexOf("#"); return i < 0 ? [r, null] : [r.slice(0, i), r.slice(i + 1)]; };
const pageRef = (p) => (p.at ? `${p.name}#${p.at}` : p.name);
let AT_SEQ = 0;
const atOf = (ref) => { const [name, id] = splitRef(ref); return id ? { name, id, seq: ++AT_SEQ } : null; };
const atcRoute = (href) => { const u = new URL(href, location.href); return u.origin === location.origin && u.pathname === "/" && u.hash ? u.hash : null; };
const routePage = () => { const m = location.hash.match(/^#\/(?:s|agents)\/[^/]+\/p\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; };
let LAST_KEY = 0;
addEventListener("keydown", () => { LAST_KEY = Date.now(); }, true);
let TYPING_IN = null, TAB_AT = 0;
addEventListener("focusin", (e) => { TYPING_IN = typingIn(e.target) ? e.target : null; }, true);
addEventListener("keydown", (e) => { if (e.key === "Tab") TAB_AT = Date.now(); }, true);
let PRESSED = { at: 0, by: null };
addEventListener("message", (e) => { if (e.data?.atc === 1 && e.data.op === "press") PRESSED = { at: Date.now(), by: e.source }; });
addEventListener("blur", () => {
  const back = TYPING_IN;
  setTimeout(() => {
    const f = document.activeElement, pressed = PRESSED.by === f?.contentWindow && Date.now() - PRESSED.at < 1000;
    if (f?.tagName !== "IFRAME" || !f.sandbox?.contains("allow-scripts") || pressed || Date.now() - TAB_AT < 1000 || !back?.isConnected) return;
    back.focus({ preventScroll: true });
  }, 150);
});

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

const askTakeDown = (p) => ask({ title: `Take down “${pageTitle(p)}”?`, body: p.pin ? "It leaves this session's pages and stays pinned." : "It leaves atc's pages. The file stays where it is.",
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
  const [loaded, setLoaded] = useState(false);
  const [stuck, setStuck] = useState(false);
  const frames = useRef({});
  const scroll = useRef(0);
  useEffect(() => { if (src !== cur) setNext(src); }, [src]);
  useEffect(() => {
    if (loaded) return setStuck(false);
    const t = setTimeout(() => setStuck(true), 15000);
    return () => clearTimeout(t);
  }, [loaded]);
  useEffect(() => {
    const base = `/api/sessions/${p.session}/pages/${encodeURIComponent(p.name)}`, q = hostQ(p.host, HERE);
    const ops = {
      "state.get": () => api(`${base}/state${q}`),
      "state.set": (v) => api(`${base}/state${q}`, { method: "PUT", body: v }).then(() => null),
      run: (a) => api(`${base}/run${q}`, { method: "POST", body: a }),
      copy: (t) => { copyText(t); say(t.length < 60 ? `Copied “${t}”.` : "Copied."); },
      copyImage: (u) => (APP?.copyImage ? APP.copyImage(u) : copyImage(u).then(() => say("Image copied."))),
      open: (u) => { const h = atcRoute(u); h ? (location.hash = h) : openOut(u); },
      send: (t) => ask({ title: `Send this to the session, as you, from “${pageTitle(p)}”?`, body: t, ok: "Send", busy: "Sending…", run: () => onSend(t) })
        .then((r) => { if (!r) throw new Error("not sent"); return r; }),
      key: (k) => { document.body.dispatchEvent(new KeyboardEvent("keydown", { ...k, bubbles: true, cancelable: true })); },
    };
    const f = (e) => {
      const m = e.data;
      if (!m || m.atc !== 1 || !Object.values(frames.current).some((w) => w && w.contentWindow === e.source)) return;
      if (m.op === "hello") {
        setLoaded(true);
        e.source.postMessage({ atc: 1, op: "changes", on: !!changesRef.current }, "*");
        return e.source.postMessage({ atc: 1, op: "scroll", y: scroll.current }, "*");
      }
      if (m.op === "at") { scroll.current = m.arg; return; }
      if (m.op === "press" || m.op === "active") return;
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
    onLoad=${hidden ? () => { delete frames.current[cur]; setCur(u); setNext(null); setLoaded(true); } : () => setLoaded(true)}></iframe>`;
  return html`<div class="pframe">${frame(cur, false)}${next && frame(next, true)}
    ${stuck && html`<div class="pstuck" role="status">
      <span>This page hasn't loaded in this tab. A debugger or browser automation attached to the tab can hold it back; a new tab loads it.</span>
      <button class="btn sm" onClick=${() => openOut(`/${aloneLink(p.session, p.name)}`)}>Open in a new tab</button>
    </div>`}</div>`;
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
  const [driving, setDriving] = useState(false);
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
    <div class="brview">
      ${tabs.length > 1 && html`<div class="btabs" role="tablist">${tabs.map((t) => html`<button role="tab" aria-selected=${t === tab} class="ptab ${t === tab ? "on" : ""}" title=${t.url} onClick=${() => setCur(t.id)}><span>${t.title || t.url || "New tab"}</span></button>`)}</div>`}
      <form class="bbar" onSubmit=${go}>
        <button type="button" class="icon" title="Back" aria-label="Back" onClick=${() => nav(-1)}>${ICON.back}</button>
        <button type="button" class="icon wide" title="Forward" aria-label="Forward" onClick=${() => nav(1)}>${ICON.fwd}</button>
        <button type="button" class="icon" title="Reload" aria-label="Reload" onClick=${() => send("Page.reload")}>${ICON.refresh}</button>
        <input class="burl" value=${typed ?? url} onInput=${(e) => setTyped(e.target.value)} onFocus=${(e) => e.target.select()} onBlur=${() => setTyped(null)} spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-label="Address" />
        <button type="button" class="icon" aria-pressed=${driving} title=${driving ? "Release the page" : "Type into the page"} aria-label="Keyboard" onMouseDown=${(e) => e.preventDefault()} onClick=${() => (driving ? keys.current?.blur() : keys.current?.focus())}>${ICON.keys}</button>
      </form>
      ${driving && html`<div class="bdrive" role="status">${ICON.user}<span><b>You are driving.</b> Your clicks and keys go to the page.</span><button class="btn primary" onMouseDown=${(e) => e.preventDefault()} onClick=${() => keys.current?.blur()}>Release</button></div>`}
      <div class="bstage ${driving ? "driving" : ""}" ref=${stage}>
        ${frame
          ? html`<img ref=${img} src=${`data:image/jpeg;base64,${frame.data}`} alt=${info?.title || tab.title} draggable="false"
              onMouseDown=${(e) => e.preventDefault()} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${() => (drag.current = null)} onWheel=${wheel} onContextMenu=${(e) => e.preventDefault()} />`
          : html`<p class="sub">${gone ? "This tab is closed." : "Connecting to the tab…"}</p>`}
        <textarea ref=${keys} class="bkeys" aria-label="Type into the page" autocapitalize="off" autocomplete="off" spellcheck="false" onKeyDown=${(e) => (e.key === "Escape" && !e.shiftKey ? e.target.blur() : key(e))} onInput=${text} onFocus=${() => setDriving(true)} onBlur=${() => setDriving(false)}></textarea>
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

function PagePane({ s, list, cur, at, pick, split, setSplit, onClose, onZen, say, alone }) {
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
  if (!p) return html`<div class="ppane"><div class="fbody"><p class="empty">No pages in this session yet.</p></div></div>`;
  const full = () => APP ? (location.hash = aloneLink(ownerRef(p, s), p.name)) : openOut(`/${aloneLink(ownerRef(p, s), p.name)}`);
  const bay = bayOf(s) || (s.cwd && projectOf(s)) || null;
  return html`
    <div class="ppane" tabindex="-1">
      <div class="pbar">
        ${list.length > 1
          ? html`<div class="pgtabs" role="tablist" ref=${tabs}>
              ${list.map((x) => html`<button role="tab" aria-selected=${x === p} class="pgtab ${x === p ? "on" : ""} ${x.gone ? "gone" : ""}" title=${`${pageTitle(x)}\n${pageInfo(x)}`} onClick=${() => pick(x.name)}>
                ${x !== p && pageFresh(x) && html`<i class="pgdot"></i>`}<span>${pageTitle(x)}</span></button>`)}
            </div>`
          : html`<span class="pgone"><b title=${pageTitle(p)}>${pageTitle(p)}</b></span>`}
        <span class="pupd" title=${tilde(p.path)}>${p.gone ? "gone" : `updated ${age(pageAt(p))}`}</span>
        ${setSplit && html`<button class="btn quiet icon" aria-pressed=${!split} aria-label=${split ? "Page only" : "Side by side"} title=${split ? "Page only: the page fills the session" : "Side by side with the transcript"} onClick=${() => setSplit(!split)}>${ICON.zen}</button>`}
        ${p.kind !== "browser" && html`<button class="btn quiet icon" aria-label="Open in Pages" onClick=${() => (location.hash = pagesHash(bay, p.session, p.name))} title="Open in Pages">${ICON.out}</button>
        <${Menu} cls="btn quiet icon" aria="Page actions" title="More" width=${220} items=${[
          onZen && { label: "Zen", icon: "zen", key: "zen", run: onZen },
          { label: "Reload", icon: "refresh", run: () => setNonce((n) => n + 1) },
          !alone && { label: "Open full page", run: full },
          { label: "Open the file in a new tab", run: () => openOut(p.url) },
          { label: "Copy link", run: () => copyPageLink(p, say, s) },
          p.pin && !p.unpinned && { label: "Unpin", run: () => pinOp(p, "unpin", say) },
          p.pin && p.unpinned && { label: "Pin", run: () => pinOp(p, "pin", say) },
          inBrowser && { label: "Open in browser", run: () => inBrowser(pageURL(p, s)) },
          !APP && { label: "On phone", run: () => pageToPhone(p, say) },
          { label: "Take down", danger: true, run: () => askTakeDown(p).then((ok) => ok && say(`Took down “${pageTitle(p)}”.`)) },
        ].filter(Boolean)} />`}
        ${onClose && html`<button class="btn quiet icon" aria-label="Close the page" title="Close" onClick=${onClose}>${ICON.x}</button>`}
      </div>
      ${p.note && html`<div class="pnote">${p.note}</div>`}
      <${PageBody} key=${`${pkey(p)}:${nonce}`} p=${p} at=${at?.name === p.name ? at : null} onSend=${onSend} say=${say} />
    </div>`;
}

function PagesButton({ list, open, on }) {
  useSeenTick();
  const top = list[0], fresh = list.some(pageFresh);
  const face = html`${ICON.page}${list.length === 1 ? "Page" : "Pages"}${list.length > 1 && html`<span class="n">${list.length}</span>`}${fresh && html`<i class="pgdot" aria-label="new"></i>`}`;
  if (list.length === 1) return html`<button class="btn quiet pgbtn ${on ? "on" : ""}" aria-pressed=${on} aria-keyshortcuts="]" title=${tip("page", `${pageTitle(top)}, ${pageInfo(top)}`)} onClick=${() => open(top.name)}>${face}</button>`;
  return html`<${Menu} cls=${`btn quiet pgbtn ${on ? "on" : ""}`} aria="Pages" title=${tip("page", "Its pages")} width="min(320px, calc(100vw - 24px))" label=${face}
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

function PageCard({ p, onOpen, bay, sub, onDown }) {
  const st = pageStatus(p);
  return html`
    <div class="card pcard ${p.kind} ${st || ""}">
      <button class="pv" onClick=${onOpen} title=${tilde(p.path)}><${PageThumb} p=${p} /></button>
      <button class="cap" onClick=${onOpen}>
        <span class="n">${st && html`<i class="nd" aria-label=${st === "unseen" ? "Unseen" : "Updated"}></i>`}${pageTitle(p)}</span>
        <span class="m">${bay && html`<${IdTick} name=${bay} />`}<span>${p.gone ? "file is gone" : [bay || sub, age(p.updated || p.shown)].filter(Boolean).join(" · ")}</span></span>
      </button>
      ${onDown && html`<button class="icon down" title="Take down" aria-label="Take down" onClick=${onDown}>${ICON.x}</button>`}
    </div>`;
}

const ownerOf = (p, live) => live.find((x) => x.sessionId === p.session) || (p.session.startsWith("@") && live.find((x) => x.agent === p.session.slice(1) && x.kind !== "hub")) || null;
const ownerStub = (p) => ({ sessionId: p.session, title: p.of || "", state: "past", agent: p.session.startsWith("@") ? p.session.slice(1) : undefined });
const pageDay = (t) => { const n = new Date(); n.setHours(0, 0, 0, 0); return t >= +n ? "Today" : t >= n - 86400000 ? "Yesterday" : "Earlier"; };
const focusComposer = (n = 0) => { const t = document.querySelector(".composer textarea"); t ? t.focus() : n < 30 && setTimeout(() => focusComposer(n + 1), 100); };
const pageToPhone = (p, say) => api("/api/pages/phone", { method: "POST", body: { session: p.session, name: p.name, title: pageTitle(p) } }).then(() => say("Sent to your phone."), (e) => say(e.message));
const pageURL = (p, s) => pinOf(p) ? `${location.origin}/p/${encodeURIComponent(pinOf(p))}` : `${location.origin}/${aloneLink(ownerRef(p, s), p.name)}`;
const copyPageLink = (p, say, s) => { copyText(pageURL(p, s)); say("Link copied."); };
const inBrowser = APP?.openInBrowser && ((url) => APP.openInBrowser(url));
const pinOp = (p, op, say) => api(`/api/pins/${encodeURIComponent(pinOf(p))}${op === "rm" ? "" : `/${op}`}`, { method: op === "rm" ? "DELETE" : "POST" })
  .then(() => (say(op === "rm" ? `Deleted “${pageTitle(p)}”.` : `${op === "pin" ? "Pinned" : "Unpinned"} “${pageTitle(p)}”.`), true), (e) => (say(e.message), false));
const askDeletePin = (p) => ask({ title: `Delete “${pageTitle(p)}”?`, body: "Its folder and everything in it are deleted for good.",
  ok: "Delete", busy: "Deleting…", danger: true, run: () => api(`/api/pins/${encodeURIComponent(p.name)}`, { method: "DELETE" }) });

function usePageList(live, say) {
  const [list, setList] = useState(null);
  const load = useCallback(() => Promise.all([api("/api/pages"), api("/api/pins").catch(() => [])])
    .then(([l, pins]) => setList([...(pins || []), ...(l || [])]), (e) => { say(e.message); setList((x) => x || []); }), []);
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
  const regular = rows.filter((x) => !pinOf(x.p)), pins = rows.filter((x) => isPin(x.p) && !x.p.unpinned), unpinned = rows.filter((x) => isPin(x.p) && x.p.unpinned);
  const scoped = at.bay ? regular.filter((x) => x.bay === at.bay) : regular;
  const names = bays.map((b) => b.name);
  const groups = at.bay
    ? ["Today", "Yesterday", "Earlier"].map((d) => ({ name: d, rows: scoped.filter((x) => pageDay(pageAt(x.p)) === d) }))
    : [...names, ...new Set(regular.map((x) => x.bay).filter((b) => b && !names.includes(b))), null].map((b) => ({ name: b || "No bay", bay: true, rows: scoped.filter((x) => x.bay === b) }));
  const cur = at.sid ? rows.find((x) => x.p.session === at.sid && x.p.name === at.name) : null;
  const [unfold, setUnfold] = useState(false);
  const [more, setMore] = useState(false);
  const shown = [{ name: "Pinned", pin: true, rows: pins }, ...groups.filter((g) => g.rows.length),
    ...(unpinned.length ? [{ name: "Unpinned", fold: true, n: unpinned.length, rows: unfold || cur?.p.unpinned ? unpinned : [] }] : [])];
  const order = shown.flatMap((g) => g.rows);
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
    pin: (op) => pinOp(p, op, say).then((ok) => ok && load()),
    del: () => askDeletePin(p).then((ok) => { if (ok) { say(`Deleted “${pageTitle(p)}”.`); load(); back(); } }),
    down: () => isPin(p) ? act.pin("unpin") : askTakeDown(p).then((ok) => {
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
  const scopeLink = () => { location.hash = pagesHash(at.bay ? null : PAGES_FROM || names[0] || null, at.sid, at.name); PAGES_FROM = at.bay || PAGES_FROM; };
  const row = (x) => {
    const st = pageStatus(x.p), on = cur === x && !phone;
    return html`<button class="pgi ${st} ${on ? "sel" : ""}" data-pk=${pkey(x.p)} aria-current=${on ? "page" : null} onClick=${() => pick(x)}>
      <span class="t">${st === "unseen" && html`<span class="sr">Unseen: </span>`}${pageTitle(x.p)}</span>
      <span class="ag" title=${stamp(x.p.updated || x.p.shown)}>${st === "updated" && html`<span class="upd">updated</span>`}${age(x.p.updated || x.p.shown)}</span>
      ${isPin(x.p) ? html`<span class="ss"><span class="mono">/p/${x.p.name}</span></span>`
        : html`<span class="ss">${x.bay && html`<${IdTick} name=${x.bay} />`}${x.s ? html`<${StateBlock} s=${x.s} mini />` : html`<span class="sb mini earlier" aria-hidden="true">E</span>`}<span>${x.s?.title || x.p.of || "Earlier session"}</span></span>`}
      ${x.p.note && html`<span class="ld">${x.p.note}</span>`}
    </button>`;
  };
  const empty = html`<div class="pgnone">
    <h2>${list ? `No pages in ${at.bay || "any bay"} yet.` : "Loading pages…"}</h2>
    ${list && html`<p>Agents show pages with <code>atc show</code>: a report, a dashboard, a handover. They land here and beside the session that made them.</p>
    ${at.bay && html`<button class="kb" onClick=${scopeLink} title=${tip("pages.scope", "Every bay")}>Pages in every bay</button>`}`}
  </div>`;
  const kb = (label, key, run, extra = {}) => html`<button class="kb ${extra.on ? "on" : ""} ${extra.cls || ""}" aria-pressed=${extra.on === undefined ? null : extra.on}
    aria-keyshortcuts=${key || null} title=${key ? `${extra.title || (typeof label === "string" ? label : "")} (${key})`.trim() : extra.title || ""} onClick=${run}>${label}</button>`;
  const upd = op.st === "updated";
  const header = p && html`
    <header class="hd pghd">
      <div class="l1">
        <button class="kb back" onClick=${back} aria-label="Back to the pages">${ICON.back}<span class="bk">Back</span></button>
        ${s ? html`<${StateBlock} s=${s} />` : isPin(p) ? html`<span class="sb earlier" role="img" aria-label=${p.unpinned ? "unpinned" : "pinned"}>P</span>` : html`<span class="sb earlier" role="img" aria-label="ended">E</span>`}
        <h1 title=${pageTitle(p)}>${pageTitle(p)}</h1>
        <span class="where">${(KIND_LABEL[p.kind] || "Page").toLowerCase()}  ${p.name}</span>
        <span class="r">
          ${!phone && html`<${PaneToggle} id="pages.index" on=${index} run=${() => PANES.toggle("pgindex")} icon="rail" label="Every page in the bay, newest first" />`}
          ${upd && html`${kb("Changes", "d", act.changes, { on: op.changes, title: "Mark what changed since you saw it" })}<span class="div"></span>`}
          ${!isPin(p) && kb("Beside its session", "\\", act.beside, { title: s ? "The page beside its conversation" : "Its session is not running", cls: s ? "" : "off" })}
          ${!APP && kb("On phone", null, act.phone, { title: "Push this page to your phone" })}
          ${kb("Copy link", null, act.copy)}
          ${!isPin(p) && kb("Note", "enter", act.note, { title: s ? "Write to its session about this page" : "Its session is not running", cls: s ? "" : "off" })}
          <span class="div"></span>
          ${!isPin(p) ? kb("Take down", null, act.down, { cls: "danger" })
            : p.unpinned ? html`${kb("Pin", null, () => act.pin("pin"), { title: "Back on the Pinned list" })}${kb("Delete", null, act.del, { cls: "danger", title: "Delete its folder for good" })}`
            : kb("Unpin", null, () => act.pin("unpin"), { title: "Off the Pinned list; its folder is kept under Unpinned" })}
          <div class="more"><${Menu} cls="kb" aria="Page actions" label="Actions" items=${[
            upd && { label: op.changes ? "Hide what changed" : "Show what changed", run: act.changes },
            s && { label: "Note to its session", run: act.note },
            s && { label: "Open its session", run: () => go(keyOf(s)) },
            { label: "Copy link", run: act.copy },
            inBrowser && { label: "Open in browser", run: () => inBrowser(pageURL(p, s)) },
            !isPin(p) && { label: "Take down", danger: true, run: act.down },
            isPin(p) && !p.unpinned && { label: "Unpin", run: () => act.pin("unpin") },
            p.unpinned && { label: "Pin", run: () => act.pin("pin") },
            p.unpinned && { label: "Delete", danger: true, run: act.del },
          ].filter(Boolean)} /></div>
        </span>
      </div>
      <div class="l2">
        ${s ? html`<button class="sl" onClick=${() => go(keyOf(s))} title="Open the session">${s.title || "Untitled"}</button>` : isPin(p) ? html`<span class="sl off">${p.unpinned ? "Unpinned" : "Pinned"} · /p/${p.name}</span>` : html`<span class="sl off">${p.of || "Earlier session"}</span>`}
        ${cur.bay && cur.bay !== at.bay && html`<span>in ${cur.bay}</span>`}
        <span class="mono">${p.gone ? "file is gone" : upd && op.seen ? `updated ${hhmm(pageAt(p))}, seen ${hhmm(op.seen)}` : whenAt(pageAt(p))}</span>
        ${op.st === "unseen" && html`<span class="new">new</span>`}
      </div>
    </header>`;
  const missing = at.sid && !cur && html`<div class="pgnone"><h2>${list ? "This page was taken down." : "Loading…"}</h2>
    ${list && html`<button class="kb" onClick=${back}>Every page in ${at.bay || "every bay"}</button>`}</div>`;
  const quiet = names.filter((b) => !rows.some((x) => x.bay === b));
  const open = (x) => (location.hash = pagesHash(at.bay, x.p.session, x.p.name));
  const card = (x, sub) => html`<${PageCard} key=${pkey(x.p)} p=${x.p} bay=${x.bay} sub=${sub} onOpen=${() => open(x)} />`;
  const recent = more ? scoped : scoped.slice(0, 24);
  if (!at.sid) return html`
    <div class="pggal">
      <header class="phd"><h1>Pages</h1><span class="where">${at.bay || "every bay"}${list && counts(scoped) ? ` · ${counts(scoped)}` : ""}</span>
        <span class="r"><button class="btn quiet sm" onClick=${() => PALETTE_OPEN()} title=${tip("palette", "Search")}>${ICON.search}Search</button></span></header>
      <div class="pggal-in">
      <section class="gpins" aria-label="Pinned pages">
        <h2 class="gh"><b>Pinned</b><span class="c">${pins.length || ""}</span><span class="r">pages you keep, at /p/name</span></h2>
        ${pins.length ? html`<div class="cards big">${pins.map((x) => card(x, `/p/${x.p.name}`))}</div>`
          : html`<p class="none">${list ? "Nothing pinned yet. What you keep coming back to goes here: ask an agent to pin it." : "Loading…"}</p>`}
      </section>
      <section aria-label="Pages from sessions">
        <h2 class="gh"><b>From sessions</b><span class="c">${scoped.length || ""}</span>
          <span class="r"><button class="btn sm quiet" aria-pressed=${!at.bay} onClick=${scopeLink}>${at.bay ? `Only ${at.bay}` : "All bays"}</button></span></h2>
        ${recent.length ? html`<div class="cards">${recent.map((x) => card(x, x.s?.title || x.p.of || "Earlier session"))}</div>` : list && empty}
        ${scoped.length > recent.length && html`<p class="gmore"><button class="kb" onClick=${() => setMore(true)}>Show all ${scoped.length}</button></p>`}
      </section>
      ${unpinned.length > 0 && html`<details class="gunp"><summary><b>Unpinned</b> <span class="c">${unpinned.length}</span></summary>
        <div class="cards">${unpinned.map((x) => card(x, `/p/${x.p.name}`))}</div></details>`}
    </div></div>`;
  return html`
    <div class="pgv ${index || phone ? "" : "noindex"} ${phone && at.sid ? "full" : ""}">
      <aside class="pgidx" aria-label="Pages index">
        <div class="ph"><b>${at.bay || "All bays"}</b><span>${list ? [plural(scoped.length, "page"), counts(scoped)].filter(Boolean).join(", ") : "Loading…"}</span>
          <span class="r"><button class="kb ${at.bay ? "" : "on"}" aria-pressed=${!at.bay} onClick=${scopeLink}>All bays</button></span></div>
        <div class="pgscroll">
          ${shown.map((g) => html`<section class=${g.pin ? "pins" : ""}>
            ${g.fold ? html`<h2 class="grp"><button class="fold" aria-expanded=${!!g.rows.length} onClick=${() => setUnfold(!g.rows.length)}><b>${g.name}</b><span class="c">${g.n}</span></button></h2>`
              : html`<h2 class="grp"><b>${g.name}</b><span class="c">${g.rows.length}</span>${g.bay && counts(g.rows) && html`<span class="r">${counts(g.rows)}</span>`}</h2>`}
            ${g.pin && !g.rows.length && list && html`<${Empty}>No pinned pages yet. What you keep coming back to goes here: ask an agent to pin it.</${Empty}>`}
            ${g.rows.map(row)}
          </section>`)}
          ${!at.bay && list && quiet.length > 0 && html`<p class="none">${quiet.join(", ")}: no pages</p>`}
          ${!order.length && (phone ? empty : html`<p class="none">${list ? "No pages here yet." : "Loading…"}</p>`)}
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
  say(s.attachable && s.state !== "working" ? "Put on the backlog, and stopped. Resume it from there." : "Put on the backlog. It stops when its turn ends; resume it from there.");
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
  const s = BAY.only && live?.find((x) => x.cwd && projectOf(x) === BAY.only);
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

const BK_ORDER = ["ready", "started", "blocked", "suggested"];
const BK_SORTS = [["stage", "By stage"], ["new", "Newest"], ["bay", "By bay"]];

function BacklogPage({ live, say, onAdd, only }) {
  useNow(30000);
  const list = useBacklog();
  const [scope, setScope] = useState(only ? "bay" : "all");
  const bay = scope === "bay" ? only : null;
  const [v, setV] = useState(() => ({ sort: "stage", ...stored("atc.backlog", {}) }));
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
  const sort = v.sort === "bay" && bay ? "stage" : v.sort;
  const newest = (a, b) => Date.parse(b.created) - Date.parse(a.created);
  const open = scoped.filter((it) => itemStage(it) !== "done");
  const groups = sort === "stage" ? BK_ORDER.map((k) => [k, STAGES.find((x) => x[0] === k)[1], open.filter((it) => itemStage(it) === k).sort((a, b) => Date.parse(a.created) - Date.parse(b.created))])
    : sort === "bay" ? [...new Set(open.map((it) => project(it.dir).name))].sort().map((b) => [b, b, open.filter((it) => project(it.dir).name === b).sort(newest)])
    : [["", "", [...open].sort(newest)]];
  const finished = scoped.filter((it) => itemStage(it) === "done").sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  const shown = [...groups.flatMap((g) => g[2]), ...(v.done ? finished : [])];
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

  const row = (it) => html`<${BacklogRow} key=${it.id} it=${it} stage=${itemStage(it)} run=${run(it)} sel=${cur === it} tag=${!bay} chip=${sort !== "stage"}
    select=${() => setSel(it.id)} primary=${primary} done=${done} block=${block} patch=${patch} remove=${remove}
    edit=${edit?.id === it.id ? edit : null} setEdit=${setEdit} />`;
  const clear = () => ask({ title: `Delete ${plural(finished.length, "finished item")}?`, body: "They leave the backlog for good.", ok: "Delete", busy: "Deleting…", danger: true,
    run: () => Promise.all(finished.map((it) => call(it, "DELETE"))) }).then((ok) => ok && (say("Cleared."), load()));
  return html`
    <section class="scrpane backlogv" aria-label="Backlog">
      <header class="phd">
        <h1>Backlog</h1><span class="where">${bay ? `${bay}${where ? ` · ${tilde(where.dir)}` : ""}` : `all bays · ${plural(new Set(all.map((it) => project(it.dir).name)).size, "bay")}`}</span>
        <span class="num">${list ? `${open.length} open` : ""}</span>
        <span class="r">
          <span class="seg" role="group" aria-label="Order">${BK_SORTS.filter(([k]) => k !== "bay" || !bay).map(([k, name]) => html`<button aria-pressed=${sort === k} onClick=${() => set({ sort: k })}>${name}</button>`)}</span>
          ${only && html`<span class="seg" role="group" aria-label="Which bays"><button aria-pressed=${scope === "bay"} onClick=${() => setScope("bay")}>${only}</button><button aria-pressed=${scope === "all"} onClick=${() => setScope("all")}>All bays</button></span>`}
        </span>
      </header>
      <div class="scroll"><div class="bk ${bay ? "single" : ""}">
        <form class="bk-add" onSubmit=${(e) => { e.preventDefault(); addIt(); }}>
          <input id="bk-add" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === "Escape" && e.target.blur()} autocomplete="off"
            placeholder=${`${bay ? `A task for ${bay}` : "A task; you pick its folder next"}${touch ? "" : "; Enter adds it"}`} aria-label=${`Add a task to ${bay || "the"} backlog`} />
          <button class="btn" aria-busy=${adding} disabled=${!text.trim()}>Add</button></form>
        <div role="grid" aria-label="Backlog">
          ${!list && html`<div class="bk-skel" aria-hidden="true">${[0, 1, 2].map(() => html`<i></i>`)}</div>`}
          ${list && !open.length && html`<${Empty} cls="bk-empty">Nothing on ${bay ? `${bay}'s` : "the"} backlog. Add a task above, or press <kbd>+</kbd> on any session.<//>`}
          ${groups.filter((g) => g[2].length).map(([k, title, items]) => html`
            ${title && html`<h2 class="bk-g" key=${`g-${k}`}>${title}<span class="c ${k === "started" ? "w" : ""}">${items.length}</span></h2>`}
            ${items.map(row)}`)}
          ${finished.length > 0 && html`
            <h2 class="bk-g fold"><button aria-expanded=${!!v.done} onClick=${() => set({ done: !v.done })}>${ICON.fwd}Done<span class="c">${finished.length}</span></button>
              ${v.done && html`<button class="btn sm quiet" onClick=${clear}>Clear done</button>`}</h2>
            ${v.done && finished.map(row)}`}
        </div>
      </div></div>
    </section>`;
}

function BacklogRow({ it, stage, run, sel, tag, chip, select, primary, done, block, patch, remove, edit, setEdit }) {
  const head = itemTitle(it);
  const ended = stage === "started" && (!run || run.state === "stopped");
  const save = () => {
    if (edit.mode === "why") patch(it, { status: "blocked", why: edit.why }, "Blocked", { status: it.status, why: it.why || "" });
    else if (edit.title.trim() || edit.prompt.trim()) patch(it, { title: edit.title, prompt: edit.prompt }, "Saved");
    setEdit(null);
  };
  const note = it.why ? html`<span class="blk">Blocked:</span> waiting on ${it.why}` : run || it.aside ? null : it.title && it.prompt && it.prompt !== it.title ? oneLine(it.prompt) : "";
  const by = it.by ? html`<span class="by" role=${it.from ? "link" : null} onClick=${it.from ? (e) => { e.stopPropagation(); go(it.from); } : null} title=${it.from ? "Open the session that added it" : ""}>@${it.by}</span>` : html`<span class="by you">you</span>`;
  const act = (label, key, f, prime, icon) => html`<button class="btn sm ${prime ? "primary" : ""}" onClick=${(e) => { e.stopPropagation(); f(it); }} aria-keyshortcuts=${key || null} title=${key ? `${label} (${key === "Enter" ? "enter" : key})` : null}>${icon && ICON[icon]}${label}</button>`;
  const canBlock = stage === "ready" || stage === "blocked";
  const menu = [
    stage === "suggested" && { label: "Dismiss", icon: "x", run: () => remove(it) },
    canBlock && { label: stage === "blocked" ? "Unblock" : "Blocked", icon: "stop", key: "backlog.block", run: () => block(it) },
    { label: "Edit", icon: "doc", run: () => setEdit({ id: it.id, mode: "text", title: it.title || "", prompt: it.prompt || "" }) },
    !it.session && stage !== "done" && { label: it.worktree ? "Start in the folder itself" : "Start in a git worktree", icon: "folder", run: () => patch(it, { worktree: !it.worktree }, it.worktree ? "Starts in the folder" : "Starts in a worktree") },
    "-",
    { label: "Delete", danger: true, run: () => ask({ title: "Delete this item?", body: head, ok: "Delete", danger: true }).then((ok) => ok && remove(it)) },
  ].filter(Boolean);
  return html`
    <div class="bk-it ${stage} ${sel ? "sel" : ""}" role="row" aria-selected=${sel} tabindex=${sel ? 0 : -1} onClick=${select}>
      <span class="ti">${chip && stage !== "ready" && html`<span class="stg ${stage}">${stage}</span>`}
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
      <span class="ag" title=${stamp(stage === "done" ? it.updated : it.created)}>${age(stage === "done" ? it.updated : it.created)}${it.worktree && !it.session ? html`<span class="wt" title="Starts in its own worktree">wt</span>` : ""}</span>
      <span class="acts" onClick=${(e) => e.stopPropagation()}>
        ${stage === "suggested" ? act("Take it", "Enter", primary, true, "check")
          : stage === "done" ? act("Reopen", "Enter", primary, false, "undo")
          : stage === "started" ? !ended && run && act("Open", "Enter", primary, true, "fwd")
          : act(it.aside ? "Resume" : "Start", "Enter", primary, stage === "ready", "play")}
        ${stage !== "suggested" && stage !== "done" && html`<button class="btn sm quiet icon" onClick=${(e) => { e.stopPropagation(); done(it); }} aria-keyshortcuts="d" aria-label="Done" title="Done (d)">${ICON.check}</button>`}
        <${Menu} items=${menu} cls="btn sm quiet icon" aria="More for this task" />
      </span>
    </div>`;
}

let AGENT_INFO = {};
const away = (s) => !!s.parked && s.state !== "needs-you";
const homeless = (s) => !!s.agent && !AGENT_INFO[s.agent]?.dir;
const GUESTS = "guests";
const guestWork = (s) => s.agent === GUESTS || project(s.cwd).name === GUESTS;
const isAssistant = (s) => s?.kind === "hub" && s.agent === "assistant";
const hiddenRun = (s) => (isAssistant(s) || (!!s.agent && !!s.parked)) && s.state !== "needs-you";
const agentAtWork = (s) => hiddenRun(s) && s.state === "working";
const countsOnBay = (s) => !away(s) || agentAtWork(s);
const agentApi = (a, what, body) => api(`/api/agents/${encodeURIComponent(a)}/${what}`, { method: "POST", body });
const mins = (ns) => Math.round(ns / 6e10);
const spanOf = (ns) => { const m = mins(ns); return m % 60 ? (m > 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`) : `${m / 60}h`; };
const ktok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const soon = (at) => {
  const t = new Date(at), m = Math.round((t - Date.now()) / 6e4);
  return m < 60 ? `in ${Math.max(1, m)}m` : whenAt(t);
};

function AgentTag({ s }) {
  const a = AGENT_INFO[s.agent] || { name: s.agent };
  return html`<span class="agenttag" role="button" title=${`${agentLabel(a)}: details`}
    onClick=${(e) => { e.stopPropagation(); openAgent(a.name, "details"); }}><${AppTile} a=${a} size=${14} />${agentLabel(a)}</span>`;
}

const AGENTS_ROUTE = "#/agents";
const agentRoute = () => { const m = location.hash.match(/^#\/agents(?:\/([^/?]+))?(?:\/p\/.+)?$/); return m ? decodeURIComponent(m[1] || "") : null; };
const monogram = (n) => { const w = n.split(/[-_ ]+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : n.slice(0, 2)).toUpperCase(); };

function AgentMark({ a, lg }) {
  return html`<span class="am ${lg ? "lg" : ""}" data-ag=${a.name === "assistant" ? "assistant" : null} style=${`--am-c: ${appColor(a)}`} aria-hidden="true">${monogram(a.name)}</span>`;
}

const agentRun = (live, name) => live.filter((v) => v.agent === name).sort((p, q) => Date.parse(q.startedAt || 0) - Date.parse(p.startedAt || 0))[0];
const agentBadge = (a) => { const b = a.badge == null ? null : typeof a.badge === "object" ? a.badge.n ?? a.badge.count ?? a.badge.text : a.badge; return b == null || b === "" ? null : String(b); };
const agentKeeps = (a) => a.headline || (agentBadge(a) ? `${agentBadge(a)} on its page` : "");
const agentWakes = (a) => a.every ? `every ${a.every}${a.from ? ` from ${a.from.replace("T", " ")}` : ""}` : "when messaged";

function usePastSession(id, known, remember) {
  const [asked, setAsked] = useState({});
  useEffect(() => {
    if (!id || known || asked[id]) return;
    api(`/api/history?q=${encodeURIComponent(id)}&limit=1`).then((l) => remember(l || []), () => {}).finally(() => setAsked((m) => ({ ...m, [id]: true })));
  }, [id, known]);
  return !!id && !known && !asked[id];
}

function AgentsPage({ name, agents, live, past, remember, say, reload, panes, togglePane }) {
  useNow(30000);
  const wide = useWide();
  const list = (agents || []).filter((a) => a.name);
  const openable = list.filter((a) => a.name !== "assistant");
  const cur = openable.find((a) => a.name === name) || (wide && !name ? openable.find((a) => a.name === stored("atc.agentsel", "")) || openable[0] : null);
  useEffect(() => { if (name === "assistant") location.replace(ASSIST); }, [name]);
  useEffect(() => {
    if (!cur) return;
    store("atc.agentsel", cur.name);
    if (!name) history.replaceState(null, "", `${AGENTS_ROUTE}/${encodeURIComponent(cur.name)}`);
  }, [cur?.name, name]);
  const run = cur && (agentRun(live, cur.name) || past[cur.sessionId]);
  const lookingUp = usePastSession(cur?.sessionId, !!run, remember);
  const keys = useRef();
  keys.current = { openable, cur };
  useEffect(() => {
    const k = (e) => {
      const t = e.target;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector(".nsveil, .pal, .veil, .keys-ov")) return;
      const { openable: l, cur } = keys.current, i = l.indexOf(cur);
      const to = (a) => a && location.replace(`${AGENTS_ROUTE}/${encodeURIComponent(a.name)}`);
      const start = document.querySelector(".agp .phd [aria-keyshortcuts='Enter']");
      const f = { j: () => to(l[i + 1]), k: () => to(l[i - 1]), Enter: start && (() => start.click()) }[e.key];
      if (f) { e.preventDefault(); f(); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return html`
    <section class="scrpane agentsv ${cur ? "has-a" : "no-a"}" aria-label="Agents">
      <aside class="agl" aria-label="Agents">
        <div class="ph"><h1>Agents</h1><span class="num">${list.length}</span></div>
        <div class="scroll" role="listbox" aria-label="Agents">
          ${!agents && html`<p class="none">Loading…</p>`}
          ${agents && !list.length && html`<${Empty}>No standing agents yet. An agent is a folder with a brief under ~/.config/atc/agents.d.</${Empty}>`}
          ${list.map((a) => { const x = agentRun(live, a.name), keeps = agentKeeps(a); return html`
            <a class="ar ${a === cur ? "sel" : ""}" role="option" aria-selected=${a === cur} href=${`${AGENTS_ROUTE}/${encodeURIComponent(a.name)}`}
              onClick=${(e) => { e.preventDefault(); if (a.name === "assistant") return openAssistant(); const to = `${AGENTS_ROUTE}/${encodeURIComponent(a.name)}`; wide ? location.replace(to) : (location.hash = to); }}>
              <${AgentMark} a=${a} /><b>${a.name === "assistant" ? "Assistant" : `@${a.name}`}${x?.state === "working" && html`<span class="awake">awake</span>`}${x && waiting(x) && html`<span class="cn n" aria-label="waiting on you">1</span>`}</b>
              <span class="wk">${agentNext(a)}</span>
              <span class="k ${keeps ? "" : "nil"}">${a.error ? "Can't start: see why" : a.home ? "Can't start: its folder is your home folder" : keeps || "Keeps nothing"}</span></a>`; })}
        </div>
      </aside>
      ${cur ? html`<${AgentPane} key=${cur.name} a=${cur} run=${run} lookingUp=${lookingUp} live=${live} say=${say} reload=${reload} panes=${panes} togglePane=${togglePane} />`
        : html`<section class="agd"></section>`}
    </section>`;
}

const agentNext = (a) => a.home ? "doesn't wake" : a.next ? `next ${soon(a.next)}${a.every ? `, every ${a.every}` : ""}` : a.every ? `every ${a.every}` : "when messaged";
const AGENT_TAB = {};

function AgentPane({ a, run, lookingUp, live, say, reload, panes, togglePane }) {
  const page = a.pages?.[0];
  const [tab, setTab] = useState(() => AGENT_TAB[a.name] || (page ? "page" : "about"));
  const pick = (t) => { AGENT_TAB[a.name] = t; setTab(t); };
  const shown = tab === "page" && !page ? "about" : tab;
  const onSend = useMemo(() => page && ((t) => sendNote(run || ownerStub(page), page, t, say)), [page && pkey(page), run?.id]);
  const title = `@${a.name}`;
  const said = oneLine(run?.summary?.status || run?.preview || run?.lastReply);
  const conv = () => (run ? pick("chat") : agentApi(a.name, "message").then((r) => { reload(); go(r.id); }, (e) => say(e.message)));
  const woke = run?.startedAt || a.last;
  const menu = [
    run && { label: run.parked ? "Unpark" : "Park", icon: "park", run: () => api(`/api/sessions/${run.sessionId}`, { method: "PATCH", body: { parked: !run.parked } }).then(() => { reload(); say(run.parked ? `Unparked ${title}.` : `Parked ${title}.`); }, (e) => say(e.message)) },
    run && run.state !== "past" && { label: "Start over", icon: "refresh", run: () => agentApi(a.name, "reset").then(() => { reload(); say(`${title} is starting over.`); }, (e) => say(e.message)) },
    a.talk && { label: "Call", icon: "phone", run: () => callAgent(a.name, say) },
    page && { label: "Open the page alone", icon: "page", run: () => (location.hash = aloneLink(page.session, page.name)) },
  ].filter(Boolean);
  const tabs = html`<span class="seg" role="group" aria-label="Show">
    ${page && html`<button aria-pressed=${shown === "page"} onClick=${() => pick("page")}>${ICON.page}Page</button>`}
    <button aria-pressed=${shown === "chat"} onClick=${() => (run ? pick("chat") : conv())} aria-keyshortcuts="Enter" title="Its conversation (enter)">Conversation</button>
    <button aria-pressed=${shown === "about"} onClick=${() => pick("about")}>Details</button></span>`;
  return html`
    <section class="agd agp">
      <header class="phd">
        <a class="back btn quiet icon" href=${AGENTS_ROUTE} aria-label="Agents">${ICON.back}</a>
        <${AgentMark} a=${a} /><h1>${title}</h1>
        <span class="where">${[a.host, woke && `woke ${hhmm(woke)}, ${age(woke)} ago`].filter(Boolean).join(" · ")}</span>
        ${tabs}
        <span class="r">
          ${a.prompt && run && html`<button class="btn quiet sm" disabled=${run.state === "working"} title=${a.prompt} onClick=${() => agentApi(a.name, "message").then(() => { reload(); say(`Woke ${title}.`); }, (e) => say(e.message))}>${ICON.refresh}Wake now</button>`}
          ${menu.length > 0 && html`<${Menu} items=${menu} cls="btn quiet sm icon" aria=${`More for ${title}`} />`}
        </span>
      </header>
      ${shown === "chat" && run ? html`<section class="agv"><${Session} key=${run.sessionId} s=${run} say=${say} live=${live} panes=${panes} togglePane=${togglePane} back=${() => (location.hash = AGENTS_ROUTE)} pageTab=${!!page} /></section>`
        : shown === "chat" ? html`<div class="blank">${lookingUp ? "Opening…" : "No conversation yet."}</div>`
        : shown === "page" ? html`<div class="agpage"><${PageBody} key=${pkey(page)} p=${page} onSend=${onSend} say=${say} /></div>`
        : html`<${AgentDetail} a=${a} live=${live} say=${say} reload=${reload} bare />`}
      ${shown !== "chat" && (said || run) && html`<footer class="agsaid"><span class="l">Last said${run ? `, ${ago(run)}` : ""}</span><span class="t">${said || "Nothing yet."}</span>
        <button class="btn quiet sm" onClick=${conv}>Open conversation</button></footer>`}
    </section>`;
}

function AgentDetail({ a, live, say, reload, sheet, bare, onClose }) {
  const [busy, setBusy] = useState(false);
  const [use, setUse] = useState(false);
  const x = agentRun(live, a.name);
  const title = a.name === "assistant" ? "Assistant" : `@${a.name}`;
  const act = (fn, done) => async () => {
    setBusy(true);
    try { const r = await fn(); done && done(r); reload(); } catch (e) { say(e.message); }
    setBusy(false);
  };
  const conv = x || a.sessionId ? () => { onClose?.(); go(x ? keyOf(x) : a.sessionId); } : act(() => agentApi(a.name, "message"), (r) => { onClose?.(); go(r.id); });
  const keeps = agentKeeps(a);
  const said = oneLine(x?.summary?.status || x?.preview || x?.lastReply);
  const rule = a.rule && `${spanOf(a.rule.Quiet)} quiet past ${ktok(a.rule.Small)} tokens, or ${spanOf(a.rule.CapQuiet)} quiet past ${ktok(a.rule.Cap)}`;
  const status = a.error ? `Can't start: ${a.error}` : a.home ? "Can't start: Claude Code won't run a background session in your home folder. Give it a dir in agent.json." : x ? `${WORD[x.state] || x.state}${x.parked ? ", parked" : ""}${x.state === "working" && x.activity ? `: ${oneLine(x.activity)}` : ""}` : "No conversation running";
  const right = html`
    ${a.prompt && x && html`<button class="btn" disabled=${busy || x.state === "working"} title=${a.prompt} onClick=${act(() => agentApi(a.name, "message"), () => say(`Woke ${title}.`))}>Wake now</button>`}
    ${x && html`<button class="btn" disabled=${busy} onClick=${act(() => api(`/api/sessions/${x.sessionId}`, { method: "PATCH", body: { parked: !x.parked } }), () => say(x.parked ? `Unparked ${title}.` : `Parked ${title}.`))}>${x.parked ? "Unpark" : "Park"}</button>`}
    ${x && x.state !== "past" && html`<button class="btn" disabled=${busy || x.state === "working"} onClick=${act(() => agentApi(a.name, "reset"), () => say(`${title} is starting over.`))}>Start over</button>`}
    ${a.talk && html`<button class="btn" disabled=${busy} onClick=${() => { onClose?.(); callAgent(a.name, say); }}>Call</button>`}
    <button class="btn primary conv" disabled=${busy || (!x && !a.sessionId && !!a.error)} onClick=${conv} aria-keyshortcuts="Enter" title="Its conversation (enter)">Conversation</button>`;
  const facts = [
    ["Host", a.host],
    ["Folder", tilde(a.folder || a.dir || "")],
    ["Wakes", agentWakes(a)],
    a.next && ["Next", soon(a.next)],
    a.check && ["Only if", html`<code>${a.check}</code> prints something`],
    a.name !== "assistant" && a.name !== "guests" && ["On a call", a.talk ? "Can take the line" : html`Off. <code>"talk": true</code> in its agent.json lets you talk to it`],
    a.prompt && ["Prompt", a.prompt],
    rule && ["Starts over", rule],
    a.lastReset && ["Last started over", agoLong(a.lastReset)],
    x?.context && ["Context", `${ktok(x.context)} tokens`],
  ].filter(Boolean);
  const body = html`
      <div class="scroll"><div class="agbody">
        <div class="acts-ph">${right}</div>
        <section class="sec"><div class="sh"><h2>Keeps</h2><span class="n">${keeps ? "its own state, from its page" : ""}</span></div>
          ${keeps ? html`<div class="keeps">${agentBadge(a) && html`<b>${agentBadge(a)}</b>`}<p>${a.headline || "the count on its page"}</p></div>` : html`<div class="nothing"><b>${title} keeps nothing</b><p>It writes no state of its own: it acts when asked. What it did is in its conversation and in what it said below.</p></div>`}
        </section>
        <section class="sec"><div class="sh"><h2>Said</h2><span class="n">${x ? ago(x) : ""}</span></div>
          ${said ? html`<div class="said"><time>${x?.updated ? hhmm(x.updated) : ""}</time><p>${said}</p></div>` : html`<${Empty}>No messages in this conversation yet.</${Empty}>`}
        </section>
        <section class="sec links"><div class="sh"><h2>Pages</h2><span class="n">${plural(a.pages?.length || 0, "page")}</span></div>
          ${a.pages?.length ? a.pages.map((p) => html`<a href=${aloneLink(p.session, p.name)}><b>${pageTitle(p)}</b><span title=${stamp(p.updated || p.shown)}>${age(p.updated || p.shown)}</span></a>`) : html`<${Empty}>No pages from it yet.</${Empty}>`}
        </section>
        <section class="sec"><div class="sh"><h2>Where it lives</h2><span class="r"><button class="kb" onClick=${() => setUse(true)}>Usage</button></span></div>
          <dl class="kv">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        </section>
      </div></div>
      ${use && html`<${AgentUsage} name=${a.name} onClose=${() => setUse(false)} />`}`;
  if (sheet) return html`<${Sheet} cls="agsheet" title=${title} sub=${status} onClose=${onClose}><div class="scrpane">${body}</div><//>`;
  if (bare) return body;
  return html`
    <section class="agd">
      <header class="hd">
        <div class="l1"><a class="back kb" href=${AGENTS_ROUTE}>Agents</a><${AgentMark} a=${a} /><h1>${title}</h1><span class="where">${[a.host, tilde(a.folder || a.dir || "")].filter(Boolean).join(" ")}</span>
          <span class="r">${right}</span></div>
        <div class="l2"><span class="stat">${status}</span><span class="rd"><span class="l">wakes</span>${agentWakes(a)}</span>${a.next && html`<span class="rd"><span class="l">next</span>${soon(a.next)}</span>`}</div>
      </header>
      ${body}
    </section>`;
}

function AgentUsage({ name, onClose }) {
  const use = useUsage(`/api/agents/${encodeURIComponent(name)}/usage`, 15000);
  const a = AGENT_INFO[name] || { name };
  return html`<${SessionUsage} s=${{ title: `${agentLabel(a)}, every conversation` }} use=${use} agent onClose=${onClose} />`;
}
const SourceTag = ({ s, full }) => (s.agent ? html`<${AgentTag} s=${s} />` : html`<${ProjectTag} path=${s.cwd} full=${full} />`);


function AppTile({ a, size = 32, dot }) {
  return html`<span class="atile" style=${`--a: ${appColor(a)}; --s: ${size}px`}>
    ${ICON_PATHS[a.icon] ? svgIcon(ICON_PATHS[a.icon]) : html`<span class="aglyph">${a.icon || a.name[0].toUpperCase()}</span>`}
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
  const list = s ? [browserPage(s), ...(s.shown || [])].filter(Boolean) : Array.isArray(got) ? got.filter((p) => !p.unpinned || p.name === name) : [];
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
  text: { name: "System", css: "var(--text)", sizes: [15.5, 16.5, 18, 20, 22.5], lh: 1.5 },
  lit: { name: "Literata", css: "Literata, Georgia, serif", sizes: [16, 17.5, 19, 21, 23.5], lh: 1.52, weight: 420, optical: "none" },
  sans: { name: "Recursive", css: "var(--sans)", sizes: [15, 16, 17.5, 19.5, 22], lh: 1.5 },
};
const farFromEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 0.6;
const txStore = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`atc.tx.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(`atc.tx.${k}`) : localStorage.setItem(`atc.tx.${k}`, JSON.stringify(v)); } catch {} },
};
const txPrefs = {
  get: () => {
    const p = txStore.get("prefs", {});
    return { size: 1, width: 1, space: 1, paper: "", cards: "line", ...p, face: !p.face || (p.face === "lit" && !p.chose) ? "text" : p.face };
  },
  set(p) {
    const v = { ...txPrefs.get(), ...p, chose: p.face ? true : txStore.get("prefs", {}).chose };
    txStore.set("prefs", v);
    dispatchEvent(new CustomEvent("atc-txprefs", { detail: v }));
  },
};
const TX_MEASURES = [560, 620, 680];
const TX_SPACINGS = [1, 1.08, 1.2];
const TX_PAPERS = [["", "Theme"], ["paper", "Paper"], ["sepia", "Sepia"], ["dusk", "Dusk"], ["night", "Night"]];

function bodyOf(msgs) {
  const items = [];
  let cost = 0, ms = 0;
  for (const m of msgs) {
    cost += m.cost || 0;
    if (m.role === "done") ms = Math.max(ms, m.ms || 0);
    else if (m.role === "assistant") items.push({ t: "text", text: m.text, time: m.time });
    else if (m.role === "event") items.push({ t: "event", text: m.text, time: m.time, task: m.task, kind: m.kind, channel: m.channel });
    else if (m.role === "note") items.push({ t: "note", text: m.text, time: m.time, via: m.via, pastes: m.pastes });
    else if (m.role === "tool") items.push({ t: "step", ...m, input: m.input || {} });
  }
  const last = items.findLastIndex((it) => it.t === "step");
  const tail = items.slice(last + 1).filter((it) => it.t === "text"), answer = tail.map((it) => it.text).join("\n\n");
  const work = items.slice(0, last + 1).concat(items.slice(last + 1).filter((it) => it.t === "event" || it.t === "note"));
  const user = msgs.find((m) => m.role === "user");
  return { items: work, answer, answerAt: tail[0]?.time, images: user?.images || [], prompt: user?.text, via: user?.via, pastes: user?.pastes, cost, ms };
}


const txKind = (s) => {
  if (s.tool === "Bash") return s.badge ? s.badge.kind : "run";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(s.tool)) return "edit";
  if (/^(Read|Grep|Glob|LS)$/.test(s.tool)) return "look";
  if (/^Web/.test(s.tool)) return "web";
  if (/^(Agent|Task)$/.test(s.tool)) return "agent";
  if (s.tool === "AskUserQuestion") return "ask";
  if (LETTER_TOOLS.test(s.tool)) return "letter";
  return "tool";
};
const LETTER_TOOLS = /^mcp__atc__(send|start|report)$/;
const TX_NOISE = /^(ToolSearch|EnterWorktree|ExitWorktree|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|ReadNotifications|TodoWrite|TodoRead)$/;
const txSteps = (items) => items.filter((i) => i.t === "step");
const txDur = (t) => { const ms = Math.max(t.ms || 0, t.end && t.at ? new Date(t.end) - new Date(t.at) : 0); return ms >= 1000 ? duration(ms / 1000) : ""; };
const txUsd = (n) => n >= 1 ? `$${n.toFixed(2)}` : n >= 0.005 ? `${Math.round(n * 100)}¢` : "";
const plain = (t) => (t || "").replace(/```[\s\S]*?```/g, " ").replace(/^#+\s*/gm, "").replace(/^\s*>\s?/gm, "").replace(/[*`|]/g, "").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
const firstSentence = (t) => { const p = plain(t); const m = p.match(/^.{12,220}?[.!?:](\s|$)/); return m ? m[0].trim().replace(/:$/, "") : clipWords(p, 200); };
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
  if (b.kind === "commit" && b.ref) return html`<span class="chiplink" role="link" tabindex="0" title="Open this commit" data-sha=${b.ref}>${chip}</span>`;
  if (b.kind === "push" && b.range) return html`<span class="chiplink" role="link" tabindex="0" title="See what this pushed" data-range=${b.range}>${chip}</span>`;
  return chip;
}

const ansiNodes = (t) => ansiParts(t).map((p) => (p.cls ? html`<span class=${p.cls}>${p.text}</span>` : p.text));
function Clip({ out, bad, n = 8, tailFirst = false }) {
  const [all, setAll] = useState(false);
  if (!out?.text) return null;
  const lines = out.text.split("\n"), v = clipView(lines, { n, bad: tailFirst }), more = out.more || 0, cut = out.tail ? lines.length - out.tail : -1;
  const folded = !all && (v.before > 0 || v.after > 0), count = v.before + v.after + more;
  const body = folded ? ansiNodes(v.shown.join("\n"))
    : cut >= 0 ? html`${ansiNodes(lines.slice(0, cut).join("\n"))}<span class="tcut">${more} lines were not kept</span>${ansiNodes(lines.slice(cut).join("\n"))}`
    : ansiNodes(out.text);
  const show = folded && html`<button class="more-lines" onClick=${() => setAll(true)}>Show ${count} ${tailFirst ? "earlier " : "more "}line${count > 1 ? "s" : ""}</button>`;
  return html`${tailFirst && show}<pre class="tpre out ${bad ? "bad" : ""}"><button class="copy" data-copy data-src=${stripAnsi(out.text)}>Copy</button>${body}</pre>${!tailFirst && show}`;
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
function paintLine(text, path) {
  const lang = baseName(path || "").split(".").pop().toLowerCase();
  return lang && text.length < 2000 && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : null;
}
function Diff({ edits, cap = 400, path }) {
  const all = useMemo(() => edits.flatMap((e, i) => [...(i ? [{ gap: e.line ? `line ${e.line}` : "elsewhere in the file" }] : []), ...diffRows(e)]), [edits]), rows = all.slice(0, cap);
  const tidy = (l) => l.replace(/\t/g, "  ");
  const ind = Math.min(...rows.filter((r) => !r.gap && tidy(r.l).trim()).map((r) => tidy(r.l).match(/^ */)[0].length));
  const cut = (l) => (isFinite(ind) ? tidy(l).slice(ind) : tidy(l));
  return html`<div class="code">${rows.map((r) => {
    if (r.gap) return html`<div class="gap">${r.gap}</div>`;
    const a = cut(r.l), b = r.other != null ? cut(r.other) : null;
    const ranges = b != null && wordRanges(r.c === "del" ? a : b, r.c === "del" ? b : a, r.c), body = paintLine(a, path) || esc(a);
    return html`<div class="l ${r.c}"><span class="ln o">${r.o}</span><span class="ln">${r.n}</span><span class="s">${r.c === "add" ? "+" : r.c === "del" ? "-" : ""}</span><span class="c" dangerouslySetInnerHTML=${{ __html: (ranges ? marksOver(body, ranges) : body) || " " }}></span></div>`;
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
  return html`<span class="end running">${st.time ? duration((Date.now() - new Date(st.time)) / 1000) : "running"}</span>`;
}

const AGENT_RUNS = new Map();
function useAgentRuns(sid, live = false) {
  const [, tick] = useState(0);
  useEffect(() => {
    let e = AGENT_RUNS.get(sid);
    if (!e) {
      e = { runs: null, subs: new Set(), live: new Set(), timer: 0 };
      const poll = () => api(`/api/sessions/${sid}/agents`).then((r) => {
        e.runs = r.agents || [];
        e.subs.forEach((f) => f());
        clearTimeout(e.timer);
        e.timer = 0;
        if (e.subs.size && (e.live.size || e.runs.some((a) => !a.done))) e.timer = setTimeout(poll, document.visibilityState === "visible" ? 4000 : 20000);
      }, () => {});
      e.poll = poll;
      AGENT_RUNS.set(sid, e);
    }
    const f = () => tick((n) => n + 1);
    e.subs.add(f);
    if (live) e.live.add(f);
    if (!e.runs || ((live || e.runs.some((a) => !a.done)) && !e.timer)) e.poll();
    return () => { e.subs.delete(f); e.live.delete(f); if (!e.subs.size) { clearTimeout(e.timer); e.timer = 0; } };
  }, [sid, live]);
  return AGENT_RUNS.get(sid)?.runs || null;
}
const agentDoing = (a) => a.last && (a.last.tool === "Bash" ? oneLine(a.last.detail || "running a command") : `${VERB[a.last.tool] || toolName(a.last.tool).toLowerCase()} ${oneLine(a.last.detail || "")}`.trim());
const AGENT_MARK = { done: ICON.check, running: "", failed: ICON.x };
function AgentRow({ st, s, zoom }) {
  useNow(5000);
  const runs = useAgentRuns(s.sessionId), run = runs?.find((a) => a.tool === st.id);
  const [open, setOpen] = useState(false);
  const bg = /^Async agent launched/.test(st.out?.text || ""), end = TX_API?.ended(st.id), failed = st.out?.error || end?.status === "failed";
  const done = failed || run?.done || end || (st.out && !bg), state = failed ? "failed" : done ? "done" : "running";
  const started = run?.started || st.time, ended = done ? end?.at || run?.updated || st.out?.time : null;
  const span = started ? duration((msOf(ended || new Date().toISOString()) - msOf(started)) / 1000) : "";
  const kind = st.input?.subagent_type && st.input.subagent_type !== "general-purpose" ? st.input.subagent_type : "";
  const quiet = state === "running" && run?.updated && Date.now() - msOf(run.updated) > 120e3 ? duration((Date.now() - msOf(run.updated)) / 1000) : "";
  const line = state === "running" ? (agentDoing(run || {}) || "starting") + (quiet ? ` · quiet for ${quiet}` : "") : firstSentence(end?.result || run?.said || (!bg && st.out?.text) || "");
  return html`<div class="subrun ${state}" id=${`ag-${st.id}`}>
    <button class="subh" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <span class="subm" aria-hidden="true">${state === "running" ? html`<i class="pulse"></i>` : AGENT_MARK[state]}</span>
      <span class="subn"><b>${st.input?.description || st.detail || "Agent"}</b>${kind && html`<span class="subk">${kind}</span>`}</span>
      <span class="subt">${[run?.steps > 0 && plural(run.steps, "step"), span].filter(Boolean).join(" · ")}</span>
      ${line && html`<span class="subl ${state === "running" ? "mono" : ""}">${state === "running" ? "now: " : ""}${line}</span>`}
    </button>
    ${open && html`<div class="tbox"><${AgentThread} st=${st} s=${s} zoom=${zoom} /></div>`}
  </div>`;
}

function AgentThread({ st, s, zoom, brief }) {
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
    ${b.items.length > 0 && (brief
      ? html`<ol class="bsteps">${joinEdits(numberEdits(b.items)).filter((x) => x.t === "step" && !TX_NOISE.test(x.tool)).map((x) => { const m = stepNote(x, s), cmd = x.tool === "Bash" && !x.badge; return html`<li key=${x.id} class=${x.out?.error ? "bad" : ""} title=${cmd ? m.c : null}><b>${cmd ? "ran" : m.v}</b> ${cmd ? m.n || m.c : m.c}${!cmd && m.n && html` <span>${m.n}</span>`}${cmd && x.out?.error && html` <span>failed</span>`}</li>`; })}</ol>`
      : html`<div class="steps">${joinEdits(numberEdits(b.items)).filter((x) => x.t === "step" && !TX_NOISE.test(x.tool)).map((x) => html`<${Step} key=${x.id} st=${x} s=${s} zoom=${zoom} />`)}</div>`)}
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
      chosen=${picked.filter((i) => i >= 0)} line=${a ? html`You answered <b>${said}</b>${st.out?.time && `, ${hhmm(st.out.time)}`}${other?.what === a && fromWhere(other)}` : "No answer was given"} />`;
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

const FileArg = ({ path, line, end, children }) => html`<span class="arg farg" data-file=${path} data-exact data-line=${line || null} data-end=${end || null} tabindex="0" role="link" title="Open this file">${children}</span>`;

function Step({ st, s, zoom, pin }) {
  const k = txKind(st), i = st.input, bad = st.out?.error, failing = bad || (st.badge?.kind === "test" && !st.badge.ok) || (st.badge?.kind === "build" && !st.badge.ok);
  const [opened, setOpen] = useState(!!failing || (st.out?.images || []).length > 0);
  const open = opened || pin;
  const toggle = (e) => { if (!e?.target?.closest?.("[data-file], [data-sha], [data-range]")) setOpen(!open); };
  const cls = `step ${st.tool === "Write" ? "write" : k} ${bad ? "bad" : ""}`;
  const running = pin && !st.out && html`<${Running} st=${st} />`;
  if (k === "ask") return html`<div class=${cls}><${AskedStep} st=${st} s=${s} /></div>`;
  if (k === "letter") return html`<${SentLetter} st=${st} />`;
  if (st.tool === "Bash" && st.badge?.kind === "wa" && st.badge.wa) return html`<${SentWA} st=${st} />`;
  if (st.tool === "SendUserFile") return html`<${SentFiles} st=${st} zoom=${zoom} />`;
  if (st.tool === "Bash" && st.badge?.kind === "show") return html`<div class=${cls}><${PageRef} b=${st.badge} s=${s} /></div>`;
  if (st.tool === "Bash") {
    const cmd = i.command || st.detail || "";
    const b = st.badge, bg = bgOf(st);
    return html`<div class=${cls}>
      <button class="line" aria-expanded=${open} onClick=${toggle}>
        ${b ? html`<${BadgeChip} b=${b} />` : html`<b>${i.description || "Ran"}</b>`}
        ${!b && !i.description && html`<span class="arg">${cmd.split("\n")[0]}</span>`}
        ${b && i.description && html`<span class="arg sans">${i.description}</span>`}
        ${bg && html`<span class="bgw">in the background</span>`}
        ${bg ? html`<${BgNote} e=${bg} />` : html`<${Failed} st=${b ? {} : st} />`}${running}
      </button>
      ${open && html`<div class="tbox"><pre class="tpre"><span class="ps">$ </span>${cmd}</pre><${Clip} out=${st.out} bad=${bad} tailFirst=${!!failing} n=${failing ? 14 : 8} /></div>`}
    </div>`;
  }
  if (k === "edit") {
    const d = diffStat(st), path = relPath(i.file_path || st.detail, s), edits = st.tool === "Write" ? [{ old: "", new: i.content || "", line: 1 }] : st.edits || txEdits(st);
    return html`<div class=${cls}>
      <button class="line" aria-expanded=${open} onClick=${toggle}><b>${st.tool === "Write" ? "Wrote" : st.n > 1 ? `Edited ${st.n} times` : "Edited"}</b>${TOUCH ? html`<span class="arg">${path}</span>` : html`<${FileArg} path=${i.file_path || st.detail} line=${st.tool === "Write" ? 0 : edits[0]?.line}>${path}</${FileArg}>`}<span class="end"><span class="plus">+${d.add}</span>${d.del > 0 && html` <span class="minus">-${d.del}</span>`}</span>${running}</button>
      ${open && html`<div class="tbox">${TOUCH && html`<button class="more-lines" data-file=${i.file_path || st.detail} data-exact data-line=${st.tool === "Write" ? null : edits[0]?.line || null}>Open file</button>`}<${Diff} edits=${edits} cap=${120} path=${i.file_path || st.detail} /></div>`}
    </div>`;
  }
  if (st.tool === "Read") {
    const from = i.offset, to = i.offset && i.limit ? i.offset + i.limit : null;
    return html`<div class=${cls}><div class="line"><b>Read</b><${FileArg} path=${i.file_path || st.detail} line=${from} end=${to ? to - 1 : 0}>${relPath(i.file_path || st.detail, s)}${from ? `:${from}${to ? `-${to}` : ""}` : ""}</${FileArg}><${Failed} st=${st} />${running}</div><${Shots} st=${st} zoom=${zoom} /></div>`;
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
  if (k === "agent") return html`<${AgentRow} st=${st} s=${s} zoom=${zoom} />`;
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

const capsUI = (say) => ({ api, say, copyText, hostQ, go, Seg });

const SET_PAGES = [
  { id: "appearance", title: "Appearance", about: "Theme, reading and notifications" },
  { id: "persons", title: "Persons", about: "Who you hear and see on a call" },
  { id: "assistant", title: "Assistant", about: "Its name and how it reaches you", groups: ["Assistant"] },
  { id: "calls", title: "Calls", about: "The call line, voices and characters", groups: ["Calls"] },
  { id: "devices", title: "Devices", about: "Your paired devices and the phone app", groups: ["Phone"] },
  { id: "system", title: "System", about: "Claude Code, machines and services" },
  { id: "about", title: "About", about: "Versions" },
];
const capsPage = (g) => SET_PAGES.find((p) => p.groups?.includes(g))?.id || "system";

/** #/settings/<page>/<sub>; #/settings#<section or row> is an older link, and lands on the page holding it. */
const settingsRoute = () => {
  const m = location.hash.match(/^#\/settings(?:\/([^/#]+)(?:\/([^#]+))?)?(?:#(.+))?$/) || [];
  return { page: m[1] || "", sub: m[2] ? decodeURIComponent(m[2]) : "", at: m[3] || "" };
};
const ANCHOR_PAGES = { appearance: "appearance", reading: "appearance", notifications: "appearance", persons: "persons", devices: "devices", about: "about" };
const anchorPage = (at, caps) => {
  if (!at) return "";
  if (ANCHOR_PAGES[at]) return ANCHOR_PAGES[at];
  const row = caps?.machines?.flatMap((m) => m.rows || []).find((r) => r.id === at || slug(r.group) === at);
  return row ? capsPage(row.group) : "";
};

function SettingsPage({ me, say, onClose }) {
  const [caps, loadCaps] = useCaps(api);
  const [route, setRoute] = useState(settingsRoute);
  const phone = usePhone();
  const body = useRef(null);
  const page = route.page || anchorPage(route.at, caps) || (phone ? "" : "appearance");
  const back = () => {
    const now = settingsRoute();
    if (now.sub) location.hash = `${SETTINGS}/${now.page}`;
    else if (isPhone() && (now.page || now.at)) location.hash = SETTINGS;
    else onClose();
  };
  useEffect(() => {
    const f = () => setRoute(settingsRoute());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  useEffect(() => { if (!route.at && body.current) body.current.scrollTop = 0; }, [page, route.sub]);
  const warned = (p) => !!caps?.machines?.[0]?.rows?.some((r) => r.warn && capsPage(r.group) === p.id);
  const ui = { ...capsUI(say), home: me?.host };
  const [look, setLook] = useState({ scheme: LOOK.scheme, theme: LOOK.theme });
  const [colors, setColors] = useState(null);
  const [prefs, setPrefs] = useState(txPrefs.get);
  const [notif, setNotif] = useState(() => typeof Notification === "undefined" ? "none" : Notification.permission);
  useEffect(() => {
    const onLook = () => setLook({ scheme: LOOK.scheme, theme: LOOK.theme });
    const onPrefs = (e) => setPrefs(e.detail);
    const onKey = (e) => e.key === "Escape" && !document.querySelector(".veil") && !typingIn(e.target) && back();
    addEventListener("atc-look", onLook);
    addEventListener("atc-txprefs", onPrefs);
    addEventListener("keydown", onKey);
    Promise.all(LOOK.sheets).then(() => setColors(LOOK.palettes(PREVIEW_COLORS, (c) => c)));
    return () => { removeEventListener("atc-look", onLook); removeEventListener("atc-txprefs", onPrefs); removeEventListener("keydown", onKey); };
  }, []);
  const on = (sc) => look.scheme === "auto" || look.scheme === sc;
  const face = TX_FACES[prefs.face] || TX_FACES.text;
  const askNotif = () => Notification.requestPermission().then(setNotif);
  const hosts = me?.hosts?.length > 1 ? me.hosts.join(" and ") : me?.host;
  const cur = SET_PAGES.find((p) => p.id === page);
  return html`
    <section class="scrpane settings" aria-label="Settings">
      <div class="setshell ${page ? "page" : "list"}">
      <nav class="setnav" aria-label="Settings">
        <div class="phd setnh"><h1>Settings</h1></div>
        ${SET_PAGES.map((p) => html`<a key=${p.id} href=${`${SETTINGS}/${p.id}`} aria-current=${page === p.id ? "page" : null}>
          <span class="t">${p.title}</span>${warned(p) && html`<span class="warn" title="Needs attention"></span>`}<span class="about">${p.about}</span></a>`)}
      </nav>
      <div class="setmain">
      ${cur && html`<header class="phd"><button class="btn quiet icon back" onClick=${back} aria-label="Back">${ICON.back}</button><h1>${cur.title}</h1><span class="where">${cur.about}</span></header>`}
      <div class="pgbody" ref=${body}><div class=${`setpage ${page === "persons" ? "wide" : ""}`}>
        ${!["persons", "appearance", "about"].includes(page) && html`<${CapsBanner} rep=${caps} />`}
        ${page === "persons" && html`<${SettingsPersons} sub=${route.sub} />`}
        ${page === "appearance" && html`<section id="appearance">
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
        <section id="cards">
          <h2>Session list <span class="n">on this device</span></h2>
          <div class="set">
            <b>Summaries</b>
            <p>What a session waiting on you shows under its status. Longer adds the bullets from its <a href=${`${SETTINGS}#summary`}>summary</a>.</p>
            <div class="ctl"><${Seg} label="Session summaries" value=${prefs.cards} set=${(v) => txPrefs.set({ cards: v })}
              options=${[["long", "Longer"], ["line", "One line"]]} /></div>
          </div>
        </section>
        <section id="reading">
          <h2>Reading <span class="n">what agents say, on this device</span></h2>
          <div class="rgrid">
            <${ReadingPanel} prefs=${prefs} />
            <p class="rsample" style=${`font-family:${face.css};font-size:${face.sizes[prefs.size]}px;line-height:${(face.lh * TX_SPACINGS[prefs.space]).toFixed(3)};max-width:${TX_MEASURES[prefs.width]}px`}>${TX_SAMPLE}</p>
          </div>
          <p class="rnote">${ICON.zen}Paper colours the page in zen. The same panel opens from zen.</p>
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
          </section>`}`}
        ${["assistant", "calls", "devices", "system"].includes(page) && html`<${CapsSections} rep=${caps} reload=${loadCaps} ui=${ui} noMic=${!APP && !!me?.call && !Call.supported()} only=${(g) => capsPage(g) === page} />`}
        ${page === "devices" && html`<${DevicesSection} api=${api} app=${APP} copy=${copyText} ago=${agoLong} openOut=${openOut} />`}
        ${page === "about" && html`<section id="about">
          <h2>About</h2>
          <div class="set"><b>This atc</b><p>${caps?.machines?.[0]?.version ? `Version ${caps.machines[0].version}, build ` : "Build "}${me?.web || "unknown"}${hosts ? `, sessions on ${hosts}` : ""}${APP_VERSION ? `; Android app ${APP_VERSION}` : ""}.</p></div>
        </section>`}
      </div></div>
      </div>
      </div>
    </section>`;
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
      <span class="t">${hhmm(turns[i].at)}</span><span class="a">${t0(turns[i])}</span>${text && html`<span class="b">${text}</span>`}</button></li>`)}</ul>`}
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

function useBgOutputs(sid, live, id = "", n = 2) {
  const [out, setOut] = useState({});
  useEffect(() => {
    if (!live) return;
    let on = true, t = 0;
    const get = () => api(`/api/sessions/${sid}/background?n=${n}${id ? `&id=${encodeURIComponent(id)}` : ""}`).then((r) => { if (on) setOut(r.outputs || {}); }, () => {}).finally(() => { if (on) t = setTimeout(get, document.visibilityState === "visible" ? 3000 : 20000); });
    get();
    return () => { on = false; clearTimeout(t); };
  }, [sid, live, id, n]);
  return out;
}
const BG_KIND = { agent: "agent", shell: "command", monitor: "watch" };
const bgProgress = (line) => {
  const pct = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(line || ""), of = /\b(\d+)\s*(?:\/|of)\s*(\d+)\b/.exec(line || "");
  if (pct && +pct[1] <= 100) return +pct[1];
  if (of && +of[2] > 1 && +of[1] <= +of[2]) return (100 * of[1]) / of[2];
  return null;
};
const eventLine = (l) => {
  if (!/^\s*\{/.test(l || "")) return l;
  try {
    const o = JSON.parse(l);
    return Object.entries(o).filter(([, v]) => v !== null && v !== "" && typeof v !== "object").slice(0, 5).map(([k, v]) => `${k} ${v}`).join(" · ") || l;
  } catch { return l; }
};
const quietFor = (at) => (at && Date.now() - msOf(at) > 120e3 ? duration((Date.now() - msOf(at)) / 1000) : "");

function BgItem({ t, s, run, out, open, toggle }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { if (t.kind !== "agent" && !src) api(`/api/sessions/${s.sessionId}/tasks/${encodeURIComponent(t.id)}`).then(setSrc, () => setSrc({})); }, [t.id]);
  const long = useBgOutputs(s.sessionId, open && t.kind !== "agent", t.id, 40)[t.id] || (open ? out : null);
  const now = Date.now(), last = out?.lines?.[out.lines.length - 1] || "", exit = out?.exit;
  const failed = exit != null && exit !== 0, ended = t.done || (exit != null && msOf(out.updated));
  const state = !ended ? "run" : failed ? "bad" : "ok";
  const name = t.kind === "agent" ? run?.name || t.label : src?.description || t.label.replace(/^cd \S+ && /, "");
  const live = t.kind === "agent"
    ? (ended ? firstSentence(run?.said || "") : agentDoing(run || {}) || "starting")
    : t.kind === "monitor" ? last && `${out?.updated ? `${duration((now - msOf(out.updated)) / 1000)} ago` : "last"}: ${eventLine(last)}` : last;
  const quiet = !ended && t.kind !== "monitor" && quietFor(t.kind === "agent" ? run?.updated : out?.updated);
  const pct = !ended && t.kind === "shell" ? bgProgress(last) : null;
  const span = t.startedAt ? duration(((ended || now) - t.startedAt) / 1000) : "";
  const inTx = t.kind === "agent" && run && document.getElementById(`ag-${run.tool}`);
  const show = () => { if (inTx.querySelector(".subh")?.getAttribute("aria-expanded") === "false") inTx.querySelector(".subh").click(); TX_API?.reveal(`#${CSS.escape(inTx.id)}`); };
  const more = useRef(null), atEnd = useRef(true);
  useLayoutEffect(() => { const el = more.current?.querySelector(".thread"); if (el && atEnd.current) el.scrollTop = el.scrollHeight; });
  const scrolled = (e) => { const el = e.target; if (el.classList?.contains("thread")) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
  return html`<li class="bgi ${state} ${open ? "more" : ""}">
    <button class="bgi-h" onClick=${toggle} aria-expanded=${open}>
      <span class="bgi-m" aria-hidden="true">${state === "run" ? html`<i class="pulse"></i>` : state === "bad" ? ICON.x : ICON.check}</span>
      <span class="bgi-k">${BG_KIND[t.kind] || t.kind}</span>
      <span class="bgi-n">${name}</span>
      <span class="bgi-t">${[t.kind === "agent" && run?.steps > 0 && plural(run.steps, "step"), exit != null && exit !== 0 && `exit ${exit}`, ended ? `done ${span}` : span].filter(Boolean).join(" · ")}</span>
      ${(live || quiet) && html`<span class="bgi-l ${ended ? "" : "mono"}">${live}${quiet && html`<span class="bgi-q">${live ? " · " : ""}quiet for ${quiet}</span>`}</span>`}
      ${pct != null && html`<span class="bgi-bar" aria-label=${`${Math.round(pct)}%`}><i style=${`width:${pct}%`}></i></span>`}
    </button>
    ${open && html`<div class="bgi-more" ref=${more} onScrollCapture=${scrolled}>
      ${t.kind === "agent"
        ? run ? html`<${AgentThread} st=${{ id: run.tool, out: run.done ? { text: "" } : null }} s=${s} brief />${inTx && html`<button class="vlink bgi-go" onClick=${show}>show in conversation</button>`}` : html`<p class="cont">Its transcript isn't there yet.</p>`
        : html`${src?.detail && html`<pre class="bgi-cmd">${src.detail}</pre>`}${long?.lines?.length ? html`<pre class="bgi-out">${long.lines.join("\n")}</pre>` : html`<p class="cont">No output yet.</p>`}`}
    </div>`}
  </li>`;
}

function BgStrip({ s }) {
  const seen = useRef(new Map());
  const [open, setOpen] = useState(() => pref("atc.bgopen", "off") === "on");
  const [showDone, setShowDone] = useState(() => pref("atc.bgdone", "off") === "on");
  const [more, setMore] = useState(null);
  useNow(1000);
  const now = Date.now(), cur = s.background || [], ids = new Set(cur.map((t) => t.id));
  for (const t of cur) seen.current.set(t.id, { ...t, done: t.doneAt || 0 });
  for (const [id, t] of seen.current) if (!ids.has(id) && !t.done) t.done = now;
  const all = [...seen.current.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const running = all.filter((t) => !t.done);
  const runs = useAgentRuns(s.sessionId, running.some((t) => t.kind === "agent"));
  const outs = useBgOutputs(s.sessionId, all.some((t) => t.kind !== "agent" && (!t.done || now - t.done < 60e3)));
  if (!all.length) return null;
  if (!running.length && now - Math.max(...all.map((t) => t.done)) > 60e3) { seen.current.clear(); return null; }
  const runOf = (t) => runs?.find((a) => a.id === t.id);
  const toggle = () => { setOpen(!open); setPref("atc.bgopen", open ? "off" : "on"); };
  const toggleDone = () => { setShowDone(!showDone); setPref("atc.bgdone", showDone ? "off" : "on"); };
  const exited = (t) => t.kind !== "agent" && outs[t.id]?.exit != null;
  const busy = running.filter((t) => !exited(t)), finished = all.length - busy.length;
  const counts = Object.entries(busy.reduce((m, t) => ({ ...m, [t.kind]: (m[t.kind] || 0) + 1 }), {})).map(([k, n]) => plural(n, BG_KIND[k] || k)).join(", ");
  const busiest = busy.map((t) => ({ t, at: msOf(t.kind === "agent" ? runOf(t)?.updated : outs[t.id]?.updated) })).sort((a, b) => b.at - a.at)[0]?.t;
  const nowLine = busiest && (busiest.kind === "agent" ? agentDoing(runOf(busiest) || {}) : eventLine(outs[busiest.id]?.lines?.slice(-1)[0]));
  const bad = all.filter((t) => outs[t.id]?.exit != null && outs[t.id].exit !== 0).length;
  return html`<div class="bgstrip ${busy.length ? "" : "finished"}">
    <button class="bg-head" onClick=${toggle} aria-expanded=${open}>
      <span class="bgdots" aria-hidden="true">${all.map((t) => html`<i class=${!t.done && !exited(t) ? "run" : outs[t.id]?.exit ? "bad" : "ok"}></i>`)}</span>
      <span class="bg-c">${busy.length ? `${counts} running` : `${plural(all.length, "background job")} finished`}${finished > 0 && busy.length > 0 ? html`<span class="bg-sub"> · ${finished} done${bad ? `, ${bad} failed` : ""}</span>` : ""}</span>
      ${!open && nowLine && html`<span class="bg-now mono">${nowLine}</span>`}
      <span class="chev" aria-hidden="true"></span>
    </button>
    ${open && html`<ul>
      ${finished > 0 && busy.length > 0 && html`<li class="bg-fold"><button aria-expanded=${showDone} onClick=${toggleDone}>${finished} done<span class="chev" aria-hidden="true"></span></button></li>`}
      ${all.filter((t) => showDone || (!t.done && !exited(t)) || !busy.length).map((t) => html`<${BgItem} key=${t.id} t=${t} s=${s} run=${runOf(t)} out=${outs[t.id]} open=${more === t.id} toggle=${() => setMore(more === t.id ? null : t.id)} />`)}
    </ul>`}
  </div>`;
}

const ATT_URL = new Map();
const attsOf = (sid) => txStore.get(`atts.${sid}`, []).map((a) => ({ ...a, url: ATT_URL.get(a.id) || null }));

const SLASH = [["/compact", "Summarize the conversation to free context"], ["/clear", "Start over with an empty context"], ["/model", "Switch the model"],
  ["/review", "Review the current diff"], ["/cost", "What this session has cost"], ["/memory", "Edit CLAUDE.md memory"], ["/permissions", "What it may run without asking"],
  ["/agents", "Subagents it can call"], ["/init", "Write a CLAUDE.md for this repo"], ["/add-dir", "Let it read another folder"], ["/mcp", "MCP servers and their tools"], ["/status", "Model, account, connections"]];

function AttChips({ atts, up, zoom, remove }) {
  return atts.length > 0 && html`<div class="atts" aria-label="Attached">${atts.map((a) => html`<span class="att ${up(a) ? "up" : ""}">
    ${a.url ? html`<img src=${a.url} alt="" onClick=${() => zoom(a.url)} />` : html`<span class="fi" aria-hidden="true">${(a.name.split(".").pop() || "").slice(0, 4)}</span>`}
    <span class="nm">${a.name}</span><span class="sz">${up(a) ? "uploading" : a.size ? fileSize(a.size) : ""}</span>
    <button type="button" class="rm" aria-label=${`Remove ${a.name}`} onClick=${() => remove(a)}></button></span>`)}</div>`;
}

function Composer({ s, say, draft, setDraft, quotes, setQuotes, send, replies, focusRef, uploadRef, working, asking, interrupt, top, prompt, doors, hintFor, drop }) {
  const ta = useRef(), file = useRef();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [slash, setSlash] = useState(0);
  const [atts, setAttsRaw] = useState(() => attsOf(s.sessionId));
  const setAtts = (f) => setAttsRaw((as) => {
    const n = typeof f === "function" ? f(as) : f, kept = n.filter((a) => a.path).map(({ id, name, path, size }) => ({ id, name, path, size }));
    txStore.set(`atts.${s.sessionId}`, kept.length ? kept : null);
    return n;
  });
  const [big, setBig] = useState(null);
  const phone = usePhone();
  focusRef.current = () => ta.current?.focus();
  useEffect(() => { if (!working) setConfirm(false); }, [working]);
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = ""; if (el.scrollHeight > el.clientHeight + 2) el.style.height = Math.min(el.scrollHeight, phone ? 132 : 220) + "px"; } }, [draft]);
  const go = async () => {
    const paths = atts.map((a) => quotePath(a.path)).join("\n");
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
      const id = Math.random().toString(36).slice(2), url = f.type.startsWith("image/") ? URL.createObjectURL(f) : null;
      if (url) ATT_URL.set(id, url);
      setAtts((as) => [...as, { id, name: f.name || "pasted.png", url, size: f.size }]);
      try {
        const path = await uploadFile(`/api/sessions/${s.sessionId}/upload`, f);
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
  const onKey = (e) => {
    if (slashes?.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); return setSlash((i) => (Math.min(i, slashes.length - 1) + (e.key === "ArrowDown" ? 1 : slashes.length - 1)) % slashes.length); }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return pickSlash(slashes[Math.min(slash, slashes.length - 1)][0]); }
    }
    if (slashes && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return setDraft(""); }
    if (confirm) {
      if (e.key === "Enter") { e.preventDefault(); setConfirm(false); return interrupt(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return setConfirm(false); }
    }
    if (e.key === "Escape" && !draft && working) { e.preventDefault(); e.stopPropagation(); return setConfirm(true); }
    if (e.key === "Escape") { e.stopPropagation(); e.target.blur(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); return go(); }
  };
  const hasText = !!(draft.trim() || atts.length || quotes.length);
  const ready = hasText && !busy && !atts.some((a) => !a.path);
  const hint = hintFor && !asking && !working ? hintFor : asking ? "Or type your own answer" : working ? "Queue a reply" : "Reply";
  const chips = !hasText && !asking && replies?.length > 0 ? replies : [];
  const keep = () => { setConfirm(false); ta.current?.focus(); };
  const slashHint = () => { setDraft("/"); requestAnimationFrame(() => { const el = ta.current; el?.focus(); el?.setSelectionRange(1, 1); }); };
  return html`<div class="composer">
    <div class="cols"><div class="cx">${top}
      <div class="cmp ${hasText ? "has-text" : ""}">
        ${slashes && html`<div class="slash" role="listbox" aria-label="Slash commands">${slashes.length ? slashes.map(([c, d], j) => html`<button class="sl ${j === Math.min(slash, slashes.length - 1) ? "on" : ""}" role="option" aria-selected=${j === slash} onMouseDown=${(e) => e.preventDefault()} onClick=${() => pickSlash(c)}><span class="c"><b>${draft}</b>${c.slice(draft.length)}</span><span class="d">${d}</span></button>`)
          : html`<div class="sl none">No command starts with ${draft}</div>`}<div class="slh"><span>enter runs</span><span>tab completes</span><span>esc closes</span></div></div>`}
        ${quotes.map((q, j) => html`<div class="cstrip quote"><span class="qx">${q}</span><span class="sp"></span><button class="btn quiet" onClick=${() => setQuotes(quotes.filter((_, k) => k !== j))}>Remove</button></div>`)}
        <div class="box ${drop ? "drop" : ""}" onClick=${(e) => e.target === e.currentTarget && ta.current?.focus()}>
          ${drop && html`<div class="cdrop" aria-hidden="true">${ICON.upload}Drop to attach</div>`}
          ${chips.length > 0 && html`<div class="chips" aria-label="Suggested replies">${chips.map((r) => html`<button class="chip" disabled=${busy} title=${`Send “${r}”`} onClick=${async () => { setBusy(true); await send(r, { suggested: true }); setBusy(false); }}>${r}</button>`)}</div>`}
          <${AttChips} atts=${atts} up=${(a) => !a.path} zoom=${setBig} remove=${(a) => setAtts(atts.filter((x) => x.id !== a.id))} />
          <div class="crow">${prompt}<textarea ref=${ta} rows="1" value=${draft} placeholder=${hint} aria-label=${`Reply to ${s.title || "the session"}`} enterkeyhint=${touch ? "enter" : "send"}
            onInput=${(e) => { setDraft(e.target.value); setSlash(0); if (confirm) setConfirm(false); }} onKeyDown=${onKey}
            onPaste=${(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); upload(fs); } }}></textarea></div>
          <div class="cbar">
            <button class="btn quiet icon att-b" title="Attach files (or paste, or drop them on the session)" aria-label="Attach files" onClick=${() => file.current?.click()}>${ICON.attach}</button>
            <input type="file" multiple hidden ref=${file} onChange=${(e) => { upload([...e.target.files]); e.target.value = ""; }} />
            ${confirm ? html`<span class="cq" role="alert"><b>Stop this turn?</b> <span>What it has done so far stays.</span></span>
                <button class="btn" onClick=${keep} title="Keep going (esc)">Keep going</button><button class="btn danger primary" onClick=${() => { setConfirm(false); interrupt(); }} title="Stop (enter)">${ICON.stop}Stop</button>`
              : html`<button class="slh0" onClick=${slashHint} title=${tip("slash", "Slash commands")}>${phone ? "/" : "/ for commands"}</button><span class="sp"></span>${doors}
                ${working && !hasText && html`<button class="btn quiet" onClick=${() => setConfirm(true)} title=${tip("stop", "Stop its turn")}>${ICON.stop}Stop</button>`}
                <button class="btn send ${ready ? "primary" : ""}" disabled=${!ready} onClick=${go} title=${working ? "Queue: it sends when this turn ends (enter)" : slashes ? "Run (enter)" : "Send (enter)"}>${ICON.send}${slashes ? "Run" : working ? "Queue" : "Send"}</button>`}
          </div>
        </div>
      </div>
    </div></div>
    ${big && html`<div class="lightbox" onClick=${() => setBig(null)}><img src=${big} alt="" /></div>`}
  </div>`;
}

function EndBar({ s, resume, busy }) {
  const [why, setWhy] = useState(false);
  const e = (s.state === "stopped" || unexpected(s)) && s.ended?.text && s.ended.cause !== "unknown" ? s.ended : null;
  const at = hhmm(e?.at || s.updated);
  return html`${why && html`<${EndWhy} s=${s} onClose=${() => setWhy(false)} />`}<div class="endbar ${cutOff(s) ? "loud" : ""}"><div class="cols"><div class="cx">
    <p class=${why ? "" : "clamp"}><b>${s.state === "stopped" || e ? `Stopped${at ? ` ${at}` : ""}.` : "Not running."}</b> ${e ? e.text : "It keeps its transcript; Resume continues the conversation."}</p>
    <span class="acts">${e && html`<button class="btn quiet why" aria-expanded=${why} onClick=${() => setWhy((x) => !x)}>${why ? "Less" : "Why"}</button>`}${cutOff(s) && html`<button class="btn" title="Move it out of Stopped unexpectedly: you know why it stopped and have decided what to do" onClick=${() => dismissEnded([s])}>Dismiss</button>`}<button class="btn primary" disabled=${busy} aria-keyshortcuts="Enter" title=${tip("write", "Resume")} onClick=${resume}>${ICON.play}${busy ? "Resuming…" : "Resume"}</button></span>
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
  const byHand = () => {
    const back = document.activeElement;
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    back?.focus?.();
  };
  try { navigator.clipboard.writeText(text).catch(byHand); } catch { byHand(); }
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
const askId = (a) => a.key || a.id;
const ansKey = (sid, a) => `${sid}:${askId(a)}`;
async function answerAsk(s, a, rec) {
  const k = ansKey(s.sessionId, a);
  ANSWERS.set(k, { ...rec, sid: s.sessionId, id: a.id, ak: askId(a), st: "sending", at: new Date().toISOString(), why: "" });
  syncTell();
  markLooked({ ...s, updated: new Date().toISOString() });
  const wait = 10 + 5 * Math.max(0, (rec.body?.answers?.length || 1) - 1);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), wait * 1000);
  try {
    await api(`/api/sessions/${s.sessionId}/asks/${a.id}${a.key ? `?key=${encodeURIComponent(a.key)}` : ""}`, { method: "POST", body: rec.body, signal: ctl.signal });
    ANSWERS.set(k, { ...ANSWERS.get(k), st: "sent", sent: new Date().toISOString() });
  } catch (e) {
    const why = e.name === "AbortError" ? `${s.host || "The host"} did not confirm within ${wait} s.` : e.message;
    ANSWERS.set(k, { ...ANSWERS.get(k), st: "failed", why });
  }
  clearTimeout(t);
  syncTell();
}

function askSpec(s, a) {
  if (a.permission) {
    const cmd = (a.patterns || []).join(" ");
    return { perm: true, qs: [{ text: cmd ? "Wants to run" : `Wants to use ${toolName(a.permission)}`, cmd, options: [
      { label: "Allow once", note: "it runs now and asks again next time", body: { reply: "once" } },
      ...(s.harness ? [{ label: "Always for this pattern", note: cmd ? `allows ${cmd} for this session` : "allows it for this session", body: { reply: "always" } }] : []),
      { label: "Deny", note: "it stops and waits for you", body: { reject: true } }] }] };
  }
  return { qs: (a.questions || []).map((q) => ({ text: q.question, multiple: q.multiple, custom: q.custom, options: (q.options || []).map((o) => ({ label: o.label, note: o.description !== o.label ? o.description : "" })) })) };
}
const ANSWER_VIA = { push: "the notification", widget: "the home-screen widget", web: "atc" };
const answeredElsewhere = (s) => s.answered && !ANSWERS.has(ansKey(s.sessionId, { id: s.answered.ask, key: s.answered.key })) ? s.answered : null;
const fromWhere = (x) => html` <span class="from">(from ${ANSWER_VIA[x.via] || x.via}${x.device ? ` on ${x.device}` : ""})</span>`;
const askHead = (rec) => rec.i ? html`You answered <b>${rec.i}, ${rec.label}</b>` : html`You answered <b>${rec.label}</b>`;

function AskState({ rec, host, retry }) {
  if (rec.st === "sending") return html`<div class="ast" role="status"><span class="slow">Sending ${rec.i ? `${rec.i}, ${rec.label}` : "your answer"} to ${host || "the host"}…</span></div>`;
  if (rec.st === "sent") return html`<div class="ast" role="status"><b>Sent ${hhmm(rec.sent)}.</b> Waiting for the agent to take it.</div>`;
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
  const spec = askSpec(s, a), rec = ANSWERS.get(ansKey(s.sessionId, a));
  const locked = rec && rec.st !== "failed";
  const [picked, setPicked] = useState([]);
  const [typed, setTyped] = useState([]);
  useEffect(() => { setPicked([]); setTyped([]); }, [askId(a)]);
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
      <div class="aq">${q.text}${q.cmd && html` <code class="cmd">${q.cmd}</code>`}</div>
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
      <div class="aq ${spec.perm ? "ui" : ""}">${q.text}${q.cmd && html` <code class="cmd">${q.cmd}</code>`}</div>
      <div class="opts" role="group" aria-label="Answers">
        ${q.options.map((o, i) => html`<button class="opt ${chosen(qi, i) ? "ch" : ""}" disabled=${locked && !chosen(qi, i)} aria-disabled=${locked ? "true" : null}
          aria-pressed=${one ? null : chosen(qi, i)} aria-keyshortcuts=${i < 9 ? String(i + 1) : null} onClick=${() => pick(qi, i)}>
          <kbd aria-hidden="true">${i + 1}</kbd><span><span class="lb">${o.label}</span>${o.note && html`<span class="nt">${o.note}</span>`}</span></button>`)}
        ${!spec.perm && !locked && (one ? onType && html`<button class="opt type" onClick=${onType}><kbd aria-hidden="true"></kbd><span><span class="lb">Or type an answer</span></span></button>`
          : q.custom && html`<label class="opt type"><kbd aria-hidden="true"></kbd><input value=${typed[qi] || ""} placeholder="Or type an answer" onInput=${(e) => setTyped(Object.assign([...typed], { [qi]: e.target.value }))} /></label>`)}
      </div></div>`)}
    ${!one && !locked && html`<div class="acts"><button class="btn primary" disabled=${!ready} onClick=${sendAll}>Send answers</button></div>`}
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
const mcpParts = (tool) => { const p = tool.split("__"); return p[0] === "mcp" && p.length > 2 ? [p[1], p.slice(2).join("__")] : null; };
const toolFamilies = (steps) => {
  const by = new Map();
  for (const x of steps) { const m = mcpParts(x.tool); if (m) by.set(m[0], (by.get(m[0]) || new Set()).add(m[1])); }
  const label = new Map();
  for (const x of steps) {
    const m = mcpParts(x.tool);
    if (!m) { label.set(x.tool, VERB[x.tool] || toolName(x.tool).toLowerCase()); continue; }
    const tools = [...by.get(m[0])], seg = m[1].split("_")[0];
    label.set(x.tool, tools.length > 1 && tools.every((t) => t.split("_")[0] === seg && t.includes("_")) ? seg : m[0]);
  }
  return label;
};
const BG_STOPPED = new Set([130, 137, 143]);
const bgEnd = (t) => {
  const text = unesc(t.prompt || ""), exit = +(text.match(/exit code (\d+)/) || [])[1] || null, st = t.task.status;
  return { how: st === "completed" ? "done" : st === "killed" || st === "stopped" || BG_STOPPED.has(exit) ? "stopped" : "failed", exit, cmd: (text.match(/"(.*)"/s) || [])[1] || "", id: t.task.id, output: t.task.output };
};
const bgCmd = (t) => !!t?.task && /^Background command\b/.test(t.prompt || "");
const bgOf = (st) => (st.tool === "Bash" && st.input?.run_in_background ? TX_API?.bg(st.id) || { how: "" } : null);
const BgNote = ({ e }) => e.how && html`<span class="end ${e.how === "failed" ? "bad" : ""}">${e.how === "failed" ? `failed${e.exit != null ? `, exit ${e.exit}` : ""}` : e.how}</span>`;
const groupSpan = (steps) => {
  const a = Date.parse(steps[0]?.time || 0), b = Math.max(...steps.map((x) => Date.parse(x.out?.time || x.time || 0)));
  return a && b - a >= 1000 ? duration((b - a) / 1000) : "";
};
const letterGist = (x) => {
  const v = x.tool.split("__").pop(), o = letterOut(x);
  return v === "report" ? "reported to the assistant" : `${v === "start" ? "started" : "sent to"} ${o?.title || (v === "start" ? x.input.name || "a session" : x.input.session) || "a session"}`;
};
const waReplyGist = (t) => {
  const b = (t.badges || []).findLast((x) => x.kind === "wa" && x.ok && x.wa);
  return b && `${b.wa.group ? `In ${waGroupName(b.wa.group)}` : `To ${b.wa.to || "you"}`}: ${firstSentence(b.wa.text || b.wa.voice || "a file")}`;
};
const waGist = (x) => { const w = x.badge.wa; return `${x.badge.ok ? "wrote" : "failed to write"} ${w.group ? `in ${waGroupName(w.group)}` : `to ${w.to || "you"}`}`; };
const stepsGist = (steps, s) => {
  if (steps.length === 1 && txKind(steps[0]) === "letter") return letterGist(steps[0]);
  if (steps.length === 1 && txKind(steps[0]) === "wa" && steps[0].badge.wa) return waGist(steps[0]);
  if (steps.length === 1) { const m = stepNote(steps[0], s); return steps[0].tool === "Bash" && !steps[0].badge ? m.n && m.n !== "failed" ? m.n : `ran ${m.c}` : `${m.v} ${m.c}`; }
  const count = (kind) => steps.filter((x) => txKind(x) === kind), files = (l) => new Set(l.map((x) => x.input.file_path || x.detail)).size;
  const reads = steps.filter((x) => x.tool === "Read"), finds = steps.filter((x) => x.tool === "Grep" || x.tool === "Glob"), edits = count("edit");
  const named = steps.filter((x) => !["run", "look", "edit", "web", "agent", "ask", "letter", "wa"].includes(txKind(x)));
  const fam = toolFamilies(named), counts = new Map();
  for (const x of named) { const k = x.badge ? x.badge.kind : fam.get(x.tool); counts.set(k, (counts.get(k) || 0) + 1); }
  const others = [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  return [reads.length && `read ${plural(files(reads), "file")}`, finds.length && `searched ${finds.length}`, count("run").length && `ran ${plural(count("run").length, "command")}`,
    edits.length && `edited ${plural(files(edits), "file")}`, count("web").length && `${count("web").length} web`, count("agent").length && (count("agent").every((x) => /^Async agent launched/.test(x.out?.text || "")) ? `started ${plural(count("agent").length, "agent")}` : plural(count("agent").length, "agent")), ...new Set(count("letter").map(letterGist)), ...new Set(count("wa").filter((x) => x.badge.wa).map(waGist)), ...others].filter(Boolean).join(", ");
};

const InlineSteps = ({ steps, s, open, toggle }) => {
  const failed = steps.filter((x) => x.out?.error || x.badge?.ok === false || bgOf(x)?.how === "failed").length, span = groupSpan(steps);
  return html`<button class="inl-steps" aria-expanded=${open} onClick=${toggle} title=${open ? "Fold the steps" : "Show every step"}><span class="chev" aria-hidden="true"></span><span class="v">${stepsGist(steps, s)}</span>${failed > 0 && html`<b>, ${failed} failed</b>`}${span && html`<span class="h"> · ${span}</span>`}</button>`;
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
  const edits = steps.filter((x) => txKind(x) === "edit" && !x.out?.error && !scratch(x.input.file_path || x.detail));
  return html`${edits.length > 0 && html`<${Edits} steps=${edits} s=${s} />`}
    ${steps.filter((x) => txKind(x) === "ask" || txKind(x) === "letter" || txKind(x) === "agent" || x.tool === "SendUserFile" || (x.tool === "Bash" && (x.badge?.kind === "show" || x.badge?.kind === "wa"))).map((x) => html`<${Step} key=${x.id} st=${x} s=${s} zoom=${zoom} />`)}`;
}

function agentRows(b) {
  const rows = [], items = joinEdits(numberEdits(b.items));
  let g = [];
  const flush = () => { if (g.length) rows.push({ k: "steps", steps: g, at: g[0].time }); g = []; };
  for (const it of items) {
    if (it.t === "step") { if (!TX_NOISE.test(it.tool)) g.push(it); continue; }
    flush();
    if (it.t === "text") rows.push({ k: "say", text: it.text, at: it.time });
    else rows.push({ k: it.t === "note" ? "note" : "evt", text: it.text, at: it.time, via: it.via, pastes: it.pastes, task: it.task, kind: it.kind, channel: it.channel });
  }
  flush();
  if (b.answer) rows.push({ k: "say", text: b.answer, at: b.answerAt || rows[rows.length - 1]?.at, answer: true });
  const out = [];
  for (let j = 0; j < rows.length; j++) {
    if (rows[j].k === "steps" && rows[j + 1]?.k === "say") { out.push({ ...rows[j + 1], steps: rows[j].steps, at: rows[j].at || rows[j + 1].at, textAt: rows[j + 1].at }); j++; }
    else out.push(rows[j]);
  }
  return out;
}

const unesc = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const cleanPrompt = (t) => unesc(t || "").replace(/\[Image #\d+\]\s*/g, "");
const viaSession = (v) => v?.ref && LIVE.find((x) => x.id === v.ref || x.sessionId?.startsWith(v.ref)) || null;
const viaName = (v) => v.title || v.source || (v.host ? `a session on ${v.host}` : v.channel || "another session");
const VIA_ASK = { report: ["want", "wants a report"], handoff: ["", "handed to you"] };
const CHANNELS = { atc: ["atc", "screen"], whatsapp: ["WhatsApp", "chat"], phone: ["a call", "phone"], "atc-voice": ["voice", "mic"] };
const chName = (ch) => CHANNELS[ch]?.[0] || ch;
const chIcon = (ch) => ICON[CHANNELS[ch]?.[1] || "chat"];
const youOn = (ch) => (!ch || ch === "atc" ? "you" : ch === "phone" ? "you said" : `you on ${chName(ch)}`);
function ViaHead({ v, at, when }) {
  useLive();
  const pop = useRef(null), x = viaSession(v), name = viaName(v), asked = v.ref && TX_API?.asked(v.ref, when);
  const hue = hueOf(x?.cwd ? project(x.cwd).name : name);
  const [tone, chip] = v.approved ? ["go", "your go-ahead"] : VIA_ASK[v.ask] || ["", "FYI"];
  useEffect(() => {
    const away = (e) => pop.current?.open && !pop.current.contains(e.target) && (pop.current.open = false);
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, []);
  const facts = [["from", name], ["ref", v.ref], ["host", v.host], ["source", v.source], ["channel", v.channel && `${v.channel}${v.channel === "agent" || v.channel === "guest" ? " (the reply reaches no one)" : ""}`],
    ["asks", v.askText], ["user was", v.where && v.where.replace(/^The user is /, "")]].filter(([, val]) => val);
  return html`<div class="vh">
    <details class="vpop" ref=${pop}><summary><span class="vsq" style=${`--ph: ${hue}`} aria-hidden="true">${name.replace(/^@/, "")[0]?.toUpperCase()}</span><b>${name}</b>${v.host && html`<span class="vho">on ${v.host}</span>`}</summary>
      <div class="vbox"><dl>${facts.map(([k, val]) => html`<dt>${k}</dt><dd>${val}</dd>`)}</dl>
        ${x && html`<a class="btn sm" href=${`#/s/${keyOf(x)}`}>Open ${x.title || name}</a>`}
        ${v.raw && html`<details class="vraw"><summary>What this session read</summary><pre>${v.raw}</pre></details>`}</div></details>
    ${v.started && html`<span class="vto">started this</span>`}
    <span class="vchip ${tone}">${chip}</span>${asked && html`<button class="vlink" onClick=${() => TX_API?.jump(asked)}>answers your message, ${hhmm(asked.at)}</button>`}<span class="vat">${at}</span></div>`;
}
const WA_GROUPS = new Map();
const phoneText = (n) => (n.length === 12 && n.startsWith("90") ? `+90 ${n.slice(2, 5)} ${n.slice(5, 8)} ${n.slice(8, 10)} ${n.slice(10)}` : `+${n}`);
const waWho = (w) => (w.you ? "You" : w.name || w.guest || (w.number ? phoneText(w.number) : "Someone"));
const waGroupName = (id) => WA_GROUPS.get(id) || "the group";
const waSpoken = (v) => (v && v !== "yes" ? `voice note, ${v[0].toUpperCase()}${v.slice(1)}` : "voice note");
const mapsLink = (loc) => { const [, ll] = loc.match(/^(-?[\d.]+,-?[\d.]+)/) || []; return ll ? `https://maps.google.com/?q=${ll}` : null; };
function WAHead({ v, at }) {
  const w = v.wa, name = waWho(w), pop = useRef(null);
  if (w.group && w.groupId) WA_GROUPS.set(w.groupId, w.group);
  useEffect(() => {
    const away = (e) => pop.current?.open && !pop.current.contains(e.target) && (pop.current.open = false);
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, []);
  const facts = [["from", w.you ? "you (atc checked the sender)" : w.name], ["number", w.number && phoneText(w.number)], ["guest", w.guest], ["group", w.group], ["group id", w.groupId], ["file", w.path]].filter(([, val]) => val);
  return html`<div class="vh wah">
    <details class="vpop" ref=${pop}><summary><span class=${`wav ${w.you ? "you" : ""}`} style=${`--ph: ${hueOf(w.number || name)}`} aria-hidden="true">${name[0]?.toUpperCase()}</span><b>${name}</b>${!w.you && w.number && w.name && html`<span class="wanum">${phoneText(w.number)}</span>`}</summary>
      <div class="vbox"><dl>${facts.map(([k, val]) => html`<dt>${k}</dt><dd>${val}</dd>`)}</dl>
        ${v.raw && html`<details class="vraw"><summary>What this session read</summary><pre>${v.raw}</pre></details>`}</div></details>
    ${w.guest && html`<span class="vchip">guest</span>`}
    <span class="vchip wa">${ICON.chat}${w.group ? w.group : "WhatsApp"}</span>
    ${w.mention && html`<span class="vchip want">mentioned delta</span>`}
    ${w.forwarded && html`<span class="vchip">forwarded</span>`}
    <span class="vat">${at}</span></div>`;
}
function WAExtras({ w }) {
  const link = w.location && mapsLink(w.location), voice = w.media === "voice note" || w.media === "audio";
  return html`${w.quote && html`<blockquote class="waq"><span>replying to</span>${w.quote}</blockquote>`}
    ${voice && html`<p class="wamedia">${ICON.mic}<span>${waSpoken(w.voice)}, as heard</span></p>`}
    ${!voice && w.media && html`<p class="wamedia">${ICON.page}${w.path ? html`<span class="arg farg" data-file=${w.path} data-exact tabindex="0" role="link" title="Open this file">${w.media}: ${w.path.split("/").pop()}</span>` : html`<span>${w.media}</span>`}</p>`}
    ${w.location && html`<p class="wamedia">${ICON.globe}${link ? html`<a href=${link} data-out>${w.location}</a>` : html`<span>${w.location}</span>`}</p>`}`;
}
function WAAdded({ v, at }) {
  const w = v.wa, by = w.added?.you ? "you" : waWho(w.added || {});
  if (w.groupId) WA_GROUPS.set(w.groupId, w.group);
  const others = (w.members || []).filter((m) => !m.you).map(waWho);
  return html`<p class="evt waadd">${ICON.chat} Added to <b>${w.group}</b> by ${by}${others.length > 0 && html`, with ${others.join(", ")}`}<time>${at}</time></p>`;
}
function SentWA({ st }) {
  const w = st.badge.wa, failed = !st.badge.ok;
  const to = w.group ? html`In <b>${waGroupName(w.group)}</b>` : w.to ? html`To <b>${w.to}</b>` : html`To <b>you</b>`;
  const [all, setAll] = useState(false), long = (w.text || "").length > 700 || (w.text || "").split("\n").length > 10;
  return html`<div class="sent wasent ${failed ? "bad" : ""}">
    <div class="snh"><span class="sni">${ICON.chat}</span><span class="sto">${to} on WhatsApp</span><span class="vat">${hhmm(st.time)}</span></div>
    ${w.text && html`<div class="prose ptxt ${long && !all ? "clamp" : ""}" dangerouslySetInnerHTML=${{ __html: Marked.parse(w.text, { breaks: true }) }}></div>`}
    ${long && html`<button class="kb more" onClick=${() => setAll(!all)}>${all ? "Show less" : "Show all"}</button>`}
    ${w.voice && html`<p class="wamedia">${ICON.mic}<span>voice note: «${w.voice}»</span></p>`}
    ${(w.files || []).map((f) => html`<p class="wamedia">${ICON.page}<span class="arg farg" data-file=${f} data-exact tabindex="0" role="link" title="Open this file">${f.split("/").pop()}</span></p>`)}
    ${w.poll && html`<p class="wamedia">${ICON.list}<span>poll: ${w.poll}</span></p>`}
    ${failed && html`<p class="snerr">Not sent: ${oneLine(st.out?.text)}</p>`}
  </div>`;
}
function SentFiles({ st, zoom }) {
  const i = st.input, m = st.out?.meta?.sent, failed = st.out?.error;
  const files = m ? m.files : i.files || [];
  return html`<div class="sent ${failed ? "bad" : ""}">
    <div class="snh"><span class="sni">${ICON.page}</span><span class="sto">To <b>you</b></span><span class="vat">${hhmm(st.time)}</span></div>
    ${(m?.caption || i.caption) && html`<p class="sncap">${m?.caption || i.caption}</p>`}
    ${(st.out?.images || []).map((src) => html`<img class="snap" src=${src} alt="Image Claude sent you" onClick=${() => zoom(src)} />`)}
    ${files.map((f) => html`<p class="wamedia">${ICON.page}<span class="arg farg" data-file=${f} data-exact tabindex="0" role="link" title="Open this file">${f.split("/").pop()}</span></p>`)}
    ${failed && html`<p class="snerr">Not sent: ${oneLine(st.out?.text)}</p>`}
  </div>`;
}
const PASTE_FOLD = 6;
const pasteParts = (text, pastes) => {
  const parts = [];
  let rest = text;
  for (const p of pastes || []) {
    const i = p.split("\n").length > PASTE_FOLD ? rest.indexOf(p) : -1;
    if (i < 0) continue;
    parts.push(rest.slice(0, i), { paste: p });
    rest = rest.slice(i + p.length);
  }
  parts.push(rest);
  return parts.filter((x) => typeof x !== "string" || x.trim());
};
function Lead({ text, images, files, at, when, via, channel, pastes, mark }) {
  const [all, setAll] = useState(false);
  const parts = useMemo(() => pasteParts(text, pastes).map((x) => (typeof x === "string" ? { html: Marked.parse(x.trim(), { breaks: true }) } : x)), [text, pastes]);
  const said = parts.map((x) => (x.html ? x.html : "")).join("");
  const long = said.length > 900 || said.split("<p>").length > 9;
  const spoken = !via && channel === "phone";
  if (via?.wa?.added) return html`<${WAAdded} v=${via} at=${at} />`;
  return html`${via?.news?.length > 0 && via.news.map((n) => html`<p class="evt vnews">${n}</p>`)}<div class=${via?.wa ? "lead via wa" : via ? "lead via" : spoken ? "lead spoken" : "lead"}>${via?.wa ? html`<${WAHead} v=${via} at=${at} />${html`<${WAExtras} w=${via.wa} />`}` : via ? html`<${ViaHead} v=${via} at=${at} when=${when} />` : html`<div class="lead-at">${channel && channel !== "atc" && html`<span class="lch">${chIcon(channel)}</span>`}${youOn(channel)} ${at}${mark?.heard && html` <span class="cutchip" title=${`It had said: «${mark.heard}»`}>cut in</span>`}</div>`}<div class="prose ptxt ${long && !all ? "clamp" : ""}">${parts.map((x) => x.paste ? html`<details class="paste"><summary>Pasted, ${plural(x.paste.split("\n").length, "line")}</summary><pre>${x.paste}</pre></details>` : html`<div dangerouslySetInnerHTML=${{ __html: x.html }}></div>`)}</div>
    ${mark?.alt && html`<p class="alt">or «${mark.alt}»</p>`}${mark?.altOnly && html`<p class="alt">only the second reading heard this</p>`}
    ${long && html`<button class="kb more" onClick=${() => setAll(!all)}>${all ? "Show less" : "Show all"}</button>`}
    ${files > 0 && html`<span class="attl">${plural(files, "attachment")}</span>`}
    ${(images || []).length > 0 && html`<span class="imgs">${images.map((src) => html`<img src=${src} alt="Image you attached" />`)}</span>`}</div>`;
}

const TX_GAP = 90 * 60e3;
const gapText = (a, b) => {
  const from = new Date(a), to = new Date(b);
  const h = (to - from) / 3600e3;
  return h < 1.5 ? `${Math.round(h * 60)} min later` : `${Math.round(h)} hours later`;
};
const replyDest = (t) => (t.via?.channel === "agent" || t.via?.channel === "guest" ? "reached no one" : t.channel === "whatsapp" ? "sent on WhatsApp" : t.channel === "phone" ? "said on the call" : "");
const foldCalls = (rows, open, bodies) => {
  for (let a = 0; a < rows.length; a++) {
    const start = rows[a];
    if (start.k !== "chan" || start.ch !== "phone") continue;
    const b = rows.findIndex((r, j) => j > a && (r.kind === "call-end" || r.t?.kind === "call-end"));
    if (b < 0) continue;
    const key = start.key;
    if (open.has(key)) { start.callKey = key; a = b; continue; }
    const seg = rows.slice(a, b + 1), said = seg.filter((r) => (r.k === "you" || r.k === "fold") && !r.t?.via && r.t?.channel === "phone" && r.t?.prompt);
    const letters = [...new Set(seg.flatMap((r) => (r.steps || []).filter((x) => txKind(x) === "letter").map(letterGist)))];
    const end = rows[b].at || rows[b].t?.at, dur = start.at && end ? duration((msOf(end) - msOf(start.at)) / 1000) : "";
    rows.splice(a, b - a + 1, { k: "callfold", key: `cf${key}`, at: start.at, call: true, callKey: key, called: start.called, reason: start.reason, dur, n: said.length, first: oneLine(said[0]?.t.prompt || "").slice(0, 120), letters });
  }
};
const letterOut = (st) => { try { return JSON.parse(st.out?.text || "null"); } catch { return null; } };
const LETTER_WAIT = { working: "working on it now", "needs-you": "it is waiting on you", "your-turn": "finished, no report yet", stopped: "stopped without a report", past: "stopped without a report" };
function SentLetter({ st }) {
  useLive();
  const i = st.input || {}, verb = st.tool.split("__").pop(), out = letterOut(st), failed = st.out?.error;
  const to = verb === "report" ? "the assistant" : out?.title || (verb === "start" ? i.name || i.preset || (i.dir && project(i.dir).name) || "a new session" : i.session) || "a session";
  const x = out?.ref && LIVE.find((y) => y.id === out.ref || y.sessionId?.startsWith(out.ref));
  const text = (verb === "start" ? i.prompt : i.text) || "";
  const back = i.report && out?.ref && TX_API?.answered(out.ref, st.time);
  const head = verb === "start" ? "Started" : verb === "report" ? "Reported to" : "To";
  const chips = [i.report && ["want", "wants a report"], i.approved && ["go", "your go-ahead"], i.wake && ["", "woke it"], i.worktree && ["", "own worktree"]].filter(Boolean);
  const where = verb === "start" && [i.host, i.dir && tilde(i.dir)].filter(Boolean).join(" ");
  const [all, setAll] = useState(false), long = text.length > 700 || text.split("\n").length > 10;
  const waitOn = !back && i.report && !failed && st.out && (x ? LETTER_WAIT[x.state] || "no answer yet" : "no answer yet");
  const tail = back ? html`<button class="vlink" onClick=${() => TX_API?.jump(back.i)}>answered ${hhmm(back.at)}</button>` : waitOn && html`<span class="snx ${x?.state === "working" ? "busy" : ""}">${waitOn}</span>`;
  return html`<div class="sent ${failed ? "bad" : ""}">
    <div class="snh"><span class="sni">${ICON.sent}</span><span class="sto">${head} ${x ? html`<a href=${`#/s/${keyOf(x)}`}>${to}</a>` : html`<b>${to}</b>`}</span>${where && html`<span class="snx">${where}</span>`}<span class="vat">${hhmm(st.time)}</span></div>
    ${(chips.length > 0 || tail) && html`<div class="sntags">${chips.map(([t, c]) => html`<span class="vchip ${t}">${c}</span>`)}${tail}</div>`}
    ${text && html`<div class="prose ptxt ${long && !all ? "clamp" : ""}" lang=${langOf(text)} dangerouslySetInnerHTML=${{ __html: Marked.parse(text, { breaks: true }) }}></div>`}
    ${long && html`<button class="kb more" onClick=${() => setAll(!all)}>${all ? "Show less" : "Show all"}</button>`}
    ${failed && html`<p class="snerr">Not sent: ${oneLine(st.out?.text)}</p>`}
  </div>`;
}

const TASK_MARK = { completed: ICON.check, failed: ICON.x, killed: ICON.stop, stopped: ICON.stop };
function TxEvent({ e, s, at, call, open }) {
  if (e.kind === "call-end") return html`<div class="chan end phone"><span>${ICON.phone}<b>Call ended</b>${call && html`<time>${duration((msOf(at) - msOf(call)) / 1000) || ""}</time>`}</span></div>`;
  if (e.kind === "line") return html`<p class="evt line">${chIcon(e.channel)} ${e.text}</p>`;
  if (e.kind === "stopped") return html`<p class="evt stopped">Stopped here</p>`;
  if (!e.task) return html`<p class="evt">${e.text}</p>`;
  return html`<${TaskCard} e=${e} s=${s} at=${at} open=${open} />`;
}

function TaskCard({ e, s, at, open }) {
  const [src, setSrc] = useState(null), [gone, setGone] = useState(false);
  const k = e.task, m = /^(.*?) "(.*)" (.*)$/.exec(e.text || "");
  const runs = useAgentRuns(s.sessionId), run = k.call ? runs?.find((a) => a.tool === k.call) : null;
  const from = () => TX_API?.reveal(`#ag-${CSS.escape(k.call)}`);
  const output = () => api(`/api/sessions/${s.sessionId}/ref/file?path=${encodeURIComponent(k.output)}`).then(() => open(k.output, { exact: true }), () => setGone(true));
  const more = () => (src ? setSrc(null) : api(`/api/sessions/${s.sessionId}/tasks/${encodeURIComponent(k.id)}`).then(setSrc, () => setSrc({ detail: "The command isn't in the transcript any more." })));
  return html`<div class="task ${k.status}">
    <span class="tm" aria-hidden="true">${TASK_MARK[k.status] || "•"}</span>
    <span class="tt">${m ? html`<span class="tkind">${m[1]}</span> <b>${m[2]}</b> <span class="tst">${m[3]}</span>` : e.text}</span>
    <span class="ta">${k.id && html`<button class="kb" onClick=${more}>${src ? "Hide" : "Command"}</button>`}${k.output && html`<button class="kb" disabled=${gone} onClick=${output}>${gone ? "Output cleaned up" : "Output"}</button>`}</span>
    ${src && html`<pre class="tsrc">${src.detail || src.description}</pre>`}
    ${(k.result || run?.started) && html`<div class="tres">
      ${run?.started && html`<p class="tmeta">ran ${duration((msOf(at) - msOf(run.started)) / 1000)}${run.steps ? `, ${plural(run.steps, "step")}` : ""}${document.getElementById(`ag-${k.call}`) && html` · <button class="vlink" onClick=${from}>where it started</button>`}</p>`}
      ${k.result && html`<details class="tout"><summary>${firstSentence(k.result)}</summary><div class="prose small" dangerouslySetInnerHTML=${{ __html: md(k.result) }}></div></details>`}
    </div>`}
  </div>`;
}

const PATH_CODE = '<code class="path[^"]*"[^>]*>[^<]+</code>';
const CITATION = new RegExp(`\\(${PATH_CODE}(?:,\\s*${PATH_CODE})*\\)`, "g");
const quietCitations = (h) => h.replace(CITATION, '<span class="cite">$&</span>');
function SessionPeek() {
  const [p, setP] = useState(null);
  useEffect(() => {
    if (!matchMedia("(hover: hover)").matches) return;
    let t = 0;
    const over = (e) => {
      const a = e.target.closest?.('.tx a[href^="#/s/"]');
      clearTimeout(t);
      if (!a) return setP(null);
      const k = decodeURIComponent(a.getAttribute("href").slice(4)), x = LIVE.find((y) => keyOf(y) === k || y.sessionId === k);
      if (!x) return;
      t = setTimeout(() => { const r = a.getBoundingClientRect(); setP({ x, left: Math.min(r.left, innerWidth - 340), top: r.bottom + 6 }); }, 250);
    };
    document.addEventListener("pointerover", over);
    return () => { clearTimeout(t); document.removeEventListener("pointerover", over); };
  }, []);
  if (!p) return null;
  const x = p.x, line = x.state === "working" ? doing(x) : headline(x);
  return html`<div class="speek" style=${`left:${Math.max(8, p.left)}px;top:${p.top}px`} role="tooltip"><div class="spt"><${StateBlock} s=${x} mini /><b>${x.title || "Untitled"}</b><span>${WORD[x.state] || x.state} · ${ago(x)}</span></div>${line && html`<p>${line}</p>`}</div>`;
}
function Prose({ text, id, cut, dest }) {
  useLive();
  const h = useMemo(() => {
    const at = cut ? cutAt(text, cut) : -1, render = (t) => linkSessions(quietCitations(md(t)), LIVE, keyOf);
    const body = at < 0 || !/\w/.test(text.slice(at)) ? render(text) : `${render(text.slice(0, at))}<p class="cutin">you cut in here</p><div class="unheard">${render(text.slice(at))}</div>`;
    let j = 0; return body.replace(/<h([1-4])>(.*?)<\/h\1>/gs, (_, n, inner) => `<h${n} id="${id}h${j++}">${inner}<button class="hlink" data-link aria-label="Copy a link to this heading" title="Copy a link to this heading">#</button></h${n}>`);
  }, [text, cut, LIVE_NAMES]);
  return html`<div class="prose" lang=${langOf(text)} dangerouslySetInnerHTML=${{ __html: h }}></div><div class="mbar"><button class="mcopy" data-copy data-src=${text}>Copy</button><button class="mcopy" data-link title="Copy a link to this reply">Link</button>${dest && html`<span class="dest">${dest}</span>`}</div>`;
}

function LiveRow({ s, step, since, steps }) {
  useNow(1000);
  const at = step?.time || since, ms = at ? Date.now() - new Date(at) : 0, m = step && stepNote(step, s);
  const what = m ? `${m.v} ${m.c}` : s.activity ? doing(s) : "Thinking";
  return html`<div class="work" id="tx-now" role="status"><i class="pulse" aria-hidden="true"></i><span class="doing">${what}</span>
    <span class="el">${[ms >= 1000 && duration(ms / 1000), steps > 0 && `step ${steps}`].filter(Boolean).join(", ")}</span></div>`;
}

function Since({ mark, rows, s, jump }) {
  const after = (rows || []).filter(Boolean), q = s.asks?.length > 0 && s.state === "needs-you";
  const replies = after.filter((r) => r.answer).length;
  const files = new Set(after.flatMap((r) => (r.steps || []).filter((x) => txKind(x) === "edit" && !x.out?.error).map((x) => x.input.file_path))).size;
  const pages = after.flatMap((r) => r.steps || []).filter((x) => x.badge?.kind === "show").length;
  const counts = [replies && (replies === 1 ? "a reply" : `${replies} replies`), files && plural(files, "file"), pages && (pages === 1 ? "a page" : `${pages} pages`), q && "1 question"].filter(Boolean).join(", ");
  const sum = s.summary, sumAt = sum?.at ? Date.parse(sum.at) || 0 : 0, last = Math.max(0, ...after.map((r) => Date.parse(r.at || 0) || 0));
  const now = s.state === "working" && s.activity ? `Now ${doing(s).replace(/^./, (c) => c.toLowerCase())}` : "";
  const gist = (sum?.status || "").replace(/^[A-Z][a-z]+:\s+/, "") || clipWords(now, 90);
  return html`<div class="snc" id="since" tabindex="-1"><h2 class="l">Since you last looked, ${hhmm(mark)}</h2>
    ${(gist || counts) && html`<p class="cu">${gist && html`<b>${gist.replace(/^./, (c) => c.toUpperCase())}${/[.!?]$/.test(gist) ? "" : "."}</b> `}${counts && counts.replace(/^./, (c) => c.toUpperCase()) + "."}</p>`}
    ${sumAt > 0 && last > sumAt && html`<p class="sm">Summary from ${hhmm(sum.at)}; what came after is not in it yet.</p>`}
    ${q && html`<div class="acts"><button class="btn" onClick=${jump} title=${tip("unseen", "Jump to the question")}>Jump to the question</button></div>`}</div>`;
}

function Queued({ p, edit, cancel, now, undo }) {
  if (p.state === "cancelled") return html`<div class="queued gone" role="status"><span>Cancelled. It was not sent.</span><button class="btn" onClick=${undo}>Undo</button></div>`;
  return html`<div class="queued" role="status"><div class="qh"><b>Queued</b><span>sends when it stops</span>
    <span class="acts"><button class="btn" onClick=${now}>Send now</button><button class="btn" onClick=${edit}>Edit</button><button class="btn" onClick=${cancel}>Cancel</button></span></div>
    <p class="qt">${unpathed(p.text)}</p>${(p.text.match(UPLOADED) || []).length > 0 && html`<p class="qa">${plural((p.text.match(UPLOADED) || []).length, "attachment")}</p>`}</div>`;
}

function WaitingMessage({ w }) {
  const [all, setAll] = useState(false);
  const text = cleanPrompt(w.text), images = (w.text.match(/\[Image #\d+\]/g) || []).length;
  const long = text.length > 600 || text.split("\n").length > 8;
  return html`<div class="queued" role="status"><div class="qh"><b>Waiting</b><span>sent ${hhmm(w.at)}, Claude reads it when its current step ends</span></div>
    ${text && html`<p class=${long && !all ? "qt clamp" : "qt"}>${text}</p>`}${images > 0 && html`<p class="qa">${plural(images, "image")}</p>`}
    ${long && html`<button class="kb more" onClick=${() => setAll(!all)}>${all ? "Show less" : "Show all"}</button>`}</div>`;
}

function SentState({ p, host, retry, edit }) {
  if (p.state === "sending") return html`<div class="mst" role="status"><span class="slow">Sending to ${host || "the host"}…</span></div>`;
  if (p.state === "failed") return html`<div class="mst failed" role="alert"><b>Not sent.</b> <span>${p.err}</span><span class="acts"><button class="btn" onClick=${retry}>Retry</button><button class="btn" onClick=${edit}>Edit</button></span></div>`;
  return html`<div class="mst" role="status"><b>Sent ${hhmm(new Date(p.sent || p.at).toISOString())}.</b> ${p.queued ? "Claude reads it after its current step." : "It has it."}</div>`;
}
const HEADS = new Map();
const headsOf = (src) => {
  if (!src) return [];
  if (HEADS.has(src)) return HEADS.get(src);
  const heads = [];
  Marked.walkTokens(Marked.lexer(src), (t) => { if (t.type === "heading" && t.depth <= 4) heads.push(plain(t.text)); });
  if (HEADS.size > 500) HEADS.clear();
  HEADS.set(src, heads);
  return heads;
};

let TX_API = null;
const msOf = (at) => (at ? Date.parse(at) || 0 : 0);

const TOUCH = matchMedia("(hover: none)").matches;
const ISSUE_WORD = { open: "Open", closed: "Closed", merged: "Merged", draft: "Draft" };
function IssuePop({ pop, keep, leave, close }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") close(); };
    const away = (e) => { if (!e.target.closest?.(".ipop")) close(); };
    addEventListener("keydown", k, true);
    addEventListener("scroll", close, true);
    if (pop.stay) setTimeout(() => addEventListener("pointerdown", away, true));
    return () => { removeEventListener("keydown", k, true); removeEventListener("scroll", close, true); removeEventListener("pointerdown", away, true); };
  }, []);
  const i = pop.info, width = Math.min(340, innerWidth - 24), left = Math.max(12, Math.min(pop.at.left, innerWidth - width - 12));
  const below = pop.at.bottom + 160 < innerHeight, place = below ? `top: ${pop.at.bottom + 6}px` : `bottom: ${innerHeight - pop.at.top + 6}px`;
  if (!i && !pop.stay) return null;
  return html`<div class="ipop" role="tooltip" style=${`left: ${left}px; width: ${width}px; ${place}`} onPointerEnter=${keep} onPointerLeave=${leave}>
    <div class="h"><span>${pop.name}</span>${i && html`<span class="st ${i.state}">${ISSUE_WORD[i.state] || i.state}${i.kind === "pr" ? " PR" : ""}</span>`}</div>
    ${i ? html`<div class="t">${i.title}</div>` : !pop.none && html`<div class="t dim">Reading…</div>`}
    ${pop.stay && html`<button class="btn" onClick=${() => { openOut(pop.url); close(); }}>Open on GitHub</button>`}
  </div>`;
}

function Transcript({ s, say, resume, busy, cmp = {} }) {
  const [ref, setRef] = useState(null), [repo, setRepo] = useState(""), [issuePop, setIssuePop] = useState(null), popTimer = useRef(null);
  useEffect(() => {
    setRef(null); setRepo("");
    let on = true;
    api(`/api/sessions/${s.sessionId}/ref/repo`).then((r) => on && setRepo(r.repo || ""), () => {});
    return () => { on = false; };
  }, [s.sessionId]);
  const openFileRef = async (text, opts = {}) => {
    const r = opts.exact !== undefined ? { path: text, line: +opts.line || 0, end: +opts.end || 0 } : fileRef(text);
    if (!r) return;
    try {
      const f = await api(`/api/sessions/${s.sessionId}/ref/file?path=${encodeURIComponent(r.path)}`);
      setRef({ file: { ...f, line: r.line, end: r.end, kind: r.line && f.kind === "markdown" ? "text" : f.kind } });
    } catch (e) { say(e.message); }
  };
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
  const placeFrom = useRef(null), reflowed = useRef(false), composerFocus = useRef(() => {});
  const focusInput = useRef(() => {}), uploadRef = useRef(null), findQ = useRef(""), askKey = useRef(null), mark = useRef(undefined);
  const live = s.attachable || s.harness === "opencode";
  const working = s.state === "working" && !s.turnDone;
  const asking = s.state === "needs-you" && s.asks?.length > 0 ? s.asks[0] : null;
  const turns = idx || [];
  const [serverWaiting, setServerWaiting] = useState([]);
  const waiting = s.state === "working" || s.state === "needs-you" ? serverWaiting : [];
  const stream = useHubStream(s, () => loadIdx());
  const setContents = (v) => { setContentsRaw(v); txStore.set("contents", v); };
  const [zen, setZenRaw] = useState(false);
  const notePlace = () => {
    const sc = box.current, top = sc?.getBoundingClientRect().top;
    const el = sc && !atEnd.current && [...sc.querySelectorAll(".prose > *, .lead, .fold")].find((e) => e.getBoundingClientRect().bottom > top);
    const r = el && el.getBoundingClientRect();
    placeFrom.current = el ? { el, into: (top - r.top) / r.height } : null;
    reflowed.current = true;
    hold.current = null;
  };
  const restorePlace = () => {
    const from = placeFrom.current, sc = box.current;
    placeFrom.current = null;
    if (from?.el.isConnected && sc) { const r = from.el.getBoundingClientRect(); sc.scrollTop += r.top - sc.getBoundingClientRect().top + from.into * r.height; }
    requestAnimationFrame(() => requestAnimationFrame(() => { reflowed.current = false; }));
  };
  const setZen = (on) => {
    notePlace();
    if (!on) setPop((x) => (x === "look" ? null : x));
    setZenRaw(on);
    zenHistory(on);
  };
  focusInput.current = () => {
    if (!zen) return composerFocus.current();
    setZen(false);
    requestAnimationFrame(() => composerFocus.current());
  };
  useLayoutEffect(() => {
    document.body.classList.toggle("zen", zen);
    restorePlace();
    return () => document.body.classList.remove("zen");
  }, [zen]);
  useLayoutEffect(() => {
    if (zen && prefs.paper) document.body.dataset.paper = prefs.paper;
    return () => { delete document.body.dataset.paper; };
  }, [zen, prefs.paper]);
  useZenBack(zen, () => setZen(false));
  const glide = useRef(null);
  useEffect(() => {
    if (!zen || !box.current) return;
    const g = glide.current = glider(box.current);
    const up = (e) => g.release(e.code);
    addEventListener("keyup", up);
    addEventListener("blur", g.stop);
    return () => { g.stop(); glide.current = null; removeEventListener("keyup", up); removeEventListener("blur", g.stop); };
  }, [zen]);
  useKeyLayer((e) => {
    if (typingIn(e.target)) return false;
    if (GLIDE_KEYS[e.key] && !e.shiftKey && glide.current) { hold.current = null; glide.current.press(GLIDE_KEYS[e.key], e.code, e.repeat); return true; }
    if (e.key === "a") return setPop(pop === "look" ? null : "look"), true;
    if (e.key === "-" || e.key === "=" || e.key === "+") return txPrefs.set({ size: Math.max(0, Math.min(4, prefs.size + (e.key === "-" ? -1 : 1))) }), true;
    if (e.key !== "z" && (e.key !== "Escape" || pop || shot || sel)) return false;
    setZen(false);
    return true;
  }, zen);

  const loadIdx = async () => {
    try {
      const r = await api(`/api/sessions/${sid}/turns`);
      setIdx(r.turns || []);
      setServerWaiting(r.waiting || []);
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
    setIdx(null); setServerWaiting([]); setBodies({}); setOpened(new Set()); setExpanded(new Set()); setPendingRaw(pendingOf(sid)); setQuotes([]);
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
  const [calls, setCalls] = useState(() => new Set());
  const flip = (k) => setExpanded((o) => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n; });

  useEffect(() => { for (let i = level === 3 ? 0 : firstOpen; i < turns.length; i++) if (isOpen(i)) need(i); }, [idx, firstOpen, level]);
  useEffect(() => { opened.forEach((i) => need(i)); }, [opened]);
  useEffect(() => {
    if (!pending.length || !idx) return;
    const head = (p) => plain(unpathed(p.text)).slice(0, 24);
    const said = (t) => plain(cleanPrompt(t.prompt));
    const there = (p) => waiting.some((w) => head(p) ? plain(cleanPrompt(w.text)).startsWith(head(p)) : /\[Image #\d+\]/.test(w.text)) || turns.some((t) => (t.at && new Date(t.at) >= p.at - 60000 && (head(p) ? said(t).startsWith(head(p)) : t.images > 0 || /\[Image #\d+\]/.test(t.prompt))) || (head(p) && (t.notes || []).some((n) => plain(n).startsWith(head(p)))));
    const passed = (p) => turns.some((t) => t.at && new Date(t.at) > p.at + 60000);
    const stale = (p) => passed(p) || (!working && Date.now() - p.at > 5 * 60e3);
    const gone = (p) => (p.state === "sending" || p.state === "sent") && (there(p) || (p.state === "sent" && stale(p)));
    if (pending.some(gone)) setPending((ps) => ps.filter((p) => !gone(p)));
  }, [idx, pending, waiting]);

  useLayoutEffect(() => {
    const f = TX_FACES[prefs.face] || TX_FACES.text, st = box.current?.parentElement?.style;
    if (!st) return;
    st.setProperty("--rf", f.css);
    st.setProperty("--rs", `${f.sizes[prefs.size]}px`);
    st.setProperty("--rl", f.lh);
    st.setProperty("--rg", f.weight || 400);
    st.setProperty("--ro", f.optical || "auto");
    st.setProperty("--rw", `${TX_MEASURES[prefs.width]}px`);
    st.setProperty("--rz", TX_SPACINGS[prefs.space]);
    restorePlace();
  }, [prefs, idx !== null]);
  useEffect(() => {
    const f = (e) => { notePlace(); setPrefsRaw(e.detail); };
    addEventListener("atc-txprefs", f);
    return () => removeEventListener("atc-txprefs", f);
  }, []);

  const deliver = async (p) => {
    setPending((ps) => [...ps.filter((x) => x.id !== p.id), { ...p, state: "sending", queued: working }]);
    try {
      await api(`/api/sessions/${s.id || sid}/send`, { method: "POST", body: { text: p.text, suggested: p.suggested } });
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
    const took = (r) => s.answered && askId({ id: s.answered.ask, key: s.answered.key }) === r.ak && Date.parse(s.answered.at) >= Date.parse(r.at);
    for (const [k, r] of ANSWERS) if (r.sid === sid && ((r.st === "sent" && ((s.asks?.[0] && askId(s.asks[0])) !== r.ak || s.state !== "needs-you")) || (r.st === "failed" && took(r)))) { ANSWERS.set(k, { ...r, st: "accepted" }); moved = true; }
    if (moved) syncTell();
  }, [s.asks?.[0] && askId(s.asks[0]), s.state, s.answered?.at]);

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
  useLayoutEffect(() => { if (landed.current) letGo(); }, [turns.at(-1)?.to]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !idx) return;
    if (!landed.current && ready) {
      landed.current = true;
      const latest = [...el.querySelectorAll("[data-you], [data-said]")].pop();
      hold.current = el.querySelector("#since") ? "#since" : latest ? `#${CSS.escape(latest.id)}` : null;
      settle();
      if (el.scrollHeight <= el.clientHeight) atEnd.current = true;
      document.fonts.ready.then(() => requestAnimationFrame(settle));
      if (atEnd.current) markLooked(s);
      if (!touch && document.hasFocus() && document.activeElement === document.body) el.focus({ preventScroll: true });
    } else if (landed.current) settle();
  }, [idx, bodies, ready, pending]);
  useEffect(() => { if (landed.current && atEnd.current) markLooked(s); }, [s.updated]);
  useEffect(() => { if (!touch && landed.current && !pop && document.hasFocus() && document.activeElement === document.body) box.current?.focus({ preventScroll: true }); });

  useEffect(() => {
    const el = box.current, inner = el?.querySelector(".read");
    if (!inner) return;
    let h = 0;
    const ro = new ResizeObserver(() => {
      if (landed.current && (hold.current !== null || atEnd.current)) settle();
      else if (landed.current && el.scrollHeight > h + 40 && !reflowed.current) { setFresh((n) => n + 1); setBelow(farFromEnd(el)); }
      h = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [idx !== null]);

  useEffect(() => {
    if (!pop) return;
    const off = (e) => !e.target.closest(".pop, .zenaa") && setPop(null);
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
    say(`Nothing new since ${hhmm(mark.current || new Date().toISOString()) || "you last looked"}.`);
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
  const spotDone = useRef("");
  const goSpot = () => {
    const spot = spotOf(location.hash);
    if (!spot || spot.sid !== s.sessionId || !turns[spot.turn] || spotDone.current === location.hash) return;
    spotDone.current = location.hash;
    go(spot.turn, true);
    if (!spot.heading) return;
    const find = (n = 0) => {
      const start = box.current?.querySelector(`#tx${spot.turn}`), end = box.current?.querySelector(`#tx${spot.turn + 1}`);
      const el = start && [...box.current.querySelectorAll(".prose :is(h1, h2, h3, h4)")].find((h) => (start.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) && (!end || end.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) && headingSlug([...h.childNodes].filter((x) => !x.classList?.contains("hlink")).map((x) => x.textContent).join("")) === spot.heading);
      if (el) { scrollTo(el, false); el.classList.add("spot"); setTimeout(() => el.classList.remove("spot"), 1800); }
      else if (n < 30) setTimeout(() => find(n + 1), 150);
    };
    find();
  };
  useEffect(() => { goSpot(); addEventListener("hashchange", goSpot); return () => removeEventListener("hashchange", goSpot); });
  const ends = new Map(turns.flatMap((t) => (t.ended || []).map((e) => [e.call, e])));
  const bgEnds = new Map([...turns, ...Object.values(bodies).flatMap((b) => b.items.filter((x) => x.t === "event").map((x) => ({ prompt: x.text, task: x.task })))]
    .filter((t) => bgCmd(t) && t.task.call).map((t) => [t.task.call, bgEnd(t)]));
  const reveal = (sel) => requestAnimationFrame(() => { if (!box.current?.querySelector(sel)) return; hold.current = sel; atEnd.current = false; settle(); });
  TX_API = { ended: (call) => ends.get(call), bg: (call) => bgEnds.get(call), reveal, jump: (i) => { openTurn(i); reveal(`#tx${i}`); },
    answered: (ref, at) => { const i = turns.findIndex((t) => t.via?.ref === ref && msOf(t.at) > msOf(at)); return i < 0 ? null : { i, at: turns[i].at }; },
    asked: (ref, at) => { for (let i = turns.length - 1; i >= 0; i--) { if (msOf(turns[i].at) > msOf(at)) continue; const st = txSteps(bodies[turns[i].from]?.items || []).findLast((x) => txKind(x) === "letter" && letterOut(x)?.ref === ref && x.input.report); if (st) return { i, at: st.time || turns[i].at }; } return null; },
    level: () => setLevel((level % 3) + 1), find: () => { findQ.current = ""; setPop("find"); }, contents: () => setContents(!contents), zen: () => setZen(!zen) };
  useEffect(() => () => { TX_API = null; }, []);

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector(".veil, .pghome, .palone, .keys-ov, .sheet, .viewer")) return;
      const k = e.key;
      if (/^[1-9]$/.test(k)) { if (askKey.current && t.closest?.(".ask")) { e.preventDefault(); askKey.current(+k); } }
      else if (k === "J" || k === "K") { e.preventDefault(); step("[data-stop]", k === "J" ? 1 : -1); }
      else if (k === "N") { e.preventDefault(); nextUnseen(); }
      else if (k === "c") { e.preventDefault(); setContents(!contents); }
      else if (k === "l") { e.preventDefault(); setLevel((level % 3) + 1); }
      else if (k === "Enter" && live && !t.closest?.("button, a, [role=button], .ask, [data-ask]")) { e.preventDefault(); focusInput.current(); }
      else if (k === "Enter" && !zen && !live && resume && s.kind !== "interactive" && !t.closest?.("button, a, [role=button]")) { e.preventDefault(); resume(); }
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
  }, [live, contents, s, level, zen]);

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
  const askedQs = new Set(), shownAns = new Set(), shownFail = new Set();
  let callAt = null, lastModel = "", lastDay = "";
  turns.forEach((t, i) => {
    const b = bodies[t.from], open = isOpen(i), prev = turns[i - 1];
    const day = t.at && new Date(t.at).toDateString();
    if (day && day !== lastDay && (lastDay || turns.some((x) => x.at && new Date(x.at).toDateString() !== day))) rows.push({ k: "day", key: `d${t.from}`, text: stamp(t.at) });
    else if (prev && t.at && msOf(t.at) - msOf(prev.end || prev.at) > TX_GAP) rows.push({ k: "gap", key: `g${t.from}`, text: gapText(prev.end || prev.at, t.at) });
    if (day) lastDay = day;
    if (t.model && lastModel && model(t.model) !== model(lastModel)) rows.push({ k: "model", key: `m${t.from}`, text: model(t.model) });
    if (t.model) lastModel = t.model;
    if (t.mark?.heard) { const said = rows.findLast((x) => x.k === "say" && x.text); if (said) said.cut = t.mark.heard; }
    if (t.switch && t.channel) {
      callAt = t.channel === "phone" ? t.at : null;
      if (i > 0 || t.channel !== "atc") rows.push({ k: "chan", key: `c${t.from}`, at: t.at, ch: t.channel, call: !!callAt, called: t.mark?.called, reason: t.mark?.reason });
    }
    const call = !!callAt, callFrom = callAt;
    if (t.kind === "call-end") callAt = null;
    const bg = bgCmd(t) && bgEnd(t), quietBg = bg && (bg.how !== "failed" || shownFail.has(bg.id));
    if (quietBg && !open && !t.reply) return;
    if (!open) {
      rows.push({ k: "fold", key: `f${t.from}`, at: t.at, i, t, call, callFrom });
      if (t.callEnd && callAt) { rows.push({ k: "evt", key: `ce${t.from}`, at: t.callEnd, kind: "call-end", call, callFrom }); callAt = null; }
      return;
    }
    if (bg) { rows.push({ k: quietBg ? "anchor" : "bgfail", key: `y${t.from}`, at: t.at, i, bg, anchor: true, call, callFrom }); shownFail.add(bg.id); }
    else rows.push({ k: t.notice ? "notice" : t.partial ? "partial" : t.kind === "wake" || t.kind === "restart" ? t.kind : "you", key: `y${t.from}`, at: t.at, i, t, b, call, callFrom });
    if (!b) return (t.steps || t.reply) && rows.push({ k: "skel", key: `s${t.from}`, i, call });
    agentRows(b).forEach((r, j) => {
      if (t.notice && j === 0 && r.k === "evt") return;
      const ebg = r.k === "evt" && bgCmd({ prompt: r.text, task: r.task }) && bgEnd({ prompt: r.text, task: r.task });
      if (ebg) { if (ebg.how === "failed" && !shownFail.has(ebg.id)) rows.push({ k: "bgfail", key: `${t.from}:${j}`, at: r.at, i, bg: ebg, call, callFrom }); shownFail.add(ebg.id); return; }
      (r.steps || []).filter((x) => x.tool === "AskUserQuestion").forEach((x) => { (x.input.questions || []).forEach((q) => askedQs.add(q.question)); Object.values(answersOf(x)).forEach((a) => shownAns.add(a)); });
      rows.push({ ...r, key: `${t.from}:${j}`, i, live: working && i === turns.length - 1, call, callFrom, dest: r.answer ? replyDest(t) : "" });
      if (r.kind === "call-end") callAt = null;
    });
  });
  foldCalls(rows, calls, bodies);
  for (const r of ANSWERS.values()) {
    if (r.sid !== sid || (asking && r.ak === askId(asking)) || askedQs.has(r.q)) continue;
    const at = msOf(r.at), j = rows.findIndex((x) => msOf(x.at) > at);
    rows.splice(j < 0 ? rows.length : j, 0, { k: "answered", key: `a${r.id}`, at: r.at, rec: r });
  }
  const other = answeredElsewhere(s);
  if (other && !(asking && askId({ id: other.ask, key: other.key }) === askId(asking)) && !shownAns.has(other.what)) {
    const at = msOf(other.at), j = rows.findIndex((x) => msOf(x.at) > at);
    rows.splice(j < 0 ? rows.length : j, 0, { k: "elsewhere", key: `e${other.ask}`, at: other.at, x: other });
  }
  pending.filter((p) => p.state !== "queued" && p.state !== "cancelled").forEach((p) => rows.push({ k: "sent", key: `p${p.id}`, at: new Date(p.at).toISOString(), p }));
  if (stream?.text) rows.push({ k: "stream", key: "stream", st: stream });
  if (working && !stream?.text) rows.push({ k: "live", key: "live", at: new Date().toISOString() });
  if (asking) rows.push({ k: "ask", key: `q${askId(asking)}`, at: s.updated, a: asking });
  const di = markMs ? rows.findIndex((r) => r.at && r.k !== "live" && msOf(r.at) > markMs) : -1;
  if (di > 0) rows.splice(di, 0, { k: "since", key: "since", at: mark.current, after: rows.slice(di) });
  waiting.forEach((w, j) => rows.push({ k: "waiting", key: `w${w.at}:${j}`, w }));
  queued.forEach((p) => rows.push({ k: "queued", key: `qd${p.id}`, p }));

  const toc = [];
  for (const r of rows) {
    if (r.k === "you" || r.k === "fold") toc.push({ id: `tx${r.i}`, at: hhmm(r.at), text: plain(cleanPrompt(r.t.prompt)) || "Image", folded: r.k === "fold", kids: [] });
    else if (r.k === "since") toc.push({ id: "since", at: hhmm(r.at), text: "Since you last looked", kids: [] });
    else if (r.k === "say" && r.answer && toc.length) headsOf(r.text).forEach((h, j) => toc[toc.length - 1].kids.push({ id: `h-${r.key.replace(":", "-")}h${j}`, text: h }));
    else if (r.k === "ask" && toc.length) toc[toc.length - 1].kids.push({ id: "pending-ask", text: "Waiting on you", cls: "q" });
    else if (r.k === "live" && toc.length) toc[toc.length - 1].kids.push({ id: "tx-now", text: "now", cls: "now" });
  }

  let shownClock = "", shownDay = new Date().toDateString();
  const clock = (at, force) => {
    if (!at) return "";
    const c = hhmm(at), d = new Date(at).toDateString(), day = d !== shownDay;
    if (!force && !day && c === shownClock) return "";
    shownClock = c; shownDay = d;
    return day ? stamp(at) : c;
  };
  const cell = (r) => {
    const gk = `g${r.key}`, gOpen = level === 3 ? !expanded.has(gk) : expanded.has(gk);
    switch (r.k) {
      case "fold": {
        const f = (r.t.files || []).filter((x) => !scratch(x.path)).sort((a, b) => b.add + b.del - a.add - a.del)[0];
        const work = [r.t.steps > 0 && plural(r.t.steps, "step"), f && `${relPath(f.path, s)} +${f.add}${f.del ? ` -${f.del}` : ""}`, (r.t.files || []).length > 1 && `${r.t.files.length - 1} more`].filter(Boolean).join(", ");
        const who = r.t.notice ? "" : r.t.mark?.called && !r.t.prompt ? "it called you" : r.t.kind === "wake" ? `schedule, every ${r.t.mark.every}` : r.t.kind === "restart" ? "started over" : r.t.via ? viaName(r.t.via) : youOn(r.t.channel);
        const bare = r.t.notice || (r.t.mark?.called && !r.t.prompt);
        if (r.t.via?.wa?.groupId) WA_GROUPS.set(r.t.via.wa.groupId, r.t.via.wa.group);
        return html`${who && html`<h2 class="sr">${who}, ${hhmm(r.at)}</h2>`}<button class="fold ${bare ? "ntc" : ""}" id=${`tx${r.i}`} data-stop data-you=${who ? "" : null} aria-expanded="false" title="Open this turn" onClick=${() => openTurn(r.i)}>
          <span class="fy"><span class="lead-at">${who} ${clock(r.at, true)}</span><span class="fq">${r.t.partial ? "Continued from earlier" : plain(cleanPrompt(r.t.prompt)) || (bare ? "" : "Image")}</span></span>
          <span class="g">${r.t.reply ? firstSentence(r.t.reply) : waReplyGist(r.t) || "No reply."} ${work && html`<b>${work}</b>`}</span></button>`;
      }
      case "wake": return html`<div class="wake" id=${`tx${r.i}`} data-stop><details><summary>${ICON.clock}<b>Scheduled wake-up</b><span>every ${r.t.mark.every}</span><time>${clock(r.at, true)}</time></summary>
          <div class="prose ptxt" dangerouslySetInnerHTML=${{ __html: Marked.parse(cleanPrompt(r.b?.prompt ?? r.t.prompt), { breaks: true }) }}></div></details></div>`;
      case "restart": {
        const prev = r.t.mark.prev, whole = prev.length > 8;
        return html`<div id=${`tx${r.i}`} data-stop><div class="chan restart"><span><b>Started over</b><time>${clock(r.at, true)}</time></span></div>
          <details class="handover"><summary>The handover note${whole ? html`, from <a href=${`#/s/${prev}`} onClick=${(e) => e.stopPropagation()}>the conversation before</a>` : ""}</summary>
          <div class="prose ptxt" dangerouslySetInnerHTML=${{ __html: Marked.parse(cleanPrompt(r.b?.prompt ?? r.t.prompt), { breaks: true }) }}></div></details></div>`;
      }
      case "anchor": return html`<div id=${`tx${r.i}`}></div>`;
      case "bgfail": return html`<div class="bgfail" id=${r.anchor ? `tx${r.i}` : null} role="note"><span class="bx" aria-hidden="true">${ICON.x}</span><span class="bt"><code>${r.bg.cmd.replace(/^cd \S+ && /, "") || "A background command"}</code><span>failed${r.bg.exit != null ? `, exit ${r.bg.exit}` : ""}</span></span>${r.bg.output && html`<button class="vlink" onClick=${() => openFileRef(r.bg.output, { exact: true })}>Output</button>`}</div>`;
      case "gap": return html`<div class="tgap"><span>${r.text}</span></div>`;
      case "model": return html`<div class="tgap model"><span>now on ${r.text}</span></div>`;
      case "you": {
        if (r.t.mark?.called && !(r.b?.prompt ?? r.t.prompt)) return html`<div id=${`tx${r.i}`} data-stop></div>`;
        const first = rows[0] === r;
        const via = r.b ? r.b.via : r.t.via;
        return html`<div class="sec ${first ? "first" : ""}" id=${`tx${r.i}`} data-stop data-you><h2 class="sr">${via ? viaName(via) : "you"}, ${hhmm(r.at)}</h2>
          <${Lead} at=${clock(r.at, true)} when=${r.at} text=${cleanPrompt(r.b?.prompt ?? r.t.prompt).trim()} images=${r.b?.images} via=${via} channel=${r.t.channel} pastes=${r.b?.pastes} mark=${r.t.mark} /></div>`;
      }
      case "notice": return !zen && html`<div id=${`tx${r.i}`}><${TxEvent} e=${{ text: plain(cleanPrompt(r.t.prompt)), task: r.b?.items?.find((x) => x.t === "event" && x.task)?.task || r.t.task, kind: r.t.kind, channel: r.t.channel }} s=${s} at=${r.at} call=${r.callFrom} open=${openFileRef} /></div>`;
      case "chan": return html`<div class="chan ${r.ch}"><span>${chIcon(r.ch)}<b>${r.ch === "phone" ? r.called ? "It called you" : "Call" : chName(r.ch)}</b><time>${clock(r.at, true)}</time>${r.callKey && html`<button class="cfold" title="Fold the call" onClick=${() => setCalls((c) => { const n = new Set(c); n.delete(r.callKey); return n; })}>fold</button>`}</span></div>${r.reason && html`<p class="chwhy">${r.reason}</p>`}`;
      case "callfold": return html`<button class="callfold" onClick=${() => setCalls((c) => new Set(c).add(r.callKey))} title="Open the call">
          <span class="cfh">${ICON.phone}<b>${r.called ? "It called you" : "Call"}</b><time>${clock(r.at, true)}</time><span>${[r.dur, plural(r.n, "exchange")].filter(Boolean).join(" · ")}</span><span class="chev" aria-hidden="true"></span></span>
          ${r.reason && html`<span class="cfl">${r.reason}</span>`}${r.first && html`<span class="cfl q">“${r.first}”</span>`}${r.letters.length > 0 && html`<span class="cfl">${r.letters.join(", ")}</span>`}</button>`;
      case "day": return html`<div class="tgap day"><span>${r.text}</span></div>`;
      case "partial": return html`<p class="evt" id=${`tx${r.i}`}>This turn started before what is loaded here.</p>`;
      case "skel": return html`<div class="skel" aria-label="Loading"><i></i><i></i><i></i></div>`;
      case "say": case "steps":
        return html`${r.answer && html`<h2 class="sr">${s.agent ? `@${s.agent}` : "agent"}, ${hhmm(r.at)}</h2>`}${r.steps && html`${!zen && html`<${InlineSteps} steps=${r.steps} s=${s} open=${gOpen} toggle=${() => flip(gk)} />`}<${GroupBody} steps=${zen ? r.steps.filter((x) => txKind(x) === "ask" || txKind(x) === "letter") : r.steps} s=${s} open=${gOpen && !zen} zoom=${setShot} live=${r.live && !r.text} />`}
            ${r.text && html`<div id=${`said-${r.key}`} data-said data-stop=${r.answer ? "" : null}>${(() => { const c = !zen && clock(r.textAt || r.at); return c && html`<time class="rclk" datetime=${r.textAt || r.at}>${c}</time>`; })()}<${Prose} text=${r.text} cut=${r.cut} dest=${r.dest} id=${`h-${r.key.replace(":", "-")}`} /></div>`}`;
      case "evt": return !zen && html`<${TxEvent} e=${r} s=${s} at=${r.at} call=${r.callFrom} open=${openFileRef} />`;
      case "note": return html`<${Lead} at=${clock(r.at, true)} when=${r.at} text=${r.text} via=${r.via} pastes=${r.pastes} />`;
      case "answered": {
        const rec = r.rec;
        return html`<${AnsweredLine} q=${rec.q} cmd=${rec.cmd} options=${rec.options || []} chosen=${rec.i ? [rec.i - 1] : []}
          line=${html`${askHead(rec)}, ${hhmm(rec.at)} <span class="from">(from this screen)</span>`} state=${rec.st !== "accepted" && html`<${AskState} rec=${rec} host=${s.host} retry=${() => answerAsk(s, { id: rec.id, key: rec.ak }, rec)} />`} />`;
      }
      case "elsewhere": return html`<div class="ask line"><p class="adl"><span>You answered <b>${r.x.what}</b>, ${hhmm(r.x.at)}${fromWhere(r.x)}</span></p></div>`;
      case "since": return html`<${Since} mark=${r.at} rows=${r.after} s=${s} jump=${nextUnseen} />`;
      case "sent": {
        const first = rows[0] === r;
        return html`<div class="sec ${first ? "first" : ""}" data-stop data-you id=${`tx-p${r.p.id}`}>
          <${Lead} at=${clock(r.at, true)} text=${unpathed(r.p.text)} files=${(r.p.text.match(UPLOADED) || []).length} />
          <${SentState} p=${r.p} host=${s.host} retry=${() => deliver(r.p)} edit=${() => { setPending((ps) => ps.filter((x) => x.id !== r.p.id)); setDraft((d) => [unpathed(r.p.text), d].filter(Boolean).join("\n")); focusInput.current(); }} /></div>`;
      }
      case "stream": return html`${HUB_CHANNEL[r.st.channel] && html`<p class="evt">${HUB_CHANNEL[r.st.channel]}</p>`}<div class="prose live" dangerouslySetInnerHTML=${{ __html: quietCitations(md(r.st.text)) + '<span class="caret"></span>' }}></div>`;
      case "live": return html`<${LiveRow} s=${s} step=${running} since=${lastAt(lastBody) || last?.end} steps=${last?.steps || 0} />`;
      case "ask": return html`<${Ask} s=${s} a=${r.a} keyRef=${askKey} onType=${() => focusInput.current()} />`;
      case "waiting": return html`<${WaitingMessage} w=${r.w} />`;
      case "queued": return html`<${Queued} p=${r.p} now=${() => deliver(r.p)}
        edit=${() => { setPending((ps) => ps.filter((x) => x.id !== r.p.id)); setDraft((d) => [d, unpathed(r.p.text)].filter(Boolean).join("\n")); focusInput.current(); }}
        cancel=${() => { setPending((ps) => ps.map((x) => (x.id === r.p.id ? { ...x, state: "cancelled" } : x))); setTimeout(() => setPending((ps) => ps.filter((x) => !(x.id === r.p.id && x.state === "cancelled"))), 8000); }}
        undo=${() => setPending((ps) => ps.map((x) => (x.id === r.p.id ? { ...x, state: "queued" } : x)))} />`;
    }
    return null;
  };

  const dropIn = (e) => { if (live && e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDrop(true); } };
  const repoName = repo.replace(/^https:\/\/github\.com\//, "");
  const showIssue = (el, stay) => {
    const name = el.dataset.iss || `${repoName}#${el.dataset.issue}`, [r, n] = name.split("#");
    const url = el.getAttribute("href") || `https://github.com/${r}/issues/${n}`, at = el.getBoundingClientRect();
    clearTimeout(popTimer.current);
    setIssuePop({ name, url, at: { left: at.left, top: at.top, bottom: at.bottom }, info: null, stay });
    api(`/api/sessions/${s.sessionId}/ref/issue?repo=${encodeURIComponent(r)}&n=${n}`).then(
      (info) => setIssuePop((p) => (p?.name === name ? { ...p, info } : p)),
      () => setIssuePop((p) => (p?.name === name && !p.stay ? null : p ? { ...p, none: p.name === name } : p)),
    );
  };
  const hideIssue = () => { clearTimeout(popTimer.current); popTimer.current = setTimeout(() => setIssuePop((p) => (p?.stay ? p : null)), 160); };
  const issueOver = (e) => {
    if (TOUCH) return;
    const el = e.target.closest?.("[data-iss], [data-issue]");
    if (!el || (el.dataset.issue && !repo)) return;
    clearTimeout(popTimer.current);
    popTimer.current = setTimeout(() => showIssue(el), 220);
  };
  const issueOut = (e) => { if (e.target.closest?.("[data-iss], [data-issue]")) hideIssue(); };
  const copySpot = (btn) => {
    const heading = btn.closest("h1, h2, h3, h4");
    const turn = [...box.current.querySelectorAll("[id^=tx]")].filter((x) => /^tx\d+$/.test(x.id) && x.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
    if (!turn) return;
    const text = heading ? [...heading.childNodes].filter((x) => !x.classList?.contains("hlink")).map((x) => x.textContent).join("") : "";
    copyText(spotLink(location.origin, s.sessionId, +turn.id.slice(2), text));
    say("Link copied");
  };
  const refAct = (e) => {
    const t = e.target;
    if (!t.closest || !getSelection().isCollapsed) return;
    const f = t.closest("[data-file]"), c = t.closest("[data-sha]"), span = t.closest("[data-range]"), i = t.closest("[data-issue]"), iss = t.closest("[data-iss]"), more = t.closest("[data-more]"), src = t.closest("[data-draft-source]"), link = t.closest("[data-link]");
    if (TOUCH && (iss || (i && repo))) { showIssue(iss || i, true); e.stopPropagation(); }
    else if (f) openFileRef(f.dataset.file, f.dataset);
    else if (c) setRef({ sha: c.dataset.sha });
    else if (span) setRef({ range: span.dataset.range });
    else if (i && repo) openOut(`${repo}/issues/${i.dataset.issue}`);
    else if (link) copySpot(link);
    else if (more) { const open = more.parentElement.classList.toggle("open"); more.dataset.was ??= more.textContent; more.textContent = open ? "Show less" : more.dataset.was; }
    else if (src) src.textContent = src.closest(".mddraft").classList.toggle("source") ? "Rendered" : "Source";
    else return;
    e.preventDefault();
  };
  return html`${ref?.file && html`<${Viewer} list=${[ref.file]} at=${0} setAt=${() => {}} onClose=${() => setRef(null)} />`}
  ${(ref?.sha || ref?.range) && html`<${CommitView} key=${ref.sha || ref.range} s=${s} sha=${ref.sha} span=${ref.range} repo=${repo} say=${say} open=${(sha) => setRef({ sha })} onClose=${() => setRef(null)} />`}
  ${issuePop && html`<${IssuePop} pop=${issuePop} keep=${() => clearTimeout(popTimer.current)} leave=${hideIssue} close=${() => setIssuePop(null)} />`}
  <div class="tx-wrap ${contents ? "with-toc" : ""}" data-repo=${repo || null} onClick=${refAct} onPointerOver=${issueOver} onPointerOut=${issueOut} onKeyDown=${(e) => { if (e.key === "Enter" && e.target.closest?.("[data-file], [data-sha], [data-range]")) { refAct(e); e.stopPropagation(); } }} onDragEnter=${dropIn} onDragOver=${dropIn}
    onDragLeave=${(e) => !e.currentTarget.contains(e.relatedTarget) && setDrop(false)}
    onDrop=${(e) => { if (!drop) return; e.preventDefault(); setDrop(false); uploadRef.current?.([...e.dataTransfer.files]); }}>
    ${zen && html`<div class="zenbar"><span class="t">${s.title || "Untitled"}</span><button class="kb zenaa" aria-expanded=${pop === "look"} aria-keyshortcuts="a" title=${tip("look", "How the text looks")} onClick=${() => setPop(pop === "look" ? null : "look")}>Aa</button><button class="kb" onClick=${() => setZen(false)} title="Leave zen (z)">Leave zen</button></div>`}
    <div class="txv"><div class="tx" ref=${box} tabindex="0" aria-label=${`Transcript of ${s.title || "this session"}`} onWheel=${letGo} onTouchStart=${letGo} onPointerDown=${letGo} onKeyDown=${letGo}
      onScroll=${(e) => { const el = e.target; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; setBelow(farFromEnd(el)); if (atEnd.current) { setFresh(0); if (landed.current) markLooked(s); } setSel(null); }}>
      <div class="read">
        <article class="flow">
          ${err && html`<p class="evt fail" role="alert"><b>Couldn't load the transcript.</b> ${err}</p>`}
          ${idx === null && !err && html`<div class="skel big" aria-label="Loading"><i></i><i></i><i></i><i></i></div>`}
          ${idx && turns.length === 0 && !rows.length && html`<p class="evt">No messages yet.${live ? " Write the first one below." : ""}</p>`}
          <${SessionPeek} />${rows.map((r, j) => html`<div class=${`tb${r.call ? ` incall${rows[j + 1]?.call ? "" : " callend"}` : ""}`} key=${r.key} data-k=${r.k}>${cell(r)}</div>`)}
        </article>
        ${contents && html`<nav class="toc" aria-label="Contents"><div class="th">Contents <button class="kb" onClick=${() => setContents(false)} title="Close (c)">Close</button></div><ol>${toc.map((x) => html`<li class=${x.folded ? "folded" : ""}>
          <a href=${`#${x.id}`} onClick=${(e) => { e.preventDefault(); const n = +x.id.slice(2); if (x.folded) go(n); else scrollTo(box.current.querySelector(`#${CSS.escape(x.id)}`)); }}><time>${x.at}</time>${x.text.length > 60 ? x.text.slice(0, 56).replace(/\s+\S*$/, "") + "..." : x.text}</a>
          ${x.kids.length > 0 && html`<ul>${x.kids.map((k) => html`<li class=${k.cls || ""}><a href=${`#${k.id}`} onClick=${(e) => { e.preventDefault(); scrollTo(box.current.querySelector(`#${CSS.escape(k.id)}`)); }}>${k.text}</a></li>`)}</ul>`}</li>`)}</ol></nav>`}
      </div>
      ${sel && html`<${SelBar} sel=${{ ...sel, y: sel.y + (box.current?.scrollTop || 0) }} live=${live} act=${selAct} />`}
    </div>
    ${pop === "find" && html`<${Find} turns=${turns} s=${s} go=${go} close=${() => { setPop(null); box.current?.focus({ preventScroll: true }); }} init=${findQ.current} key=${findQ.current} />`}
    ${pop === "look" && html`<${ZenLook} prefs=${prefs} />`}
    ${below && fresh > 0 && html`<button class="btn to-end" onClick=${() => { letGo(); atEnd.current = true; setFresh(0); box.current?.scrollTo({ top: box.current.scrollHeight }); }}>${working ? "New activity below" : "New reply below"}</button>`}
    </div>
    ${!live && resume && s.kind !== "interactive" && html`<${EndBar} s=${s} resume=${resume} busy=${busy} />`}
    ${live && html`<${Composer} s=${s} say=${say} draft=${draft} setDraft=${setDraft} quotes=${quotes} setQuotes=${setQuotes} send=${send} replies=${replies}
      focusRef=${composerFocus} uploadRef=${uploadRef} working=${working} asking=${!!asking && !asking.permission} interrupt=${interrupt} drop=${drop}
      prompt=${cmp.prompt} doors=${cmp.doors} hintFor=${cmp.hint} top=${html`${cmp.top}<${BgStrip} s=${s} />`} />`}
    ${shot && html`<div class="lightbox" onClick=${() => setShot(null)}><img src=${shot} alt="" /></div>`}
  </div>`;
}

function ReadingPanel({ prefs }) {
  const row = (name, cls, options, key) => html`<div class="row ${cls}"><b>${name}</b><span class="seg ${key === "size" ? "sizes" : ""}" role="group" aria-label=${name}>${options.map(([v, text, style]) =>
    html`<button aria-pressed=${prefs[key] === v} aria-label=${typeof v === "number" && key === "size" ? `Size ${v + 1} of 5` : null} style=${style || ""} onClick=${() => txPrefs.set({ [key]: v })}>${text}</button>`)}</span></div>`;
  return html`<div class="rpanel" role="group" aria-label="How the text looks">
    ${row("Size", "", [0, 1, 2, 3, 4].map((i) => [i, "A"]), "size")}
    ${row("Typeface", "", Object.entries(TX_FACES).map(([k, f]) => [k, f.name, `font-family:${f.css}`]), "face")}
    ${row("Line length", "wide", ["Narrow", "Normal", "Wide"].map((n, i) => [i, n]), "width")}
    ${row("Line spacing", "", ["Tight", "Normal", "Loose"].map((n, i) => [i, n]), "space")}
    <div class="row"><b>Paper</b><span class="papers" role="group" aria-label="Paper">${TX_PAPERS.map(([v, name]) =>
      html`<button data-paper=${v || null} aria-pressed=${prefs.paper === v} onClick=${() => txPrefs.set({ paper: v })}>${name}</button>`)}</span></div>
  </div>`;
}

const ZenLook = ({ prefs }) => html`<div class="pop zenlook"><${ReadingPanel} prefs=${prefs} /></div>`;

function useWide(q = BP.desk) {
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q), f = () => setWide(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [q]);
  return wide;
}


const lastAt = (body) => (body?.items || []).map((it) => it.out?.time || it.time).filter(Boolean).sort().pop();

const HUB_CHANNEL = { phone: "On the call", whatsapp: "On WhatsApp", agent: "To a session", guest: "To a guest", "guest-call": "On a guest's call" };

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


const safeURL = (u) => /^(https?:|mailto:|\/|#|\.)/i.test(u || "") ? u : null;
const LONG_CODE_LINES = 26, LONG_CELL = 40;
const mdRender = new Marked.Renderer();
mdRender.code = (code, lang) => {
  const l = (lang || "").split(/\s/)[0];
  const diff = diffBlock(l, code, paintLine);
  if (diff) return diff;
  if (/^(markdown|md)$/.test(l)) return draftBlock(code);
  const body = l && hljs.getLanguage(l) ? hljs.highlight(code, { language: l, ignoreIllegals: true }).value : esc(code);
  const n = code.split("\n").length, long = n > LONG_CODE_LINES, named = l && l !== "text" && n > 2;
  const cls = [named && "named", long && "long"].filter(Boolean).join(" ");
  return `<pre${cls ? ` class="${cls}"` : ""}><button class="copy" data-copy>Copy</button>${named ? `<div class="cbh"><span>${esc(l)}</span><span>${n} lines</span></div>` : ""}<code>${body}</code>${long ? `<button class="cbmore" data-more>Show all ${n} lines</button>` : ""}</pre>`;
};
function draftBlock(code) {
  const rendered = Marked.parse(code).replace(/<h([1-6])>/g, '<h$1 data-draft>');
  return `<div class="mddraft"><div class="mdh"><span class="lbl">Markdown</span><button class="mdt" data-draft-source>Source</button><button class="copy" data-copy data-src="${esc(code)}">Copy</button></div><div class="mdr">${rendered}</div><pre class="mds"><code>${esc(code)}</code></pre></div>`;
}
mdRender.codespan = (t) => {
  const raw = t.replace(/&amp;/g, "&"), wrap = t.length < 28 ? "nowrap" : "";
  if (fileRef(raw)) return `<code class="path ${wrap}" data-file="${t}" tabindex="0" role="link">${t}</code>`;
  if (isSha(raw)) return `<code class="sha ${wrap}" data-sha="${t}" tabindex="0" role="link">${t}</code>`;
  return `<code class=" ${wrap}">${t}</code>`;
};
mdRender.table = (header, body) => `<div class="tbl"><button class="copy" data-copy-table>Copy</button><div class="tsc"><table><thead>${header}</thead><tbody>${body}</tbody></table></div></div>`;
mdRender.tablecell = (content, { header, align }) => {
  const tag = header ? "th" : "td", plainLen = content.replace(/<[^>]+>/g, "").length;
  return `<${tag}${align ? ` align="${align}"` : ""}${plainLen > LONG_CELL ? ' class="long"' : ""}>${content}</${tag}>\n`;
};
const fileLink = (href, inner) => fileRef(href.replace(/^file:\/\//, "")) ? `<a class="fileref" data-file="${esc(href.replace(/^file:\/\//, ""))}" tabindex="0" role="link">${inner}</a>` : null;
mdRender.link = (href, title, text) => {
  const file = fileLink(href, text);
  if (file) return file;
  if (!safeURL(href)) return text;
  const auto = text === esc(href) || text === href, iss = githubIssue(href);
  return `<a href="${esc(href)}" data-out${iss ? ` data-iss="${iss}"` : ""}${auto ? ` class="auto"${iss ? "" : ` title="${esc(href)}"`}` : ""}>${auto ? esc(shortURL(href)) : text}</a>`;
};
mdRender.image = (href, title, text) => fileLink(href, esc(text || href)) || (safeURL(href) ? `<a href="${esc(href)}" data-out>${esc(text || href)}</a>` : esc(text || ""));
const CALLOUTS = { note: "note", tip: "note", info: "note", important: "warn", warning: "warn", caution: "warn" };
mdRender.blockquote = (quote) => {
  const m = /^<p>(?:\[!(\w+)\]\s*|<strong>(\w+):?<\/strong>:?\s*)/i.exec(quote);
  const kind = m && CALLOUTS[(m[1] || m[2]).toLowerCase()];
  if (!kind) return `<blockquote>\n${quote}</blockquote>\n`;
  const name = (m[1] || m[2]).replace(/^./, (c) => c.toUpperCase()).replace(/(?<=^.)\w+/, (w) => w.toLowerCase());
  return `<blockquote class="callout ${kind}"><span class="ct">${name}</span>${quote.replace(m[0], "<p>").replace(/^<p>\s*<\/p>\s*/, "")}</blockquote>\n`;
};
mdRender.html = (h) => esc(h);
Marked.use({
  renderer: mdRender, gfm: true, breaks: false, extensions: [issueRefs],
  tokenizer: {
    del(src) {
      const m = /^~~(?=\S)([\s\S]*?\S)~~(?!~)/.exec(src);
      if (m) return { type: "del", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      const lone = /^~+/.exec(src);
      return lone ? { type: "text", raw: lone[0], text: lone[0] } : false;
    },
  },
});
Marked.use(numberedLists);
const md = (src) => Marked.parse(src || "");

document.addEventListener("click", (e) => {
  const tc = e.target.closest?.("[data-copy-table]");
  if (tc) { copyText([...tc.parentElement.querySelectorAll("tr")].map((r) => [...r.cells].map((x) => x.innerText.trim()).join("\t")).join("\n")); tc.textContent = "Copied"; setTimeout(() => (tc.textContent = "Copy"), 1200); return; }
  const c = e.target.closest?.("[data-copy]");
  if (c) { copyText(c.dataset.src ?? c.parentElement.querySelector("code").innerText); c.textContent = "Copied"; setTimeout(() => (c.textContent = "Copy"), 1200); return; }
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
let nsFiles = [];
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

function FolderField({ dirs, folder, pick, host, listHost = host, live, presets = [], preset, setPreset = () => {}, onStart, home, focus }) {
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
  const cur = hi >= 0 && hi < shown.length ? hi : ql ? 0 : Math.max(0, shown.findIndex(isPick));
  useEffect(() => setHi(-1), [ql, host]);
  const reveal = (i) => box.current?.querySelector(`#ns-fo${i}`)?.scrollIntoView({ block: "nearest" });
  useEffect(() => reveal(cur), [ql, folder, preset]);
  const choose = (r) => {
    if (r.preset) setPreset(preset?.name === r.preset.name ? null : r.preset);
    else { setPreset(null); pick(r.path); }
    setQ(""); setMore(false); setHi(-1);
  };
  const key = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (cur + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(1, shown.length);
      setHi(next); reveal(next);
    }
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
      <label class="nslb" for="ns-folder">Folder <span class="now">${preset ? `preset ${preset.name}` : folder}</span></label>
      <input id="ns-folder" class="nsin mono" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${key} placeholder="Search folders, or type a path" ref=${focus && !touch ? focusOnMount : null}
        role="combobox" aria-expanded="true" aria-controls="ns-fl" aria-activedescendant=${shown.length ? `ns-fo${cur}` : ""} autocapitalize="off" autocomplete="off" spellcheck="false" />
      <div class="nsfl" id="ns-fl" role="listbox" aria-label="Folders" ref=${box} onPointerLeave=${() => setHi(-1)}>
        ${shown.map((r, i) => {
          const head = r.grp !== grp && html`<div class="fh" role="presentation">${r.grp}</div>`;
          grp = r.grp;
          return html`${head}<button type="button" tabindex="-1" role="option" id=${`ns-fo${i}`} aria-selected=${isPick(r)} class="fo ${i === cur && (hi >= 0 || !isPick(r)) ? "on" : ""} ${isPick(r) ? "pick" : ""}"
            onPointerMove=${() => i !== cur && setHi(i)} onClick=${() => choose(r)}>
            <span class="ck">${isPick(r) && ICON.check}</span><span class="p ${r.preset ? "" : "mono"}">${r.typed ? html`Use <b>${r.path}</b>` : marked(r.path, r.hits)}</span><span class="m">${meta(r)}</span></button>`;
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

const submitOnEnter = (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key !== "Enter" || e.isComposing || (!mod && (touch || e.shiftKey))) return;
  e.preventDefault();
  e.target.form?.requestSubmit();
};

const intoView = (el) => el?.scrollIntoView({ block: "nearest" });

function useTrustState(dir, host) {
  const [state, setState] = useState("");
  useEffect(() => {
    setState("");
    if (!dir) return;
    let gone = false;
    const t = setTimeout(() => api(`/api/trust?${new URLSearchParams({ dir, host })}`).then((r) => gone || setState(r.state), () => {}), 200);
    return () => { gone = true; clearTimeout(t); };
  }, [dir, host]);
  return state;
}

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
  const [files, setFilesRaw] = useState(() => (later || seeded ? [] : nsFiles));
  const setFiles = (fs) => { setFilesRaw(fs); if (!later) nsFiles = fs; };
  const addFiles = (fs) => setFiles([...files, ...fs.map((f) => ({ id: Math.random().toString(36).slice(2), name: f.name || "pasted.png", size: f.size, file: f, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : null }))]);
  const [big, setBig] = useState(null);
  const [dropping, setDropping] = useState(false);
  const pickFile = useRef();
  const [name, setName] = useState(from?.title || "");
  const [wt, setWt] = useState(null);
  const [presets, setPresets] = useState([]);
  const [preset, setPreset] = useState(null);
  const [engines, setEngines] = useState([]);
  const [engine, setEngine] = useState("");
  const [engOpen, setEngOpen] = useState(false);
  const [profile, setProfile] = useState("");
  const [profOpen, setProfOpen] = useState(false);
  const [profs, setProfs] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [opts, setOpts] = useState(false);
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
  const profDir = preset ? preset.dir : dir.trim();
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api(`/api/profiles?${new URLSearchParams({ dir: profDir, ...(target !== home ? { host: target } : {}) })}`).then((p) => live && setProfs(p), () => live && setProfs(null)), 250);
    return () => { live = false; clearTimeout(t); };
  }, [profDir, target]);
  useEffect(() => { if (profs && profile && !profs.profiles.some((p) => p.name === profile)) setProfile(""); }, [profs]);
  const privProf = !later && !preset && !harness ? profs?.profiles.find((p) => p.private) : null;
  const [privOn, setPriv] = useState(false);
  const priv = privOn && !!privProf;
  const byFolder = preset?.profile || profs?.for;
  const profLine = profile ? html`<b>${profile}</b>` : html`<b>${byFolder || "default"}</b>${preset?.profile ? ", from the preset" : profs?.profiles.length > 1 ? ", from the folder" : ""}`;
  const git = !!dirs.find((d) => tilde(d.path) === dir)?.git;
  const busyHere = workingIn(live, dir, target, home);
  const trust = useTrustState(later || harness ? "" : preset ? preset.dir : dir.trim(), target);
  const wtOn = git && !harness && !preset && (wt ?? busyHere.length > 0);
  const hostDown = isDown(target);
  const other = up.find((h) => h !== target);
  const first = useRef(true);
  useEffect(() => {
    if (first.current || later) { first.current = false; return; }
    nsDraft.set(!priv && (prompt.trim() || (folder && folder !== ctxDir)) ? { prompt, folder, host } : null);
  }, [prompt, folder, host, priv]);
  useEffect(() => {
    const f = (e) => { if (e.key === "Escape") big ? setBig(null) : picking ? (setPicking(false), document.getElementById("ns-prompt")?.focus()) : onClose(); };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, [big, picking]);
  const setHost = (h) => { setHostRaw(h); setWt(null); setErr(null); };
  const pick = (p) => { setFolder(p); setWt(null); setErr(null); setPicking(false); const h = stored(NS_HOSTS, {})[p]; if (h && hosts.includes(h) && !isDown(h)) setHostRaw(h); };
  const clear = () => { nsDraft.set(null); setFiles([]); setPrompt(""); setFolder(ctxDir); setHostRaw(context?.host || home); setPreset(null); setWt(null); setErr(null); };

  const withFiles = async (h) => {
    const paths = [];
    const q = new URLSearchParams({ ...(h !== home ? { host: h } : {}), ...(priv ? { profile: privProf.name } : {}) }).toString();
    for (const f of files) paths.push(await uploadFile(`/api/uploads${q ? `?${q}` : ""}`, f.file, f.name));
    return [prompt.trim() && prompt, paths.map(quotePath).join("\n")].filter(Boolean).join("\n\n");
  };
  const putAside = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/backlog${hostQ(host, home)}`, { method: "POST", body: { dir: dir.trim(), title: name, prompt: await withFiles(host), worktree: wtOn } });
      if (!later) nsDraft.set(null);
      setFiles([]);
      onClose();
      say("Put on the backlog.");
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
      const opening = await withFiles(h);
      const r = await (preset
        ? api(`/api/sessions${hostQ(preset.host, home)}`, { method: "POST", body: { preset: preset.name, name: name.trim(), prompt: opening, engine, profile } })
        : priv ? api(`/api/sessions${hostQ(h, home)}`, { method: "POST", body: { name: name.trim(), prompt: opening, profile: privProf.name } })
        : api(`/api/sessions${hostQ(h, home)}`, { method: "POST", body: { dir: dir.trim(), name: name.trim(), prompt: opening, worktree: wtOn, engine, profile } }));
      if (!preset && !priv) store(NS_HOSTS, { ...stored(NS_HOSTS, {}), [dir]: h });
      nsDraft.set(null);
      setFiles([]);
      onClose();
      say(`Started on ${h}.`);
      go(r.id);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const submit = (e) => { e.preventDefault(); start(hostDown && !later && other ? other : null); };

  const off = down.find((p) => p.name === target);
  const why = hostDown
    ? html`<b>${target} is unreachable${off?.error ? `: ${off.error}` : ""}.</b> ${lastHosts[dir] === target ? `You usually start ${dir} there. ` : ""}${other ? `Start on ${other} instead, or come back when ${target} is up.` : ""}`
    : down.length ? `${down.map((p) => p.name).join(" and ")} ${down.length === 1 ? "is" : "are"} unreachable, so ${down.length === 1 ? "it" : "they"} can't be picked.`
    : lastHosts[dir] === host ? `Last time you used ${host} for this folder.` : "";
  const draft = !later && !!(prompt.trim() || files.length || (folder && folder !== ctxDir));
  const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  const engLine = eng ? `${eng.name}${eng.harness ? `, ${eng.harness}` : ""}${eng.model ? `, ${eng.model}` : ""}` : "Claude, as configured";
  const startLabel = busy ? `Starting on ${busy}…` : later ? "Add to backlog" : hostDown && other ? `Start on ${other} instead` : "Start";
  const pickPreset = (p) => { setPreset(p); setPicking(false); };
  const profName = profile || byFolder || "default";
  const optLine = [
    !later && preset ? `preset ${preset.name}` : null,
    git && !harness && !preset && !priv ? (wtOn ? "New worktree" : "In the folder") : null,
    !later && (priv ? `Claude, on the ${privProf.name} profile` : eng ? engLine : "Claude, as configured"),
    !later && (name.trim() ? `named “${name.trim()}”` : "name from the prompt"),
    !later && !harness && !priv && profs?.profiles.some((p) => !p.default && !p.private) && `${profName} account`,
  ].filter(Boolean).join(" · ");
  const where = preset ? html`preset <b>${preset.name}</b>, ${tilde(preset.dir)}` : priv ? html`an empty <b>private</b> folder on ${hostDown && other ? other : host}` : html`${wtOn ? "a new worktree of " : ""}<b>${dir}</b> on ${hostDown && other ? other : host}`;
  return html`
    <div class="nsveil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}
      onDragOver=${(e) => { if (hasFiles(e)) { e.preventDefault(); setDropping(true); } }}
      onDragLeave=${(e) => { if (!e.relatedTarget) setDropping(false); }}
      onDrop=${(e) => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); addFiles([...e.dataTransfer.files]); } setDropping(false); }}>
      <form class="nsdlg" role="dialog" aria-modal="true" aria-label=${later ? "Put on the backlog" : "New session"} onSubmit=${submit}
        onPaste=${(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } }}>
        <i class="grab" aria-hidden="true"></i>
        <div class="dh"><b>${later ? "Put on the backlog" : "New session"}</b>${ctxDir && !later && html`<span class="in">in ${project(ctxDir).name}</span>`}
          <span class="r">${draft && html`<button type="button" class="btn sm quiet clr" onClick=${clear} title="Empty the sheet; it keeps what you typed until you start or clear it">Clear</button>`}
            <button type="button" class="btn sm quiet icon" onClick=${onClose} aria-keyshortcuts="Escape" aria-label="Close" title="Close (esc)">${ICON.x}</button></span></div>
        <div class="db">
          ${later && html`<div class="nsfld"><label class="nslb" for="ns-title">Title <span>what the backlog shows, in a few words</span></label>
            <input id="ns-title" class="nsin" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${submitOnEnter} ref=${touch ? null : focusOnMount} /></div>`}
          <div class="nsbox ${dropping ? "drop" : ""}">
            <${AttChips} atts=${files} up=${() => !!busy} zoom=${setBig} remove=${(a) => setFiles(files.filter((x) => x.id !== a.id))} />
            <textarea id="ns-prompt" class="nsprompt" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} onKeyDown=${submitOnEnter} aria-label="Prompt"
              ref=${touch || later ? null : focusOnMount} placeholder=${later ? "The session's first message when you start it" : "What should it do?"}></textarea>
            <div class="nsatt"><button type="button" class="btn sm quiet" onClick=${() => pickFile.current?.click()}>${ICON.attach}<span>${dropping ? "Drop to attach" : "Paste or drop images and files"}</span></button>
              ${!later && html`<span class="hint">Leave it empty to start with the composer ready</span>`}
              <input type="file" multiple hidden ref=${pickFile} onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ""; }} /></div>
          </div>
          <div class="nspicks">
            ${!priv && html`<button type="button" class="nspick folder" aria-expanded=${picking} aria-controls="ns-fl" onClick=${() => setPicking(!picking)}>
              ${ICON.folder}<span class="l">Folder</span><span class="v">${preset ? `preset ${preset.name}` : dir}</span>${ICON.down}</button>`}
            ${privProf && html`<button type="button" class="nspick priv ${priv ? "folder" : ""}" aria-pressed=${priv} onClick=${() => { setPriv(!priv); setPicking(false); }}
              title="A private session keeps nothing"><span class="l">Private</span><span class="v">${priv ? "on" : "off"}</span></button>`}
            ${!preset && hosts.length > 1 && html`<${Menu} cls="nspick host" width=${220} aria="Machine" items=${hosts.map((h) => {
              const o = down.find((p) => p.name === h);
              return { label: h, on: h === host, icon: h === host ? "check" : null, sub: o ? "unreachable" : lastHosts[dir] === h ? "last used here" : "", run: () => !o && setHost(h) };
            })} label=${html`${ICON.term}<span class="l">Machine</span><span class="v">${host}</span>${ICON.down}`} />`}
          </div>
          ${priv && html`<div class="why nswhy">What it writes stays in memory and is erased when you delete it or ${target} restarts. Your agents can't see it, pushes don't say what it said, and it runs in an empty folder of its own, without your instructions, memory or MCP servers.</div>`}
          ${picking && !priv && html`<${FolderField} dirs=${dirs} folder=${dir} pick=${pick} host=${target} listHost=${listHost} live=${live} presets=${later ? [] : presets} preset=${preset} setPreset=${pickPreset} home=${home} focus
            onStart=${() => start(hostDown && !later && other ? other : null)} />`}
          ${why && html`<div class="why nswhy">${why}</div>`}
          ${!priv && trust === "home" && html`<div class="nstrust"><b>Claude Code trusts the home folder one session at a time,</b> so a background session can't start here. Pick a project folder.</div>`}
          ${optLine && html`<button type="button" class="nsopts" aria-expanded=${opts} onClick=${() => setOpts(!opts)}>${ICON.fwd}<b>Options</b><span>${optLine}</span></button>`}
          ${opts && html`<div class="nsoptb">
            ${!later && !priv && git && !harness && !preset && html`<${WorktreeSwitch} on=${wtOn} setOn=${setWt} why=${wtWhy(busyHere.length, dir, target)} />`}
            ${later && git && html`<${WorktreeSwitch} on=${wtOn} setOn=${setWt} why="The session starts in its own checkout when you start it." />`}
            ${!later && !priv && html`<div class="nsfld"><div class="nslb">Engine</div>
              <div class="nseng">
                ${engOpen && usable.length
                  ? html`<select aria-label="Engine" value=${engine} onChange=${(e) => setEngine(e.target.value)} ref=${focusOnMount}>
                      ${[{ name: "" }, ...usable].map((e) => html`<option value=${e.name}>${e.name ? `${e.name}${e.harness ? `, ${e.harness}` : ""}${e.model ? `, ${e.model}` : ""}` : "Claude, as configured"}</option>`)}</select>`
                  : html`<span>${engLine}</span>${usable.length > 0 && html`<button type="button" class="btn sm" onClick=${() => setEngOpen(true)}>Change</button>`}`}
              </div></div>`}
            ${!later && html`<div class="nsfld"><label class="nslb" for="ns-name">Name <span>without one, ${harness || "Claude"} titles it from what you ask</span></label>
              <input id="ns-name" class="nsin nsname" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${submitOnEnter} placeholder=${preset ? preset.name : "From the prompt"} /></div>`}
            ${!later && !harness && !priv && profs?.profiles.some((p) => !p.default && !p.private) && html`<div class="nsfld"><div class="nslb">Claude account <span>the sign-in it runs and is billed on</span></div>
              <div class="nseng">
                ${profOpen
                  ? html`<select aria-label="Claude account" value=${profile} onChange=${(e) => setProfile(e.target.value)} ref=${focusOnMount}>
                      ${[{ name: "" }, ...profs.profiles.filter((p) => !p.private)].map((p) => html`<option value=${p.name}>${p.name || `By folder (${byFolder || "default"})`}</option>`)}</select>`
                  : html`<span>${profLine}</span><button type="button" class="btn sm" onClick=${() => setProfOpen(true)}>Change</button>`}
              </div></div>`}
          </div>`}
          ${err && html`<div class="nserr" role="alert" ref=${intoView}><b>Couldn't ${later ? "add it" : `start on ${preset ? preset.host || home : host}`}.</b> ${err}</div>`}
        </div>
        <div class="df">
          <span class="sum">${later ? html`On the backlog of ${where}` : html`Starts in ${where}`}</span>
          ${!later && !preset && !priv && html`<button type="button" class="btn quiet" title="Put it on the backlog to start later" disabled=${!dir.trim() || !(name.trim() || prompt.trim() || files.length) || !!busy} onClick=${putAside}>Later</button>`}
          <button class="btn primary go" disabled=${(!preset && !priv && !dir.trim()) || (later && !(name.trim() || prompt.trim() || files.length)) || !!busy || (hostDown && !other && !later)}>${startLabel}</button>
        </div>
      </form>
      ${big && html`<div class="lightbox" onClick=${() => setBig(null)}><img src=${big} alt="" /></div>`}
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
const PAL_CAP = { Sessions: 6, Shells: 4, Pages: 4, Actions: 6, Folders: 4, Agents: 4, Earlier: 4, Bays: 4, Appearance: 4 };
const STATE_BOOST = { "needs-you": 30, "your-turn": 12, working: 6 };

function Palette({ live, onBays, sel, say, home, hosts, actions, onClose }) {
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
  const bays = baysOf(onBays, BAY.only);
  const cur = SESSION_API;
  if (cur && sel) {
    const s = cur.s, g = "This session";
    const act = (label, f, kw = "", hint, boost) => add(g, label, { run: run(null, f), kw, hint, boost, sub: s.title || "Untitled" });
    if (cur.canAttach) act("Terminal", () => cur.mode("term"), "shell attach", keyFor("term"));
    act("Transcript", () => cur.mode("chat"), "read conversation");
    act("Outputs", () => cur.outputs(), "files servers links commits results", keyFor("state"));
    if (cur.zen || TX_API) act("Zen", () => (cur.zen || TX_API?.zen)?.(), "read focus text", keyFor("zen"));
    act("Sessions pane", () => actions.pane("rail"), "rail list", keyFor("rail"));
    act("State pane", () => actions.pane("state"), "summary facts", keyFor("state"));
    for (const p of cur.pages || []) act(`Page: ${pageTitle(p)}`, () => cur.page(p.name), `show ${p.name}`, keyFor("page"));
    const call = callSession(s, say);
    act(call.label, call.run, "voice talk phone assistant", undefined, call.boost);
    act("Session usage", cur.usage, "tokens cost limit");
    act("Rename", cur.rename, "title name");
    act(s.pinned ? "Unpin" : "Pin", () => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { pinned: !s.pinned } }).then(() => say(s.pinned ? "Unpinned." : "Pinned."), (e) => say(e.message)));
    act(s.parked ? "Unpark" : "Park", () => api(`/api/sessions/${s.sessionId}`, { method: "PATCH", body: { parked: !s.parked } }).then(() => say(s.parked ? "Unparked." : "Parked."), (e) => say(e.message)), "hide quiet");
    if (s.attachable) act("Stop", () => api(`/api/sessions/${s.sessionId}/stop?device=${encodeURIComponent(DEVICE)}`, { method: "POST" }).then(() => say("Stopped. Resume it any time.")), "end");
    act("Put on the backlog", () => putAside(s, say), "later aside backlog");
  }
  for (const s of live) add("Sessions", s.title || "Untitled", { key: `s:${s.sessionId}`, s, extra: bayOf(s) || projectOf(s), boost: STATE_BOOST[s.state] || 0,
    sub: s.state === "working" && s.activity ? doing(s) : headline(s), bay: bayOf(s) || projectOf(s), ago: ago(s),
    to: `#/s/${keyOf(s)}`, run: run(`s:${s.sessionId}`, () => go(keyOf(s))) });
  const liveIDs = new Set(live.map((s) => s.sessionId));
  for (const s of past.filter((s) => !liveIDs.has(s.sessionId))) add("Earlier", s.title || "Untitled", { s, extra: project(s.cwd).name, bay: project(s.cwd).name, ago: ago(s), sub: (s.lastFrom ? `${s.lastFrom}: ` : "") + oneLine(s.lastPrompt), to: `#/s/${s.sessionId}`, run: run(null, () => go(s.sessionId)) });
  for (const p of pages) {
    const owner = live.find((x) => x.sessionId === p.session), to = owner ? pageLink(p.session, p.name) : aloneLink(p.session, p.name);
    add("Pages", pageTitle(p), { key: `p:${pkey(p)}`, page: true, sub: `${p.kind || "page"}, from ${owner?.title || p.of || "an earlier session"}`, bay: owner ? bayOf(owner) || project(owner.cwd).name : "",
      ago: age(p.updated || p.shown), to, run: run(`p:${pkey(p)}`, () => (location.hash = to)) });
  }
  const action = (label, hint, sub, f, kw = "") => add("Actions", label, { key: `a:${label}`, hint, sub, kw, boost: 4, run: run(`a:${label}`, f) });
  action("New session", keyFor("new"), "start a session in a folder", () => actions.create(), "start folder");
  action("New shell", "", "a plain login shell, no Claude: pick the machine and folder. $ command runs just one", () => NEW_SHELL(), "terminal zsh bash tmux console escape hatch");
  for (const h of hosts) action(MULTI ? `Shell on ${h}` : "Shell in ~", "", `a login shell in your home folder${MULTI ? ` on ${h}` : ""}, at once`,
    () => startShell(h, "~").catch((e) => say(e.message)), "terminal zsh bash tmux console home");
  const runCmd = q.match(/^\s*[$!]\s*(.*)$/)?.[1].trim();
  if (runCmd !== undefined) {
    const at = shellRoute(), shNow = at && (SHELLS.list || []).find((x) => x.id === at.id);
    const where = shNow ? { host: shNow.host || HERE, dir: shNow.dir } : cur && sel ? { host: cur.s.host || home, dir: cur.s.cwd } : { host: home, dir: "~" };
    add("Run", runCmd ? runCmd : "Type a command after $", { key: null, shell: true, mono: true,
      sub: `in ${tilde(where.dir || "~")}${MULTI ? ` on ${where.host}` : ""}, closes on a key once it is done`,
      run: runCmd ? run(null, () => startShell(where.host, where.dir || "~", runCmd).catch((e) => say(e.message))) : () => {} });
  }
  for (const x of SHELLS.list || []) add("Shells", shellName(x), { key: `sh:${x.id}`, shell: true, mono: true, kw: "shell terminal", sub: shellWhere(x) || "shell",
    ago: age(x.started), run: run(`sh:${x.id}`, () => (location.hash = shellHash(x))) });
  action("Session", keyFor("session"), "the open session of this bay", () => goBay(BAY.only, live, true));
  action("Board", keyFor("board"), "every session of this bay", () => { rememberBay(BAY.only, { view: "board" }); go(null); });
  action("Pages", keyFor("pages"), "every page your sessions showed you", () => (location.hash = pagesHash()), "shown html reports gallery");
  action("Assistant", keyFor("assistant"), "your conversation with it", actions.ask, "ask chat switchboard");
  action("Call the assistant", "", "a voice call", callOrSetup, "phone voice");
  action("All bays", keyFor("all"), "the board across every bay", () => { BAY.set(null); go(null); });
  action("Next session that needs you", keyFor("next"), "any bay, in bay order", actions.next);
  action("Usage", "", "limits, pace, cost per bay and session", actions.usage, "tokens cost week limits");
  action("Time", "", "the time you spent per session, bay and day", () => { if (!inUsage()) USAGE_FROM = location.hash; location.hash = TIME; }, "usage hours spent attention focus");
  action("Resources", "", "memory, CPU and disk per session, and what outlived its session", openResources, "ram cpu disk processes top memory load");
  action("Backlog", "", "future tasks of this bay", () => (location.hash = BACKLOG), "later todo tasks ideas");
  action("New backlog item", "", "put a task aside for later", () => actions.create({ later: true }), "later todo task add put");
  action("Agents", "", "standing agents and what they keep", () => (location.hash = AGENTS_ROUTE), "tracker standing");
  if (inBrowser) action("Open in browser", "", "this screen in the phone's browser instead of the app", () => inBrowser(location.href), "chrome external web");
  if (PAL_TOGGLE) {
    add("pal", "pal's panel", { key: "a:pal", hint: "shift P", sub: "search, palettes, live views", kw: "pal launcher", run: run("a:pal", PAL_TOGGLE) });
    add("pal", "pal's bar", { key: "a:pal bar", hint: "shift B", sub: "show or hide it on this device", kw: "pal strip top", run: run("a:pal bar", () => window.pal.bar()) });
  }
  action("Settings", keyFor("settings"), "appearance, reading, notifications", () => (location.hash = SETTINGS), "preferences options theme");
  action("Keys", keyFor("keys"), "every key", actions.help, "help shortcuts keyboard");
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
  for (const a of Object.values(AGENT_INFO)) add("Agents", a.name === "assistant" ? "the assistant" : `@${a.name}`, { key: `g:${a.name}`, agent: a, boost: 60, kw: `agent ${a.name}`,
    sub: agentKeeps(a) || a.error || "keeps nothing of its own", run: run(`g:${a.name}`, () => openAgent(a.name)) });
  bays.forEach((b, i) => add("Bays", b.name, { bayN: i + 1, b, hint: i < 9 ? String(i + 1) : "", sub: bayWords(b, i).split(": ")[1] || "nothing open", run: run(null, () => goBay(b.name, live)) }));

  const ql = q.trim().toLowerCase();
  let groups, closest = "";
  if (runCmd !== undefined) groups = [["Run", items.filter((it) => it.group === "Run")]];
  else if (!ql) {
    const byKey = Object.fromEntries(items.filter((it) => it.key).map((it) => [it.key, it]));
    const recent = [...new Set([...stored(PAL_RECENT, []).map((k) => byKey[k]).filter(Boolean),
      ...items.filter((it) => it.group === "Sessions" && !away(it.s)).sort((x, y) => (Date.parse(y.s.updated || 0) || 0) - (Date.parse(x.s.updated || 0) || 0))])].slice(0, 6);
    groups = [
      ["Recent", recent],
      ["Needs you", items.filter((it) => it.group === "Sessions" && it.s.state === "needs-you" && !away(it.s))],
      ["Agents", items.filter((it) => it.group === "Agents" && !recent.includes(it))],
      ["This session", items.filter((it) => it.group === "This session")],
      ["Actions", items.filter((it) => it.group === "Actions").slice(0, 5), items.filter((it) => it.group === "Actions").length - 5],
      ["pal", items.filter((it) => it.group === "pal")],
    ].filter(([, l]) => l.length);
  } else {
    const by = {};
    for (let w = ql; w.length >= Math.min(ql.length, Math.max(2, ql.length / 2)) && !Object.keys(by).length; w = w.slice(0, -1).trimEnd()) {
      for (const it of items) {
        if (it.group === "Folders" && w.length < 2) continue;
        const m = fuzzy(w, it.label), m2 = !m && fuzzy(w, `${it.extra || ""} ${it.kw || ""}`);
        if (!m && !m2) continue;
        (by[it.group] ||= []).push({ ...it, hits: m ? m.hits : [], score: (m ? m.score : m2.score * 0.6) + (it.boost || 0) });
      }
      closest = w !== ql && Object.keys(by).length ? w : "";
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
    : html`<span class="ic" aria-hidden="true">${it.page ? "pg" : it.shell ? "$" : it.mono ? "dir" : ""}</span>`;
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
        ${closest && html`<div class="pal-near">Nothing matches <b>${q.trim()}</b>; closest to <b>${closest}</b>.</div>`}
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
      <div class="pal-f"><span><kbd>enter</kbd>opens</span><span><kbd>tab</kbd>previews</span><span><kbd>esc</kbd>closes</span></div>
      <div class="sr" aria-live="polite">${ql ? `${flat.length} results${top ? `, first: ${top.label}` : ""}` : ""}</div>
    </div>`;
}

let PAL_UP = null;
function usePal(pal) {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!pal) return;
    PAL_UP ||= new Promise((done) => {
      const s = document.createElement("script");
      s.type = "module";
      s.src = `${pal.server}/__pal/embed.js`;
      if (pal.token) s.dataset.token = pal.token;
      s.onload = () => Promise.resolve(window.pal?.ready).then((ok) => done(!!ok), () => done(false));
      s.onerror = () => done(false);
      addEventListener("pal-open", (e) => { e.preventDefault(); openOut(e.detail.url); });
      document.head.append(s);
    });
    PAL_UP.then(setUp);
  }, [!!pal]);
  return up;
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

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const paths = [];
      for (const f of files) {
        const blob = await (await fetch(f.url)).blob();
        const url = to === "new" ? `/api/uploads${hostQ(host, home)}` : `/api/sessions/${target.sessionId}/upload`;
        paths.push(await uploadFile(url, blob, f.name).catch((e) => { throw new Error(`Uploading ${f.name} failed: ${e.message}`); }));
      }
      const prompt = [ask.trim(), text.trim(), paths.map(quotePath).join("\n")].filter(Boolean).join("\n\n");
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
      setErr(e.message);
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
                <span class="t" lang=${langOf(s.title)}>${s.title}<small title=${tilde(s.cwd)}>${MULTI ? `${s.host} · ` : ""}${clipPath(tilde(s.cwd))} · ${WORD[s.state] || s.state}</small></span>
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
