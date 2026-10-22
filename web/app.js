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
    if (!me || !APP_VERSION) return;
    fetch("/app/version.json").then((r) => (r.ok ? r.json() : null)).then((v) => v && v.versionCode > APP_VERSION && setStale(v.versionName), () => {});
  }, [me]);

  const [assisting, setAssisting] = useState(location.hash === "#/assist");
  useEffect(() => {
    const f = () => setAssisting(location.hash === "#/assist");
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
      } else if (e.key === "n") {
        e.preventDefault(); setCreating(true);
      } else if (e.key === "/") {
        e.preventDefault(); document.querySelector('.search input')?.focus();
      } else if (e.key === "?") {
        setHelp((h) => !h);
      } else if (e.key === "Escape") {
        setHelp(false); setCursor(null);
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
          <button class="btn primary" onClick=${() => setCreating(true)}>New session</button>
        </header>
        <${Board} live=${live} sel=${sel} cursor=${cursor} onPast=${remember} />
      </aside>
      <main class="main">
        ${sel
          ? html`<${Session} key=${sel.sessionId} s=${sel} say=${say} live=${all} />`
          : html`<div class="blank">${starting || (route && !live) ? "Opening…" : route ? "This session is gone. Pick another from the list." : "Pick a session, or start a new one."}</div>`}
      </main>
    </div>
    ${creating && html`<${NewSession} onClose=${() => setCreating(false)} say=${say} hosts=${(me.hosts || [me.host]).filter((h) => !down.some((p) => p.name === h))} home=${me.host} />`}
    ${assisting && html`<${Assist} live=${live} busy=${starting} onTalk=${talk} onOpen=${() => go(null)} />`}
    ${quick && html`<${QuickMenu} quick=${quick} say=${say} onClose=${() => setQuick(null)} />`}
    ${toast && html`<div class="toast" role="status">${toast}</div>`}
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
            <dt>/</dt><dd>Search earlier sessions</dd>
            <dt>Ctrl + Z</dt><dd>In a terminal: detach. The session keeps running.</dd>
            <dt>?</dt><dd>Show or hide this</dd>
          </dl>
        </div>
      </div>`}
  `;
}

function Assist({ live, busy, onTalk, onOpen }) {
  const open = (live || []).filter((s) => !s.parked);
  const count = (st) => open.filter((s) => s.state === st).length;
  const summary = [["needs-you", "needs you"], ["your-turn", "your turn"], ["working", "working"]]
    .map(([st, word]) => count(st) && `${count(st)} ${word}`).filter(Boolean).join(" · ") || "Nothing open";
  const top = open.filter((s) => s.state !== "stopped").slice(0, 3);
  const last = open.find((s) => s.name === "assistant" || s.title === "assistant");
  return html`
    <div class="assist">
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

function Board({ live, sel, cursor, onPast }) {
  const [q, setQ] = useState("");
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
  const earlier = (hist || []).filter((s) => !liveIDs.has(s.sessionId));
  const pinned = live.filter((s) => s.pinned && !s.parked);
  const rest = live.filter((s) => !s.pinned && !s.parked);
  const parked = live.filter((s) => s.parked);

  return html`
    <div class="board">
      ${live.length === 0 && html`<p class="empty">Nothing is running. Start a session, or pick up an earlier one below.</p>`}
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
  const down = (e) => {
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
        <span>${tilde(s.cwd)}</span>
        ${s.branch && s.branch !== "HEAD" && html`<span>${s.branch}</span>`}
        ${s.model && html`<span>${model(s.model)}</span>`}
        ${s.kind === "interactive" && html`<span class="tag">in a terminal</span>`}
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
          <span>${tilde(s.cwd)}</span>
          ${s.branch && s.branch !== "HEAD" && html`<span class="wide">${s.branch}</span>`}
          ${s.model && html`<span class="wide">${model(s.model)}</span>`}
          ${s.context > 0 && html`<span class="wide">${Math.round(s.context / 1000)}k context</span>`}
          ${s.permissionMode === "bypassPermissions" && html`<span class="wide" title="Claude runs tools in this session without asking first">no permission prompts</span>`}
        </div>
      </div>
      ${VOICE.stt && html`<button class="btn voice-btn ${voice ? "on" : ""} ${canAttach ? "" : "off"}" aria-pressed=${voice}
        onClick=${() => canAttach ? (setVoice(!voice), setMode("term"))
          : say(s.kind === "interactive" ? "Voice needs a session atc can type into. This one runs in a terminal window; start one from atc, or resume this one after it ends." : "Resume this session first, then turn on voice.")}>Voice</button>`}
      <div class="seg" role="tablist">
        <button class=${mode === "term" ? "on" : ""} onClick=${() => setMode("term")}>Terminal</button>
        <button class=${mode === "chat" ? "on" : ""} onClick=${() => setMode("chat")}>Transcript</button>
      </div>
      <${Menu} busy=${busy} items=${sessionActions(s, say, { rename: () => setRenaming(true), after: () => setBusy(false) })} />
    </div>
    ${mode === "term"
      ? canAttach
        ? html`<${Term} key=${s.id} s=${s} say=${say} voice=${voice} onVoiceOff=${() => setVoice(false)} />`
        : html`<div class="stage"><div class="cover">${Unattachable(s, resume, busy, setMode)}</div></div>`
      : html`<${Transcript} s=${s} />`}
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
  const [cover, setCover] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const tries = useRef(0);
  const [foreign, setForeign] = useState(null);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  useEffect(() => {
    setCover(null);
    const el = box.current;
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
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/sessions/${s.id}/attach?cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = "arraybuffer";
    let exited = false, owner = true;
    const ctl = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    const send = (d) => ws.readyState === 1 && ws.send(enc.encode(d));

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
    const mine = () => fit.proposeDimensions() || { cols: term.cols, rows: term.rows };
    const relayout = () => {
      const d = mine();
      if (!d.cols) return;
      ctl({ type: "resize", cols: d.cols, rows: d.rows });
      if (owner) fit.fit(); else scale(true);
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return term.write(new Uint8Array(e.data));
      const c = JSON.parse(e.data);
      if (c.type === "size") {
        owner = !!c.owner;
        if (owner) {
          scale(false);
          fit.fit();
          setForeign(null);
        } else {
          term.resize(c.cols, c.rows);
          requestAnimationFrame(() => scale(true));
          setForeign(c.viewers);
        }
      } else if (c.type === "exit") {
        exited = true;
        setCover("detached");
      }
    };
    ws.onopen = () => { tries.current = 0; setRetrying(false); };
    ws.onclose = () => {
      if (exited) return;
      if (tries.current >= 20) return setCover("lost");
      const wait = Math.min(1000 * 2 ** tries.current++, 8000);
      setRetrying(true);
      setTimeout(() => setGen((g) => g + 1), wait);
    };
    ws.onerror = () => {};

    term.onData((d) => {
      if (ctrlRef.current && d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
        setCtrl(false);
      }
      send(d);
    });
    term.onBinary((d) => ws.readyState === 1 && ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
    term.textarea?.addEventListener("focus", () => !owner && ctl({ type: "claim" }));

    const ro = new ResizeObserver(() => requestAnimationFrame(relayout));
    ro.observe(el);

    let ty = null, acc = 0;
    const screen = () => el.querySelector(".xterm-screen");
    const tstart = (e) => { ty = e.touches[0].clientY; acc = 0; };
    const tmove = (e) => {
      if (ty === null) return;
      const y = e.touches[0].clientY;
      acc += ty - y;
      ty = y;
      const step = 18;
      while (Math.abs(acc) >= step) {
        const dy = Math.sign(acc) * step;
        acc -= dy;
        screen()?.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true, clientX: e.touches[0].clientX, clientY: y }));
      }
      e.preventDefault();
    };
    const tend = () => (ty = null);
    el.addEventListener("touchstart", tstart, { passive: true });
    el.addEventListener("touchmove", tmove, { passive: false });
    el.addEventListener("touchend", tend);
    const paste = (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      upload.current(files);
    };
    el.addEventListener("paste", paste, true);

    api_.current = { send, focus: () => term.focus(), claim: () => ctl({ type: "claim" }) };
    if (!touch) term.focus();
    return () => {
      ro.disconnect();
      exited = true;
      ws.close();
      term.dispose();
    };
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
          <span>Sized for another screen</span>
          <button class="btn" onClick=${() => api_.current.claim?.()}>Fit to this one</button>
        </div>`}
      ${cover && html`
        <div class="cover">
          <div>
            <p class="h">${cover === "detached" ? "Detached" : "Connection lost"}</p>
            <p>${cover === "detached" ? "The terminal closed. The session keeps running." : "The link to the server dropped. The session keeps running."}</p>
            <div class="row">
              <button class="btn primary" onClick=${() => { tries.current = 0; setGen(gen + 1); }}>Reopen</button>
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

function NewSession({ onClose, say, hosts, home }) {
  const [host, setHost] = useState(home);
  const hq = host && host !== home ? `?host=${encodeURIComponent(host)}` : "";
  const [dirs, setDirs] = useState([]);
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/api/dirs${hq}`).then((d) => setDirs(d || []), () => setDirs([])); }, [host]);
  useEffect(() => {
    const f = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);

  const shown = useMemo(() => {
    const q = dir.toLowerCase();
    return dirs.filter((d) => !q || tilde(d.path).toLowerCase().includes(q.replace(/^~/, "")) || d.path.toLowerCase().includes(q)).slice(0, 40);
  }, [dir, dirs]);

  const start = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api(`/api/sessions${hq}`, { method: "POST", body: { dir: dir.trim(), name: name.trim(), prompt } });
      onClose();
      say("Session started.");
      go(r.id);
    } catch (e) {
      setErr(e.status === 409 ? "Claude Code hasn't been trusted in this folder yet. Open Claude there once and accept the prompt, then try again." : e.message);
    }
    setBusy(false);
  };

  return html`
    <div class="veil" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <form class="sheet" onSubmit=${start}>
        <h3>New session</h3>
        ${hosts.length > 1 && html`
          <div class="field"><span>Machine</span>
            <div class="seg">${hosts.map((h) => html`<button type="button" class=${h === host ? "on" : ""} onClick=${() => { setHost(h); setDir(""); }}>${h}</button>`)}</div>
          </div>`}
        <label class="field">
          <span>Folder</span>
          <input value=${dir} onInput=${(e) => setDir(e.target.value)} placeholder="~/projects/app" autofocus autocapitalize="off" autocomplete="off" spellcheck="false" />
          <div class="dirs">
            ${shown.map((d) => html`<button type="button" class=${tilde(d.path) === dir ? "on" : ""} onClick=${() => setDir(tilde(d.path))}>${tilde(d.path)}${d.recent && html`<span class="r">recent</span>`}</button>`)}
            ${shown.length === 0 && html`<p class="empty" style="padding: 10px">No match. A full path works too.</p>`}
          </div>
        </label>
        <label class="field"><span>Name</span><input value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Optional" /><small>Without one, Claude titles the session from what you ask.</small></label>
        <label class="field"><span>First message</span><textarea rows="3" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder="Optional. You can also type it in the terminal."></textarea></label>
        ${err && html`<p class="err">${err}</p>`}
        <div class="actions">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn primary" disabled=${!dir.trim() || busy}>${busy ? "Starting…" : "Start session"}</button>
        </div>
      </form>
    </div>
  `;
}

navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()), () => {});
render(html`<${App} />`, document.getElementById("app"));
