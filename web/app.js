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
const tilde = (p) => (HOME && p && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p || "");
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

function App() {
  const [me, setMe] = useState(undefined);
  const [live, setLive] = useState(null);
  const [up, setUp] = useState(true);
  const [past, setPast] = useState({});
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState(null);
  const route = useRoute();
  useNow(30000);

  useEffect(() => {
    api("/api/me").then(setMe, (e) => setMe(e.auth ? null : { host: "" }));
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
    const n = (live || []).filter((s) => s.state === "needs-you").length;
    document.title = n ? `(${n}) atc` : "atc";
  }, [live]);

  const say = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  if (me === undefined) return null;
  if (me === null) return html`<${Login} onDone=${setMe} />`;
  HOME = me.home || HOME;
  CLAUDE_THEME = me.claudeTheme || CLAUDE_THEME;

  const all = live || [];
  const sel = route && (all.find((s) => s.id === route || s.sessionId === route) || past[route]);
  const remember = (list) => setPast((p) => Object.fromEntries([...Object.entries(p), ...list.map((s) => [s.sessionId, s])]));

  return html`
    <div class="shell ${route ? "open" : ""}">
      <aside class="side">
        <header class="top">
          <span class="mark">atc</span>
          <span class="host">${me.host ? `on ${me.host}` : ""}</span>
          <span class="conn ${up ? "" : "down"}" title=${up ? "Live" : "Reconnecting"}></span>
          <span class="grow"></span>
          <button class="btn primary" onClick=${() => setCreating(true)}>New session</button>
        </header>
        <${Board} live=${live} sel=${sel} onPast=${remember} />
      </aside>
      <main class="main">
        ${sel
          ? html`<${Session} key=${sel.sessionId} s=${sel} say=${say} live=${all} />`
          : html`<div class="blank">${route && live ? "This session is gone. Pick another from the list." : "Pick a session, or start a new one."}</div>`}
      </main>
    </div>
    ${creating && html`<${NewSession} onClose=${() => setCreating(false)} say=${say} />`}
    ${toast && html`<div class="toast" role="status">${toast}</div>`}
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

function Board({ live, sel, onPast }) {
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
  const pinned = live.filter((s) => s.pinned);
  const rest = live.filter((s) => !s.pinned);

  return html`
    <div class="board">
      ${live.length === 0 && html`<p class="empty">Nothing is running. Start a session, or pick up an earlier one below.</p>`}
      ${pinned.length > 0 && html`<${Bay} title="Pinned" list=${pinned} sel=${sel} />`}
      ${BAYS.map(([st, title]) => html`<${Bay} title=${title} list=${rest.filter((s) => s.state === st)} sel=${sel} />`)}
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

function Bay({ title, list, sel }) {
  if (!list.length) return null;
  return html`
    <section class="bay">
      <h2>${title} <span class="n">${list.length}</span></h2>
      <div class="rack">${list.map((s) => html`<${Strip} s=${s} sel=${sel} />`)}</div>
    </section>
  `;
}

function Strip({ s, sel }) {
  const on = sel && sel.sessionId === s.sessionId;
  return html`
    <button class="strip ${s.state} ${on ? "sel" : ""}" onClick=${() => go(keyOf(s))} aria-current=${on ? "true" : null}>
      <div class="l1">
        <span class="title">${s.title || "Untitled"}</span>
        <span class="when">${s.state === "working" ? html`<${Elapsed} s=${s} />` : ago(s)}</span>
      </div>
      <div class="l2">
        <span class="word">${WORD[s.state] || s.state}</span>
        ${s.id && html`<span class="call">${s.id}</span>`}
        <span>${tilde(s.cwd)}</span>
        ${s.branch && s.branch !== "HEAD" && html`<span>${s.branch}</span>`}
        ${s.model && html`<span>${model(s.model)}</span>`}
        ${s.permissionMode === "bypassPermissions" && html`<span class="tag bypass">bypass</span>`}
        ${s.kind === "interactive" && html`<span class="tag">in a terminal</span>`}
      </div>
      ${s.lastPrompt && html`<div class="said">${s.lastPrompt.replace(/\s+/g, " ")}</div>`}
    </button>
  `;
}

function Elapsed({ s }) {
  useNow(1000);
  const t = Date.parse(s.promptAt || s.updated || s.startedAt);
  const d = Math.max(0, Math.floor((Date.now() - t) / 1000));
  return d < 3600 ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}` : ago(s);
}

function Session({ s, say, live }) {
  const canAttach = s.attachable;
  const [mode, setMode] = useState(canAttach ? "term" : "chat");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
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
  const stop = () => act(() => api(`/api/sessions/${s.id}/stop`, { method: "POST" }), () => say("Stopped. Resume it any time."));
  const remove = () =>
    confirm(`Delete "${s.title}"? Its conversation stays in history.`) &&
    act(() => api(`/api/sessions/${s.id}`, { method: "DELETE" }), () => go(s.sessionId));
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
        </div>
      </div>
      <div class="seg" role="tablist">
        <button class=${mode === "term" ? "on" : ""} onClick=${() => setMode("term")}>Terminal</button>
        <button class=${mode === "chat" ? "on" : ""} onClick=${() => setMode("chat")}>Transcript</button>
      </div>
      <${Menu} s=${s} busy=${busy} onRename=${() => setRenaming(true)} onPin=${() => patch({ pinned: !s.pinned })} onStop=${stop} onRemove=${remove} onResume=${resume} />
    </div>
    ${mode === "term"
      ? canAttach
        ? html`<${Term} key=${s.id} s=${s} />`
        : html`<div class="stage"><div class="cover">${Unattachable(s, resume, busy, setMode)}</div></div>`
      : html`<${Transcript} s=${s} />`}
  `;
}

