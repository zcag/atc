import { rig, Director, framing } from "./rig.js";

const PERSONAS = "/app/personas/", ROOMS = PERSONAS + "_rooms/";
const STATES = ["listening", "hearing", "thinking", "tool", "speaking"];
const SLOTS = ["eyes", "brows", "mouth"];
const NEUTRAL = { yaw: 0, pitch: 0, roll: 0, sway: 0, lean: 0, breath: .5, gazeX: 0, gazeY: 0, blinkR: 0, blinkL: 0, brow: 0, knit: 0, smile: 0, jaw: 0, round: 0, wide: 0, serious: 0, pose: null };
const TILE_W = 768, TILE_H = 1344;
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat().filter((k) => k != null)); return e; };
const query = new URLSearchParams(location.search);

const S = { name: null, R: null, extra: {}, room: query.get("room") || "own", state: "listening", forced: null, seen: {}, seenT: 0, tab: query.get("tab") || "eyes", angle: "y0p0", diff: false, tiles: null, stop: null, cycle: null };

const anglesOf = (R) => Object.entries(R.angles).sort(([, a], [, b]) => a[1] - b[1] || a[0] - b[0]);
const parse = (name) => { const [angle, slot, draw] = name.split("."); return { angle, slot, draw }; };
const drawingsOf = (R, slot) => [...new Set(R.parts.map((p) => parse(p.name)).filter((p) => p.slot === slot).map((p) => p.draw))].sort(order);
const posesOf = (R) => R.parts.filter((p) => p.name.startsWith("pose.")).map((p) => p.name.slice(5));
const order = (a, b) => a.localeCompare(b, "en", { numeric: true });
const has = (R, angle, slot, draw) => R.parts.some((p) => p.name === `${angle}.${slot}.${draw}`);

/** Which drawings the Director ever asks for: swept over its whole input range, so a drawing it never picks shows as such. */
function picked(R) {
  const d = new Director(R), out = { eyes: new Set(), brows: new Set(), mouth: new Set(), pose: new Set() };
  const vals = [-1, -.6, -.3, 0, .3, .6, 1];
  const go = (p) => { for (let i = 0; i < 3; i++) d.step(1, { ...NEUTRAL, ...p }); for (const s of SLOTS) out[s].add(d[s].cur); };
  for (const [, [ky, kp]] of Object.entries(R.angles)) {
    const yaw = -ky / 12, pitch = kp / 12;
    for (const gx of vals) for (const gy of vals) go({ yaw, pitch, gazeX: gx, gazeY: gy });
    for (const pose of ["read", "write"]) for (const gx of vals) go({ yaw, pitch, pose, gazeX: gx, gazeY: .8 });
    for (const b of [.4, .9]) go({ yaw, pitch, blinkR: b, blinkL: b });
    for (const brow of [.5]) go({ yaw, pitch, brow });
    go({ yaw, pitch, knit: .5 });
    for (const jaw of [0, .15, .25, .35, .45, .55, .65, .72, .9]) for (const round of [0, .3, .6, 1]) for (const wide of [0, .3, .6, 1]) for (const serious of [0, 1]) go({ yaw, pitch, jaw, round, wide, serious });
    for (const smile of [.55, .8]) go({ yaw, pitch, smile });
  }
  return out;
}

async function json(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }
const maybe = (url) => json(url).catch(() => null);

async function loadIndex() {
  const index = await json(PERSONAS + "index.json");
  const names = index.personas.map((p) => p.name);
  const sel = $("#char");
  sel.replaceChildren(...index.personas.map((p) => el("option", { value: p.name, textContent: `${p.name} (rev ${p.rev})` })));
  const rooms = await json("/api/call/backgrounds").catch(() => []);
  $("#room").replaceChildren(el("option", { value: "own", textContent: "its own" }), el("option", { value: "none", textContent: "none" }), ...rooms.map((f) => el("option", { value: f, textContent: f.replace(/\.[^.]+$/, "") })));
  $("#room").value = S.room;
  sel.onchange = () => open(sel.value);
  $("#room").onchange = () => { S.room = $("#room").value; remember(); live(); };
  const want = query.get("c");
  open(names.includes(want) ? want : names[0]);
}

