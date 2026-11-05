import { html, useState, useEffect, useCallback } from "./vendor/preact-htm.js";

export const slug = (g) => g.toLowerCase().replace(/\s+/g, "-");
const word = (r) => (r.status === "ok" ? "Working" : r.status === "broken" ? "Stopped working" : r.optional ? "Not set up" : "Needed");
const tone = (r) => (r.status === "ok" ? "ok" : r.status === "broken" || r.warn ? "bad" : "off");

/** Where the page is pointing inside Settings: #/settings#calls is the Calls section, #/settings#talker one row. */
const anchorNow = () => (location.hash.match(/^#\/settings#(.+)$/) || [])[1] || "";

export const useCaps = (api) => {
  const [rep, setRep] = useState(null);
  const load = useCallback((fresh) => api(`/api/caps${fresh ? "?fresh=1" : ""}`).then(setRep, () => setRep((r) => r || { groups: [], machines: [], failed: true })), []);
  useEffect(() => { load(); }, []);
  return [rep, load];
};

/** Core's checks on the home machine, while something required is missing; null otherwise, and when they can't be read: a failed check never blocks the app. */
export function useSetup(me, api) {
  const [core, setCore] = useState(null);
  const [skipped, setSkipped] = useState(() => { try { return !!sessionStorage.getItem("atc.setup.skip"); } catch { return false; } });
  const check = useCallback((fresh) => api(`/api/caps?local=1&group=core${fresh ? "&fresh=1" : ""}`).then((r) => setCore(r.machines[0]), () => setCore(null)), []);
  const needed = !skipped && !!core?.rows?.some((r) => r.warn);
  useEffect(() => { if (me) check(); }, [!!me]);
  useEffect(() => {
    if (!needed) return;
    const t = setInterval(() => check(true), 5000);
    return () => clearInterval(t);
  }, [needed]);
  const skip = () => { try { sessionStorage.setItem("atc.setup.skip", "1"); } catch {} setSkipped(true); };
  return { machine: needed ? core : null, check, skip };
}

/** `backticks` in a fix's words are commands. */
const words = (t) => t.split("`").map((x, i) => (i % 2 ? html`<code>${x}</code>` : x));

function Command({ text, ui }) {
  return html`<div class="capcmd"><code>${text}</code><button class="btn" onClick=${() => { ui.copyText(text); ui.say("Copied."); }}>Copy</button></div>`;
}

function Fix({ r, ui }) {
  const f = r.fix || {};
  return html`<div class="capfix">
    ${f.command && html`<${Command} text=${f.command} ui=${ui} />`}
    ${f.text && html`<p>${words(f.text)}</p>`}
    ${f.guideUrl && html`<p><a href=${f.guideUrl} data-out>${f.guideName}, in atc's docs</a></p>`}
  </div>`;
}

function Fields({ r, host, ui, reload, onTested }) {
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const fields = r.fields || [];
  const dirty = Object.keys(vals).length > 0;
  const q = ui.hostQ(host, ui.home);
  const typed = (f, v) => setVals((o) => { const n = { ...o }; v === (f.secret ? "" : f.value || "") ? delete n[f.key] : (n[f.key] = v); return n; });
  const run = (what, fn) => { setBusy(what); setErr(null); fn().catch((e) => setErr(e.message)).finally(() => setBusy(null)); };
  const save = (env) => run("save", async () => {
    const res = await ui.api(`/api/settings${q}`, { method: "PUT", body: { env } });
    setVals({});
    await reload(true);
    ui.say(res.overridden?.length ? `Saved, but atc's environment sets ${res.overridden.join(", ")} and wins.` : res.restart?.length ? `Saved. Restart ${res.restart.join(" and ")} to apply it.` : "Saved.");
  });
  const test = () => run("test", async () => onTested(await ui.api(`/api/caps/${r.id}/test${q}`, { method: "POST", body: { values: vals } })));
  const body = () => Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.trim() || null]));
  return html`<form class="capfields" onSubmit=${(e) => { e.preventDefault(); dirty && save(body()); }}>
    ${fields.map((f) => html`<label class="capfield">
      <span>${f.label}</span>
      <input value=${vals[f.key] ?? (f.secret ? "" : f.value || "")} type=${f.secret ? "password" : "text"} autocomplete="off" autocapitalize="off" spellcheck="false" disabled=${f.source === "env"}
        placeholder=${f.secret && f.set ? "Set, and hidden" : f.hint || ""} onInput=${(e) => typed(f, e.target.value)} />
      <small>${f.key}${f.source === "env" ? ", set in atc's environment, which overrides this page" : ""}</small>
      ${f.secret && f.set && f.source === "settings" && html`<button type="button" class="linkish" onClick=${() => save({ [f.key]: null })}>Remove this one</button>`}
    </label>`)}
    ${err && html`<p class="capmsg bad" role="alert">${err}</p>`}
    <div class="capbtns">
      <button type="button" class="btn" disabled=${!!busy} onClick=${test}>${busy === "test" ? "Testing" : "Test"}</button>
      <button class="btn primary" disabled=${!dirty || !!busy}>${busy === "save" ? "Saving" : "Save"}</button>
    </div>
  </form>`;
}