function Unattachable(s, resume, busy, setMode) {
  if (s.kind === "interactive")
    return html`<div><p class="h">Open in a terminal</p><p>This session runs in a terminal window on the server, so it can't be shown here. You can read along in the transcript.</p><div class="row"><button class="btn" onClick=${() => setMode("chat")}>Read transcript</button></div></div>`;
  return html`<div><p class="h">${s.state === "stopped" ? "Stopped" : "Not running"}</p><p>Resume it to pick up where it left off. The whole conversation comes back.</p><div class="row"><button class="btn primary" disabled=${busy} onClick=${resume}>${busy ? "Resuming…" : "Resume"}</button></div></div>`;
}

function Menu({ s, busy, onRename, onPin, onStop, onRemove, onResume }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const f = (e) => !ref.current?.contains(e.target) && setOpen(false);
    addEventListener("pointerdown", f);
    return () => removeEventListener("pointerdown", f);
  }, [open]);
  const item = (label, fn, cls = "") => html`<button class="btn ${cls}" disabled=${busy} onClick=${() => { setOpen(false); fn(); }}>${label}</button>`;
  return html`
    <div ref=${ref} style="position: relative">
      <button class="icon" aria-label="More actions" aria-expanded=${open} onClick=${() => setOpen(!open)}>•••</button>
      ${open && html`
        <div class="sheet" style="position: absolute; right: 0; top: 36px; width: 190px; padding: 8px; display: flex; flex-direction: column; gap: 6px; z-index: 10">
          ${item("Rename", onRename)}
          ${item(s.pinned ? "Unpin" : "Pin to top", onPin)}
          ${s.attachable && item("Stop", onStop)}
          ${!s.attachable && s.kind !== "interactive" && item("Resume", onResume)}
          ${s.id && item("Delete", onRemove, "danger")}
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

function Term({ s }) {
  const box = useRef();
  const api_ = useRef({});
  const [gen, setGen] = useState(0);
  const [cover, setCover] = useState(null);
  const [foreign, setForeign] = useState(null);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  useEffect(() => {
    setCover(null);
    const el = box.current;
    const term = new Terminal({
      fontFamily: '"Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
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
    ws.onclose = () => !exited && setCover("lost");
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

  return html`
    <div class="stage" style=${`--term-bg: ${PALETTE[CLAUDE_THEME].background}`}>
      <div class="term" ref=${box}></div>
      ${foreign && !cover && html`
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
              <button class="btn primary" onClick=${() => setGen(gen + 1)}>Reopen</button>
              <button class="btn" onClick=${() => go(null)}>Back to list</button>
            </div>
          </div>
        </div>`}
      <div class="keys" onPointerDown=${(e) => e.preventDefault()}>
        ${KEYS.map(([label, seq]) => html`<button class=${label === "ctrl" && ctrl ? "on" : ""} onClick=${() => key(label, seq)}>${label}</button>`)}
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
        ${(msgs || []).map((m) =>
          m.role === "tool"
            ? html`<div class="tool"><b>${m.tool}</b><span>${m.detail}</span></div>`
            : m.role === "user"
              ? html`<div class="msg user">${m.text}</div>`
              : html`<div class="msg assistant" dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div>`
        )}
      </div>
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

function NewSession({ onClose, say }) {
  const [dirs, setDirs] = useState([]);
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api("/api/dirs").then((d) => setDirs(d || []), () => {}); }, []);
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
      const r = await api("/api/sessions", { method: "POST", body: { dir: dir.trim(), name: name.trim(), prompt } });
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

render(html`<${App} />`, document.getElementById("app"));