function remember() {
  const q = new URLSearchParams({ c: S.name, tab: S.tab });
  if (S.room !== "own") q.set("room", S.room);
  history.replaceState(null, "", "?" + q);
}

async function open(name) {
  S.name = name;
  $("#char").value = name;
  const base = PERSONAS + name + "/";
  const [R, source, verify, persona] = await Promise.all([json(base + "rig.json"), maybe(base + "source.json"), maybe(base + "verify.json"), maybe(base + "persona.json")]);
  S.R = R;
  S.extra = { source, verify, persona, room: R.room ? await maybe(base + R.room) : null };
  S.picked = picked(R);
  S.tiles = null;
  S.forced = null;
  S.seen = {};
  S.seenT = 0;
  if (!R.angles[S.angle]) S.angle = anglesOf(R)[0][0];
  remember();
  tabs();
  await live();
  render();
}

/** A made-up voice: syllables of varying loudness and brightness in phrases, so speaking moves the mouth through its shapes. */
function voice() {
  let t = 0, syl = 0, end = 0, amp = 0, tone = .4, left = 0, gap = 0;
  return (dt) => {
    t += dt;
    if (gap > 0) { gap -= dt; return { it: 0, lo: 0, hi: 0 }; }
    if (t >= end) {
      if (left-- <= 0) { left = 5 + Math.floor(Math.random() * 10); gap = .35 + Math.random() * .5; }
      syl = .1 + Math.random() * .16; end = t + syl; amp = .3 + Math.random() * .7; tone = Math.random();
    }
    const k = 1 - (end - t) / syl, a = amp * Math.sin(Math.PI * Math.min(1, Math.max(0, k)));
    return { it: a, lo: a * (1 - tone), hi: a * tone * 3 };
  };
}

function forcing(d) {
  const f = S.forced;
  if (!f) return;
  const A = d.angle;
  A.cur = f.angle; A.prev = null; A.k = 1;
  for (const s of SLOTS) { d[s].cur = f.slot === s ? f.draw : "base"; d[s].prev = null; d[s].k = 1; }
  d.pose = { cur: f.pose || null, k: f.pose ? 1 : 0 };
}

const forcedParams = () => { const [ky, kp] = S.R.angles[S.forced.angle]; return { ...NEUTRAL, yaw: -ky / 12, pitch: kp / 12, pose: S.forced.pose || null }; };

async function live() {
  S.stop?.();
  const old = $("#live"), canvas = old.cloneNode();
  old.replaceWith(canvas);
  const speak = voice(), you = voice();
  let last = performance.now(), sig = { it: 0, lo: 0, hi: 0 }, heard = 0;
  const now = () => {
    const t = performance.now(), dt = Math.min(.1, (t - last) / 1000);
    last = t;
    sig = S.state === "speaking" ? speak(dt) : { it: 0, lo: 0, hi: 0 };
    heard = S.state === "hearing" ? you(dt).it : 0;
    return { state: S.state, you: heard, ...sig };
  };
  const opts = {
    room: S.room === "none" ? false : undefined,
    background: S.room !== "own" && S.room !== "none" ? ROOMS + S.room : undefined,
    params: (p) => (S.forced ? forcedParams() : p),
    tick: (p, d) => { forcing(d); readout(p, d); },
  };
  S.stop = await rig(canvas, PERSONAS + S.name + "/", now, opts).catch((e) => { canvas.replaceWith(el("p", { className: "note", textContent: "Can't draw it: " + e.message })); return null; });
}