function Row({ r: live, host, ui, reload, canStart, open: opened }) {
  const [tested, setTested] = useState(null);
  const [open, setOpen] = useState(opened);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTested(null); }, [live]);
  useEffect(() => { if (opened) setOpen(true); }, [opened]);
  const r = tested || live;
  const start = async () => {
    setBusy(true);
    try {
      const s = await ui.api(`/api/sessions${ui.hostQ(host, ui.home)}`, { method: "POST", body: { dir: "~", name: `Set up ${r.title}`, prompt: r.setup } });
      ui.go(s.id);
    } catch (e) { ui.say(`Could not start the session: ${e.message}`); }
    setBusy(false);
  };
  const needs = r.needs || [];
  return html`<div class="caprow ${tone(r)}" id=${`row-${r.id}`}>
    <button class="caphd" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <i class="mark" aria-hidden="true"></i><b>${r.title}</b><span class="st">${word(r)}</span>
    </button>
    <p class="capd">${tested && html`<span class="tag">Tested now</span> `}${r.detail}</p>
    ${open && html`<div class="capbody">
      ${r.why && html`<p>${r.why}</p>`}
      ${needs.length > 0 && html`<p class="capneeds">Needs ${needs.map((n, i) => html`${i > 0 && ", "}<a href=${`#/settings#${n.id}`} class=${n.status === "ok" ? "" : "unmet"}>${n.title}</a>${n.status !== "ok" && " (not yet)"}`)}</p>`}
      ${r.status !== "ok" && html`<${Fix} r=${r} ui=${ui} />`}
      ${r.cost && html`<p class="capcost">Costs: ${r.cost}</p>`}
      ${(r.fields || []).length > 0 && html`<${Fields} r=${r} host=${host} ui=${ui} reload=${reload} onTested=${setTested} />`}
      ${r.setup && canStart && html`<div class="capbtns"><button class="btn" disabled=${busy} onClick=${start}>${busy ? "Starting" : "Set this up with Claude"}</button></div>`}
    </div>`}
  </div>`;
}

function IdentityForm({ m, ui, reload }) {
  const id = m.identity || {};
  const [v, setV] = useState({ user: id.user || "", assistant: id.assistant || "", language: id.language || "" });
  const [busy, setBusy] = useState(false);
  const dirty = ["user", "assistant", "language"].some((k) => v[k] !== (id[k] || ""));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await ui.api(`/api/settings${ui.hostQ(m.host, ui.home)}`, { method: "PUT", body: v });
      await reload();
      ui.say(res.restart?.length ? `Saved. Restart ${res.restart.join(" and ")} to apply it.` : "Saved.");
    } catch (x) { ui.say(x.message); }
    setBusy(false);
  };
  const box = (k, label, hint, ph) => html`<label class="capfield"><span>${label}</span>
    <input value=${v[k]} placeholder=${ph} autocomplete="off" onInput=${(e) => setV({ ...v, [k]: e.target.value })} /><small>${hint}</small></label>`;
  return html`<form class="caprow ident" onSubmit=${save}>
    <div class="capfields">
      ${box("user", "Your name", "How the assistant's built-in prompts call you", "the user")}
      ${box("assistant", "Its name", "How they call it", "the assistant")}
      ${box("language", "Language", "Two letters; the language voice notes are heard in", "en")}
      <div class="capbtns"><button class="btn primary" disabled=${!dirty || busy}>${busy ? "Saving" : "Save"}</button></div>
    </div>
  </form>`;
}

