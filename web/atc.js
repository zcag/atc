(() => {
  const inAtc = window.parent !== window;
  const KEY = "atc.page." + location.pathname;
  const waiting = new Map(), changed = new Set();
  let seq = 0;
  const ask = (op, arg) => new Promise((ok, no) => {
    const id = ++seq;
    waiting.set(id, { ok, no });
    parent.postMessage({ atc: 1, id, op, arg }, "*");
  });
  addEventListener("message", (e) => {
    const m = e.data;
    if (!inAtc || e.source !== parent || !m || m.atc !== 1) return;
    if (m.op === "scroll") return location.hash || scrollTo(0, m.y);
    if (m.op === "state") return changed.forEach((fn) => fn());
    if (m.op === "look") return look(m);
    if (m.op === "changes") return document.documentElement.classList.toggle("atc-nochanges", !m.on);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.no(new Error(m.error)) : w.ok(m.value);
  });
  const look = ({ scheme, theme }) => {
    const r = document.documentElement;
    if (!getComputedStyle(r).getPropertyValue("--ink")) return;
    if (scheme === "light" || scheme === "dark") r.dataset.scheme = scheme; else delete r.dataset.scheme;
    if (!/^[a-z]*$/.test(theme || "")) return;
    if (theme && !document.querySelector(`link[data-atc-theme="${theme}"]`)) {
      const l = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `/themes/${theme}.css` });
      l.dataset.atcTheme = theme;
      document.head.append(l);
    }
    if (theme) r.dataset.theme = theme; else delete r.dataset.theme;
  };
  const local = {
    get: () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
    set: (v) => {
      const obj = (x) => x && typeof x === "object" && !Array.isArray(x);
      const cur = local.get();
      if (obj(v) && (cur == null || obj(cur))) v = Object.fromEntries(Object.entries({ ...cur, ...v }).filter(([, x]) => x !== null));
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {}
    },
  };
  const copy = (text) => {
    if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(text);
    const t = Object.assign(document.createElement("textarea"), { value: text });
    t.style.cssText = "position:fixed;opacity:0";
    document.body.append(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  };
  const png = (url) => fetch(url).then((r) => r.blob()).then((b) => b.type === "image/png" ? b : createImageBitmap(b).then((i) => {
    const c = Object.assign(document.createElement("canvas"), { width: i.width, height: i.height });
    c.getContext("2d").drawImage(i, 0, 0);
    return new Promise((ok) => c.toBlob(ok, "image/png"));
  }));
  const copyImage = (url) => navigator.clipboard.write([new ClipboardItem({ "image/png": png(url) })]);
  let shown;
  const toast = (text, label, fn, ms = 4000) => {
    shown && shown.remove();
    const t = shown = Object.assign(document.createElement("div"), { className: "toast", role: "status" });
    t.append(String(text));
    const end = () => { t.classList.add("out"); setTimeout(() => t.remove(), 200); if (shown === t) shown = null; };
    if (label && fn) {
      const b = Object.assign(document.createElement("button"), { textContent: label });
      b.onclick = () => { clearTimeout(t.timer); end(); fn(); };
      t.append(b);
    }
    t.timer = setTimeout(end, ms);
    document.body.append(t);
  };
  window.atc = {
    inAtc,
    toast,
    state: {
      get: () => (inAtc ? ask("state.get") : Promise.resolve(local.get())),
      set: (v) => (inAtc ? ask("state.set", v) : Promise.resolve(local.set(v))),
      onChange: (fn) => { changed.add(fn); return () => changed.delete(fn); },
    },
    send: (text) => (inAtc ? ask("send", String(text)) : copy(String(text)).then(() => false)),
    copy: (text) => (inAtc ? ask("copy", String(text)) : copy(String(text))),
    copyImage: (url) => (inAtc ? ask("copyImage", new URL(url, location.href).href) : copyImage(new URL(url, location.href).href)),
    run: (name, args = []) => (inAtc ? ask("run", { action: String(name), args: [].concat(args).map(String) })
      : Promise.reject(new Error("atc.run works only inside atc, where the page was shown with atc show --action"))),
    open: (url) => (inAtc ? ask("open", new URL(url, location.href).href) : Promise.resolve(void open(url, "_blank", "noopener"))),
  };
  let watch;
  const jump = () => {
    watch && watch.disconnect();
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch {}
    if (!id) return;
    const go = () => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView({ block: "start" });
      getComputedStyle(el).animationName !== "a-at" && el.animate && el.animate([{ outline: "2px solid #e8a33d", outlineOffset: "3px", background: "rgba(232,163,61,.18)" }, { outline: "2px solid transparent", outlineOffset: "3px" }], { duration: 2600, easing: "ease-in" });
      return true;
    };
    if (go()) return;
    const w = watch = new MutationObserver(() => go() && w.disconnect());
    w.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => w.disconnect(), 8000);
  };
  addEventListener("hashchange", jump);
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", jump) : jump();
  if (!inAtc) return;
  addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented) return;
    const u = new URL(a.getAttribute("href"), location.href);
    if (!/^https?:$/.test(u.protocol) || (u.host === location.host && !(u.pathname === "/" && u.hash))) return;
    e.preventDefault();
    ask("open", u.href);
  });
  const reading = new Set([" ", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter"]);
  addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || reading.has(e.key) || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "")) return;
    parent.postMessage({ atc: 1, op: "key", arg: { key: e.key, code: e.code, altKey: e.altKey, shiftKey: e.shiftKey } }, "*");
  });
  let t = 0;
  addEventListener("scroll", () => {
    clearTimeout(t);
    t = setTimeout(() => parent.postMessage({ atc: 1, op: "at", arg: scrollY }, "*"), 150);
  }, { passive: true });
  parent.postMessage({ atc: 1, op: "hello" }, "*");
})();