let shown = 0;
function readout(p, d) {
  const t = performance.now(), dt = Math.min(.1, (t - (readout.last || t)) / 1000);
  readout.last = t;
  if (!S.forced) {
    S.seenT += dt;
    for (const s of SLOTS) { const k = `${s}.${d[s].cur}`; S.seen[k] = (S.seen[k] || 0) + dt; }
    const a = `angle.${d.angle.cur}`, z = `pose.${d.pose.cur || "none"}`;
    S.seen[a] = (S.seen[a] || 0) + dt;
    S.seen[z] = (S.seen[z] || 0) + dt;
  }
  if (t - shown < 120) return;
  shown = t;
  const fmt = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));
  const rows = [
    ["angle", d.angle.cur + (d.angle.prev ? ` ← ${d.angle.prev}` : "")],
    ...SLOTS.map((s) => [s, d[s].cur + (d[s].prev ? ` ← ${d[s].prev}` : "")]),
    ["pose", d.pose.cur ? `${d.pose.cur} ${Math.round(d.pose.k * 100)}%` : "none"],
    ["head", `yaw ${fmt(p.yaw)} pitch ${fmt(p.pitch)} roll ${fmt(p.roll)}`],
    ["face", `jaw ${fmt(p.jaw)} smile ${fmt(p.smile)} brow ${fmt(p.brow)} knit ${fmt(p.knit)}`],
  ];
  $(".now tbody").replaceChildren(...rows.map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { textContent: v }))));
  $("#release").hidden = !S.forced;
  if (S.tab in TILED) for (const tile of document.querySelectorAll(".tile[data-key]")) {
    const k = tile.dataset.key, pct = S.seenT > 1 ? Math.round(100 * (S.seen[k] || 0) / S.seenT) : null, out = tile.querySelector(".seen");
    if (out) out.textContent = pct === null ? "" : `${pct}%`;
  }
}

function setState(s) {
  S.state = s;
  S.forced = null;
  for (const b of document.querySelectorAll(".states button")) b.setAttribute("aria-pressed", b.dataset.state === s);
  render();
}

function force(f) {
  S.forced = f;
  setStatePressed();
  render();
}
const setStatePressed = () => { for (const b of document.querySelectorAll(".states button")) b.setAttribute("aria-pressed", !S.forced && b.dataset.state === S.state); };

/** Every drawing through rig.js itself, one frame each with the Director held on it, on a canvas the size of the portrait. */
async function renderer() {
  if (S.tiles) return S.tiles;
  const canvas = el("canvas", { width: TILE_W, height: TILE_H });
  let want = { angle: "y0p0" };
  const frame = await rig(canvas, PERSONAS + S.name + "/", () => ({ state: "listening" }), {
    dt: 1 / 60, room: false,
    params: () => { const [ky, kp] = S.R.angles[want.angle]; return { ...NEUTRAL, yaw: -ky / 12, pitch: kp / 12, pose: want.pose || null }; },
    tick: (p, d) => { const was = S.forced; S.forced = want; forcing(d); S.forced = was; },
  });
  const view = framing(S.R, TILE_W, TILE_H), at = ([x, y]) => [((x - view[0]) * view[2] + 1) * TILE_W / 2, (1 - (y - view[1]) * view[3]) * TILE_H / 2];
  let ms = 0;
  const shot = (f, box) => {
    want = f;
    frame((ms += 1000 / 60));
    const [x0, y0] = box ? at([box[0], box[1]]) : [0, 0], [x1, y1] = box ? at([box[0] + box[2], box[1] + box[3]]) : [TILE_W, TILE_H];
    const w = Math.round(x1 - x0), h = Math.round(y1 - y0), out = el("canvas", { width: w, height: h });
    out.getContext("2d", { willReadFrequently: true }).drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    return out;
  };
  S.tiles = { shot, cache: {} };
  return S.tiles;
}