export function CapsBanner({ rep }) {
  const m = rep?.machines || [];
  const warn = m.flatMap((x) => (x.rows || []).filter((r) => r.warn).map((r) => ({ ...r, host: x.host })));
  if (!warn.length) return null;
  return html`<p class="capsum" role="status">Needs attention: ${warn.map((r, i) => html`${i > 0 && ", "}<a href=${`#/settings#${r.id}`}>${r.title}${m.length > 1 ? ` on ${r.host}` : ""}</a>`)}.</p>`;
}

export function CapsSections({ rep, reload, ui, noMic, only = () => true }) {
  const machines = rep?.machines || [];
  const [host, setHost] = useState(null);
  const [at, setAt] = useState(anchorNow);
  useEffect(() => {
    const f = () => setAt(anchorNow());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const hit = machines.find((x) => x.host === host) ? null : machines[0];
  const m = hit || machines.find((x) => x.host === host);
  useEffect(() => {
    if (at && m) requestAnimationFrame(() => (document.getElementById(at) || document.getElementById(`row-${at}`))?.scrollIntoView({ block: "start" }));
  }, [at, !!m]);
  if (!rep) return html`<section id="caps"><h2>What atc can do</h2><p class="capd">Checking what is set up…</p></section>`;
  if (!m) return html`<section id="caps"><h2>What atc can do</h2><p class="capmsg bad">The checks did not answer.</p><div class="capbtns"><button class="btn" onClick=${() => reload(true)}>Check again</button></div></section>`;
  const inGroup = (g) => (m.rows || []).filter((r) => r.group === g);
  const claudeOK = ["claude", "signin"].every((id) => (m.rows || []).find((r) => r.id === id)?.status === "ok");
  return html`
    ${machines.length > 1 && html`<div class="capmachines"><${ui.Seg} label="Machine" value=${m.host} set=${setHost} options=${machines.map((x) => [x.host, x.host])} /></div>`}
    ${m.error && html`<p class="capmsg bad">${m.error}</p>`}
    ${m.settingsError && html`<p class="capmsg bad" role="alert">${m.settingsError}</p>`}
    <div class="capbtns capagain"><button class="btn" onClick=${() => reload(true)}>Check everything again</button></div>
    ${m.restartCommand && html`<div class="caprestart" role="status"><p>Saved settings wait for a restart.</p><${Command} text=${m.restartCommand} ui=${ui} /></div>`}
    ${rep.groups.filter((g) => inGroup(g).length && only(g)).map((g) => {
      const rows = inGroup(g), set = rows.filter((r) => r.status === "ok").length, bad = rows.filter((r) => r.status === "broken").length;
      return html`<section id=${slug(g)}>
        <h2>${g} <span class="n">${bad ? `${bad} stopped working` : set === rows.length ? "all working" : set ? `${set} of ${rows.length} working` : "not set up"}</span></h2>
        ${g === "Assistant" && html`<${IdentityForm} key=${m.host} m=${m} ui=${ui} reload=${reload} />`}
        ${g === "Calls" && noMic && html`<p class="capmsg">This page can't use the microphone here: browsers only allow it over HTTPS.</p>`}
        ${rows.map((r) => html`<${Row} key=${`${m.host}/${r.id}`} r=${r} host=${m.host} ui=${ui} reload=${reload} canStart=${claudeOK}
          open=${r.warn || at === r.id || (at === slug(g) && r.status !== "ok")} />`)}
      </section>`;
    })}`;
}

export function SetupScreen({ machine, check, skip, ui }) {
  const [checking, setChecking] = useState(false);
  const again = async () => { setChecking(true); await check(true); setChecking(false); };
  return html`<div class="pghome settings setup" role="dialog" aria-label="Set up atc">
    <div class="pgbody"><div class="setpage">
      <section id="setup">
        <h1>Set up atc</h1>
        <p class="capintro">atc runs your Claude Code sessions, so it needs Claude Code working on ${machine.host} first. This screen moves on by itself once it does.</p>
        ${machine.rows.map((r) => html`<${Row} key=${r.id} r=${r} host=${machine.host} ui=${ui} reload=${check} canStart=${false} open=${r.warn} />`)}
        <div class="capbtns end">
          <button class="btn" onClick=${skip}>Continue anyway</button>
          <button class="btn primary" disabled=${checking} onClick=${again}>${checking ? "Checking" : "Check again"}</button>
        </div>
      </section>
    </div></div>
  </div>`;
}