function cropFor(R, slot) {
  const boxes = R.parts.filter((p) => (slot === "head" ? p.name.split(".").length === 3 : parse(p.name).slot === slot)).map((p) => p.box);
  if (!boxes.length) return [0, 0, ...R.size];
  let x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
  let x1 = Math.max(...boxes.map((b) => b[0] + b[2])), y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  const pad = slot === "head" ? .45 : .22, w = x1 - x0, h = y1 - y0;
  x0 -= w * pad; x1 += w * pad; y0 -= h * pad * (slot === "head" ? 1.6 : 1); y1 += h * pad;
  const side = Math.max(x1 - x0, (y1 - y0) * (slot === "head" ? .8 : .5));
  const cx = (x0 + x1) / 2;
  return [cx - side / 2, y0, side, Math.max(y1 - y0, side * (slot === "head" ? 1.25 : .6))];
}

function difference(img, base) {
  const w = img.width, h = img.height, out = el("canvas", { width: w, height: h }), g = out.getContext("2d");
  const a = img.getContext("2d").getImageData(0, 0, w, h), b = base.getContext("2d").getImageData(0, 0, w, h), o = g.createImageData(w, h);
  for (let i = 0; i < a.data.length; i += 4) {
    const l = (b.data[i] * .3 + b.data[i + 1] * .59 + b.data[i + 2] * .11) * .45 + 40;
    const d = Math.min(255, (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) * 2.5);
    o.data[i] = l + d * .8; o.data[i + 1] = l + d * .25 - d * .1; o.data[i + 2] = l - d * .1; o.data[i + 3] = 255;
  }
  g.putImageData(o, 0, 0);
  return out;
}

async function tile(f, box, cap, key) {
  const T = await renderer(), id = JSON.stringify([f, box]);
  const img = (T.cache[id] ??= T.shot(f, box));
  let shown = img;
  if (S.diff && f.slot) {
    const bid = JSON.stringify([{ angle: f.angle }, box]);
    shown = difference(img, (T.cache[bid] ??= T.shot({ angle: f.angle }, box)));
  }
  const view = el("canvas", { width: img.width, height: img.height });
  view.getContext("2d").drawImage(shown, 0, 0);
  const on = S.forced && JSON.stringify(S.forced) === JSON.stringify(f);
  const b = el("button", { className: "tile" + (on ? " on" : ""), title: "Hold the live view on this drawing", onclick: () => force(f) }, view, el("div", { className: "cap" }, ...cap));
  if (key) b.dataset.key = key;
  return b;
}

const missingTile = (cap) => el("div", { className: "tile missing" }, el("div", { className: "cap" }, ...cap, el("span", { textContent: "not drawn here" })));

function angleChips(all) {
  const R = S.R;
  return el("div", { className: "chips" }, ...(all ? [el("button", { textContent: "all angles", "ariaPressed": String(S.angle === "*"), onclick: () => { S.angle = "*"; render(); } })] : []),
    ...anglesOf(R).map(([k]) => el("button", { textContent: k, ariaPressed: String(S.angle === k), onclick: () => { S.angle = k; render(); } })),
    el("button", { textContent: S.diff ? "showing what changes" : "show what changes", ariaPressed: String(S.diff), onclick: () => { S.diff = !S.diff; render(); } }));
}

async function slotPane(slot) {
  const R = S.R, names = drawingsOf(R, slot), box = cropFor(R, slot), pick = S.picked[slot];
  const cap = (draw) => [el("b", { textContent: draw }), !pick.has(draw) ? el("span", { className: "flag", textContent: "never picked" }) : el("span", { className: "seen" })];
  const note = el("p", { className: "note", textContent: `${names.length} drawings per angle. Tap one to hold the live view on it. The % is how much of the live view's time it has been on screen since this character opened (all angles).` });
  if (S.angle === "*") {
    const rows = await Promise.all(anglesOf(R).map(async ([a]) => el("tr", {}, el("th", { textContent: a }), ...(await Promise.all(names.map(async (n) => el("td", {}, has(R, a, slot, n) ? await tile({ angle: a, slot, draw: n }, box, [el("b", { textContent: n })]) : missingTile([el("b", { textContent: n })]))))))));
    return [angleChips(true), note, el("div", { className: "matrix" }, el("table", {}, el("tbody", {}, rows)))];
  }
  const a = S.angle;
  const base = await tile({ angle: a }, box, [el("b", { textContent: "base" }), el("span", { className: "seen" })], `${slot}.base`);
  const tiles = await Promise.all(names.map(async (n) => (has(R, a, slot, n) ? tile({ angle: a, slot, draw: n }, box, cap(n), `${slot}.${n}`) : missingTile(cap(n)))));
  return [angleChips(true), note, el("div", { className: "grid" }, base, tiles)];
}

async function anglesPane() {
  const R = S.R, box = cropFor(R, "head"), list = anglesOf(R), yaws = [...new Set(list.map(([, a]) => a[0]))].sort((a, b) => a - b);
  const grid = el("div", { className: "grid", style: `grid-template-columns: repeat(${yaws.length}, minmax(0, 1fr))` });
  for (const pitch of [...new Set(list.map(([, a]) => a[1]))].sort((a, b) => a - b)) for (const yaw of yaws) {
    const k = list.find(([, a]) => a[0] === yaw && a[1] === pitch)?.[0];
    grid.append(k ? await tile({ angle: k }, box, [el("b", { textContent: k }), el("span", { className: "seen" })], `angle.${k}`) : el("div"));
  }
  return [el("p", { className: "note", textContent: "Every head angle, neutral, as rows of pitch (up to bowed) and columns of yaw. Between them the head is bent by the mesh, up to about 6 degrees, and turns dissolve along the measured flow." }), grid];
}

async function posesPane() {
  const R = S.R, list = posesOf(R);
  const tiles = await Promise.all(list.map((z) => tile({ angle: "y0p0", pose: z }, null, [el("b", { textContent: z }), el("span", { className: "seen" })], `pose.${z}`)));
  return [el("p", { className: "note", textContent: "Pose layers, fully in, over the front angle. In a call they swing in from below the frame." }), el("div", { className: "grid poses" }, tiles)];
}

function checksPane() {
  const v = S.extra.verify, base = PERSONAS + S.name + "/";
  if (!v) return [el("p", { className: "note", textContent: "No verify.json: verify.py hasn't been run on this character." })];
  const failed = v.results.filter((r) => !r.pass).length;
  return [
    el("p", { className: "note" }, el("b", { className: v.pass ? "pass" : "fail", textContent: v.pass ? "Passes verify.py" : `${failed} checks fail` }), ` at ${v.hash?.slice(0, 12) || "?"}.`),
    el("table", {}, el("tbody", {}, v.results.map((r) => el("tr", {}, el("td", { className: r.pass ? "pass" : "fail", textContent: r.pass ? "pass" : "fail" }), el("th", { textContent: r.check }), el("td", { textContent: r.detail }))))),
    el("h2", { textContent: "Contact sheet (verify.jpg)" }),
    el("img", { className: "sheet", src: base + "verify.jpg", alt: "verify.py contact sheet", loading: "lazy" }),
  ];
}

function bar(v, max = 2) {
  return el("div", { className: "bar" }, el("i", { style: `width:${Math.min(100, (100 * v) / max)}%` }), el("u", { style: `left:${100 / max}%` }));
}

async function sourcePane() {
  const { source, persona, room } = S.extra, R = S.R, base = PERSONAS + S.name + "/";
  const out = [];
  out.push(el("h2", { textContent: "Portrait" }));
  if (source) {
    out.push(el("div", { className: "prompt", textContent: source.prompt || source.lost || "(no prompt)" }));
    out.push(el("table", {}, el("tbody", {}, Object.entries(source).filter(([k]) => k !== "prompt").map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { textContent: typeof v === "string" ? v : JSON.stringify(v) }))))));
  } else out.push(el("p", { className: "note", textContent: "No source.json." }));
  out.push(el("h2", { textContent: "Manner (1 is how the first characters act)" }));
  const manner = { head: 1, glance: 1, brow: 1, nod: 1, tilt: 1, gesture: 1, smile: 0, sheepish: 0, ...R.manner };
  out.push(el("table", {}, el("tbody", {}, Object.entries(manner).map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { className: "mono", textContent: v.toFixed(2) }), el("td", {}, bar(v, k === "smile" || k === "sheepish" ? 1 : 2)))))));
  const counts = SLOTS.map((s) => `${drawingsOf(R, s).length} ${s}`).join(", ");
  out.push(el("h2", { textContent: "Rig" }));
  out.push(el("table", {}, el("tbody", {}, [
    ["size", R.size.join(" × ")], ["angles", Object.keys(R.angles).length + ": " + Object.keys(R.angles).join(" ")], ["drawings per angle", counts],
    ["poses", posesOf(R).join(", ") || "none"], ["bones", R.boneOrder.join(" → ")], ["parts", R.parts.length], ["polished", R.polished ?? "no"],
    ["flow", R.flow ? `${Object.keys(R.flow.cells).length} angle pairs, ±${R.flow.range}px` : "none"], ["view", JSON.stringify(R.view)],
  ].map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { textContent: String(v) }))))));
  if (room) {
    out.push(el("h2", { textContent: "Its own room (room.json)" }));
    out.push(el("table", {}, el("tbody", {}, Object.entries(room).filter(([k]) => k !== "parts").map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { className: "mono", textContent: JSON.stringify(v) }))))));
  }
  out.push(el("h2", { textContent: "Files" }));
  const files = persona?.files || [];
  const sizes = await Promise.all(files.map((f) => fetch(base + f, { method: "HEAD" }).then((r) => +r.headers.get("content-length") || 0).catch(() => 0)));
  out.push(el("table", {}, el("tbody", {}, files.map((f, i) => el("tr", {}, el("td", {}, el("a", { href: base + f, textContent: f })), el("td", { className: "mono", textContent: `${(sizes[i] / 1024).toFixed(0)} KB` }))))));
  if (R.flow) out.push(el("h2", { textContent: "Flows between angles (flows.png)" }), el("img", { className: "sheet", src: base + R.flow.tex, alt: "flow fields", loading: "lazy" }));
  return out;
}

const TILED = { eyes: 1, brows: 1, mouth: 1, angles: 1, poses: 1 };
const TABS = { eyes: () => slotPane("eyes"), brows: () => slotPane("brows"), mouth: () => slotPane("mouth"), angles: anglesPane, poses: posesPane, checks: checksPane, source: sourcePane };

function tabs() {
  if (!TABS[S.tab]) S.tab = "eyes";
  $(".tabs").replaceChildren(...Object.keys(TABS).map((k) => el("button", { role: "tab", textContent: k[0].toUpperCase() + k.slice(1), ariaSelected: String(S.tab === k), onclick: () => { S.tab = k; remember(); tabs(); render(); } })));
}

let rendering = 0;
async function render() {
  const n = ++rendering, pane = $("#pane");
  if (!S.R) return;
  const kids = await TABS[S.tab]();
  if (n === rendering) pane.replaceChildren(...kids);
}

function cycle() {
  if (S.cycle) { clearTimeout(S.cycle); S.cycle = null; $("#cycle").textContent = "Run through the states"; return; }
  const plan = [["listening", 4], ["hearing", 4], ["thinking", 4], ["tool", 5], ["thinking", 2], ["speaking", 8]];
  let i = 0;
  const next = () => { const [s, sec] = plan[i++ % plan.length]; setState(s); S.cycle = setTimeout(next, sec * 1000); };
  $("#cycle").textContent = "Stop";
  next();
}

$(".states").append(...STATES.map((s) => el("button", { textContent: s, onclick: () => { if (S.cycle) cycle(); setState(s); } }, )));
for (const [b, s] of [...document.querySelectorAll(".states button")].map((b, i) => [b, STATES[i]])) b.dataset.state = s;
setStatePressed();
$("#cycle").onclick = cycle;
$("#release").onclick = () => { S.forced = null; setStatePressed(); render(); };
loadIndex().catch((e) => $("#pane").replaceChildren(el("p", { className: "note", textContent: e.message })));
