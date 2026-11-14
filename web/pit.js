/* pit: an idea board you decide on one card at a time.

   mountPit(el, {store, ...}) draws the whole board into el's shadow root, so
   the host's styles cannot reach it and its styles cannot leak out. The store
   is the only thing a host must supply: pit's own server (restStore), plain
   memory (memoryStore), or anything with the same few async calls. */

const LANES = ['unsorted', 'in', 'maybe', 'unsure', 'out'];
const VOTES = ['in', 'maybe', 'unsure', 'out'];
const ARROW = { in: '→', maybe: '↑', unsure: '↓', out: '←' };
const KEYLANE = { ArrowRight: 'in', ArrowLeft: 'out', ArrowUp: 'maybe', ArrowDown: 'unsure' };
const REASON = { done: 'done', handed: 'handed off' };
const AWAY = { in: [1, 0], out: [-1, 0], maybe: [0, -1], unsure: [0, 1] };
const RANK = { in: 0, maybe: 1, unsure: 2, unsorted: 3, out: 4 };
const order = (a, b) => (RANK[a.lane] - RANK[b.lane]) || (a.pos - b.pos) || (a.id < b.id ? -1 : 1);
const between = (above, below) =>
  above && below ? (above.pos + below.pos) / 2 : above ? above.pos + 1 : below ? below.pos - 1 : 1;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + 'm';
  if (d < 86400) return Math.round(d / 3600) + 'h';
  if (d < 86400 * 30) return Math.round(d / 86400) + 'd';
  return Math.round(d / 86400 / 30) + 'mo';
}
const excerpt = (s, n = 200) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/* ------------------------------ stores ------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();

/* Everything in one plain object, {cards, log}, with the same rules pit's
   server keeps: the log only grows, undo voids its newest live row and puts
   the card back, and a reason survives only in `out`. `save` gets the whole
   state after every write; `replace` takes a new one from outside (another
   writer) and redraws whoever subscribed. */
export function memoryStore(init = {}, { save } = {}) {
  const fill = (c, i) => ({ source: 'me', note: '', body: '', reason: '', comments: [], created_at: now(), lane: 'unsorted', pos: i + 1, ...c, id: c.id || uid() });
  const open = s => { const o = { cards: [], log: [], ...structuredClone(s || {}) }; o.cards = o.cards.map(fill); return o; };
  let st = open(init);
  const subs = new Set();
  const persist = () => save && save(structuredClone(st));
  const find = id => { const c = st.cards.find(x => x.id === id); if (!c) throw new Error('not found'); return c; };
  const end = lane => Math.max(0, ...st.cards.filter(x => x.lane === lane).map(x => x.pos || 0)) + 1;
  function place(id, lane, pos, reason = '') {
    const c = find(id);
    if (!LANES.includes(lane)) throw new Error('no lane ' + lane);
    st.log.push({ id: uid(), card: id, from: c.lane, to: lane, from_pos: c.pos, reason, from_reason: c.reason || '', voided: false, at: now() });
    c.lane = lane;
    c.pos = pos ?? end(lane);
    c.reason = lane === 'out' ? reason : '';
    c.updated_at = now();
    persist();
    return { ...c };
  }
  return {
    async list() { return { cards: st.cards.map(c => ({ ...c, comment_count: (c.comments || []).length })), board: st.board }; },
    async get(id) { return structuredClone(find(id)); },
    async add(cards) {
      const made = cards.map(c => fill({ ...c, pos: c.pos ?? end(c.lane || 'unsorted') }));
      st.cards.push(...made);
      persist();
      return made.map(c => ({ ...c }));
    },
    async place(id, { lane, pos, reason }) { return place(id, lane, pos, reason); },
    async vote(id, lane) { return place(id, lane); },
    async undo() {
      const last = [...st.log].reverse().find(x => !x.voided);
      if (!last) return null;
      last.voided = true;
      const c = find(last.card);
      Object.assign(c, { lane: last.from, pos: last.from_pos, reason: last.from_reason, updated_at: now() });
      persist();
      return { ...c };
    },
    async edit(id, patch) {
      const c = find(id);
      for (const k of ['title', 'note', 'body', 'img', 'url']) if (k in patch) c[k] = patch[k];
      if (patch.lane && patch.lane !== c.lane) return place(id, patch.lane);
      c.updated_at = now();
      persist();
      return { ...c };
    },
    async remove(id) { st.cards = st.cards.filter(x => x.id !== id); persist(); },
    async comment(id, text, who = 'me') {
      const c = find(id);
      (c.comments ||= []).push({ id: uid(), who, text, created_at: now() });
      persist();
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    replace(next) { st = open(next); subs.forEach(fn => fn()); },
    state: () => structuredClone(st),
  };
}

/* pit's own server: one board of it, by slug. `request` is how a call goes
   out, so a host can add a key or catch a 401. */
export function restStore(board, { base = '', request } = {}) {
  const call = request || (async (path, opts = {}) => {
    const r = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 204) return null;
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || ('http ' + r.status));
    return body;
  });
  const b = encodeURIComponent(board);
  const post = (path, body, method = 'POST') => call(path, { method, body: JSON.stringify(body) });
  return {
    async list() { const r = await call(`/api/boards/${b}/ideas`); return { cards: r.ideas || [], board: r.board }; },
    get: id => call('/api/ideas/' + id),
    async add(cards) { return (await post(`/api/boards/${b}/ideas`, { ideas: cards })).ideas || []; },
    place: (id, p) => post(`/api/ideas/${id}/place`, p),
    vote: (idea, lane) => post(`/api/boards/${b}/sift`, { idea, lane }),
    async undo() {
      try { return await call(`/api/boards/${b}/sift/undo`, { method: 'POST' }); }
      catch (e) { if (e.message === 'not found') return null; throw e; }
    },
    edit: (id, patch) => post('/api/ideas/' + id, patch, 'PATCH'),
    remove: id => call('/api/ideas/' + id, { method: 'DELETE' }),
    comment: (id, text) => post(`/api/ideas/${id}/comments`, { text }),
  };
}

/* ------------------------------ the board ------------------------------ */

let css = null;
const sheet = () => {
  if (css) return css;
  css = new CSSStyleSheet();
  css.replaceSync(STYLE);
  return css;
};

export function mountPit(host, opts = {}) {
  let store = opts.store;
  if (!store) throw new Error('mountPit needs a store');
  const votes = VOTES.filter(l => (opts.votes || VOTES).includes(l));
  const lanes = ['unsorted', ...votes];
  const feat = { add: true, drag: true, edit: true, comments: true, remove: true, copy: true, reasons: true, bar: true, ...(opts.features || {}) };
  const reasons = feat.reasons && votes.includes('out');
  const sections = ['unsorted', ...votes.filter(l => l !== 'out'), ...(reasons ? ['done'] : []), ...(votes.includes('out') ? ['out'] : [])];
  const who = { me: 'you', agent: 'an agent', ...(opts.who || {}) };
  const by = x => x.source === 'agent' ? (x.author || who.agent) : who.me;
  const open = opts.open || (u => window.open(u, '_blank', 'noopener'));

  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [sheet()];
  root.innerHTML = `<div class="pit">
    <div class="bar"${feat.bar ? '' : ' hidden'}>
      <slot name="start"><span class="bname"></span></slot>
      <span class="bdesc"></span>
      <span class="bar-sp"></span>
      <input class="find" placeholder="Find  /" autocomplete="off" aria-label="Find an idea">
      <span class="stat"></span>
      <slot name="end"></slot>
      <button class="ghost" data-act="undo" type="button" title="Put the last card back where it was">Undo</button>
      <button class="go" data-act="sift" type="button"><span class="sift-what">Sift</span> <span class="n">0</span> <kbd>S</kbd></button>
    </div>
    <main class="board"></main>
    <div class="sift" aria-hidden="true">
      <div class="sift-top">
        <span class="mark">pit</span>
        <span class="sift-board"></span>
        <span class="bdesc static sift-desc"></span>
        <span class="sift-scope"></span>
        <span class="bar-sp"></span>
        <button class="ghost" data-act="undo" type="button">Undo <kbd>U</kbd></button>
        <button class="ghost" data-act="close" type="button">Back to board · Esc</button>
      </div>
      <div class="sift-stage"></div>
      <div class="sift-foot"></div>
    </div>
    <div class="scrim"></div>
    <aside class="drawer" aria-hidden="true"></aside>
    <div class="toast" role="status"></div>
  </div>`;
  const q$ = s => root.querySelector(s);
  const board = q$('.board'), siftEl = q$('.sift'), stage = q$('.sift-stage'), sfoot = q$('.sift-foot'),
    drawer = q$('.drawer'), scrim = q$('.scrim'), find = q$('.find'), statEl = q$('.stat'),
    bdesc = q$('.bar .bdesc'), siftBtn = q$('[data-act="sift"]'), pitEl = q$('.pit');

  let meta = {}, cards = [], groups = null, sel = null, fresh = new Set(), stageLane = 'in', query = '';
  const label = l => (meta.labels && meta.labels[l]) || (opts.labels && opts.labels[l]) || l;
  const inLane = l => cards.filter(i => i.lane === l);
  const section = k => k === 'done' ? inLane('out').filter(x => x.reason)
    : k === 'out' && reasons ? inLane('out').filter(x => !x.reason)
    : inLane(k);
  const matches = x => !query ||
    (x.title + ' ' + (x.note || '') + ' ' + (x.body || '') + ' ' + (REASON[x.reason] || '') + ' ' + (x.author || '')).toLowerCase().includes(query);
  const showing = l => section(l).filter(matches);
  const byId = id => cards.find(i => i.id === id);
  const nLive = () => cards.filter(i => i.lane !== 'out').length;
  const groupLane = 'in';
  const kept = gid => cards.filter(x => x.board_id === gid && x.lane === groupLane);
  const view = () => ({ stage: stageLane, open: sel, sift: siftEl.classList.contains('on') ? scope : null });
  const told = () => opts.onView && opts.onView(view());

  let tt = null;
  function toast(m) {
    const el = q$('.toast'); el.textContent = m; el.classList.add('on');
    clearTimeout(tt); tt = setTimeout(() => el.classList.remove('on'), 2800);
  }
  const fail = e => toast(e.message || String(e));

  async function load() {
    const r = await store.list();
    cards = (r.cards || []).slice().sort(order);
    meta = r.board || meta || {};
    groups = r.groups || null;
    board.classList.toggle('all', !!groups);
    bdesc.textContent = meta.description || (opts.onDescClick ? 'add a description' : '');
    q$('.bname').textContent = meta.name || '';
    bdesc.classList.toggle('static', !opts.onDescClick || !!groups);
    opts.onBoard && opts.onBoard(meta, { groups });
  }
  async function reload(keepFresh) {
    const prev = snapshot();
    await load();
    if (!keepFresh) fresh.clear();
    if (siftEl.classList.contains('on')) {
      const live = new Set(inLane(scope).map(x => x.id));
      q = q.filter(id => live.has(id) || id === q[0]);
      for (const id of live) if (!q.includes(id) && !seen.has(id)) { q.push(id); started++; }
      if (!busy) drawCard();
    }
    paint(prev);
  }

  /* ------------------------------ painting ------------------------------ */
  const why = x => x.reason ? `<span class="why ${x.reason === 'done' ? 'done' : ''}">${REASON[x.reason] || x.reason}</span>` : '';
  function cardHTML(x, i, big) {
    const drag = feat.drag ? ' draggable="true"' : '';
    if (!big) return `<article class="card slim${x.reason || x.source === 'agent' ? ' marked' : ''}${fresh.has(x.id) ? ' fresh' : ''}${sel === x.id ? ' sel' : ''}"
      ${drag} tabindex="0" data-id="${esc(x.id)}">${why(x)}<p class="t">${esc(x.title)}</p>${x.source === 'agent' ? `<span class="src agent" title="${esc(by(x))}"></span>` : ''}</article>`;
    return `<article class="card big${fresh.has(x.id) ? ' fresh' : ''}${sel === x.id ? ' sel' : ''}${x.img ? ' has-img' : ''}"
      ${drag} tabindex="0" data-id="${esc(x.id)}">
      <span class="num">${i + 1}</span>
      ${x.img ? `<img class="thumb" src="${esc(x.img)}" alt="" loading="lazy">` : ''}
      <p class="t">${esc(x.title)}</p>
      ${x.note ? `<p class="n">${esc(x.note)}</p>` : ''}
      ${x.body ? `<p class="ex">${esc(excerpt(x.body))}</p>` : ''}
      <div class="f">
        <span class="src ${x.source === 'agent' ? 'agent' : ''}" title="${esc(by(x))}"></span>
        ${x.source === 'agent' ? `<span class="by">${esc(by(x))}</span>` : ''}
        ${why(x)}
        ${x.comment_count ? `<span title="${x.comment_count} note${x.comment_count === 1 ? '' : 's'}">✎${x.comment_count}</span>` : ''}
        ${x.url ? `<a class="link" href="${esc(x.url)}" data-url="${esc(x.url)}">open ↗</a>` : ''}
        <span class="age">${ago(x.created_at)}</span>
      </div></article>`;
  }
  function snapshot() {
    const m = {}; board.querySelectorAll('.card').forEach(c => m[c.dataset.id] = c.getBoundingClientRect()); return m;
  }
  function emptyLine(k, filtered) {
    if (filtered) return `No match for “${esc(query)}” in ${esc(label(k))}.`;
    if (k === 'unsorted') return feat.add ? 'Nothing waiting. Drop ideas here, or let an agent.' : 'Nothing waiting.';
    if (k === 'done') return 'Nothing shipped yet. D on a card marks it done, H hands it off.';
    if (k === 'out') return 'Nothing buried yet.';
    if (k === stageLane) return `Nothing in ${esc(label(k))} yet. Sift the queue and what you keep lands here.`;
    return 'Empty.';
  }
  function hint(k, n) {
    const parts = [];
    if (feat.drag && n > 1) parts.push('drag or J/K to order');
    if (reasons && lanes.includes(k) && k !== 'out') parts.push('D done · H handed off');
    return parts.length ? `<span class="col-hint">${parts.join(' · ')}</span>` : '';
  }
  const laneCount = (all, some) => query ? `${some.length}/${all.length}` : String(all.length);
  const canSift = k => lanes.includes(k) && k !== 'out';
  const quick = (k, ph) => feat.add && canSift(k) ? `<div class="quick"><input data-lane="${k}" placeholder="${ph}" autocomplete="off"></div>` : '';
  function stageButtons(all, g) {
    return [
      all.length && canSift(stageLane) ? `<button class="col-sift" type="button" data-scope="${stageLane}">sift</button>` : '',
      feat.copy && g.length ? '<button class="col-sift" type="button" data-copy="1" title="Copy this lane as markdown, shift for the bodies too">copy</button>' : '',
      ...(opts.stageActions || []).map((a, i) => all.length ? `<button class="col-sift" type="button" data-extra="${i}" title="${esc(a.title || '')}">${esc(a.label)}</button>` : ''),
    ].join('');
  }
  function paint(prev) {
    if (groups) return paintGroups(prev);
    if (!sections.includes(stageLane)) stageLane = sections.includes('in') ? 'in' : sections[0];
    const scroll = {}; board.querySelectorAll('.col-body').forEach(b => scroll[b.dataset.k] = b.scrollTop);
    const all = section(stageLane), g = all.filter(matches);
    const stageHTML = `<section class="col stage${stageLane === 'out' ? ' is-out' : ''}" data-k="${stageLane}">
        <header class="col-head">
          <span class="col-name">${esc(label(stageLane))}</span><span class="col-n">${laneCount(all, g)}</span>
          ${stageButtons(all, g)}
          ${hint(stageLane, all.length)}
        </header>
        <div class="col-body" data-k="${stageLane}">
          ${g.length ? g.map(x => cardHTML(x, all.indexOf(x), true)).join('')
            : `<div class="col-empty">${emptyLine(stageLane, all.length > 0)}</div>`}
        </div>
        ${quick(stageLane, `Add to ${esc(label(stageLane))}…`)}
      </section>`;
    const rail = sections.filter(k => k !== stageLane).map(k => {
      const l = section(k), v = showing(k);
      return `<section class="col${k === 'done' ? ' is-done' : ''}" data-k="${k}">
        <header class="col-head" role="button" tabindex="0" data-stage="${k}">
          <span class="col-name">${esc(label(k))}</span><span class="col-n">${laneCount(l, v)}</span>
          ${l.length && canSift(k) ? `<button class="col-sift" type="button" data-scope="${k}">sift</button>` : ''}
        </header>
        <div class="col-body" data-k="${k}">
          ${v.length ? v.map(x => cardHTML(x, 0, false)).join('') : `<div class="col-empty">${emptyLine(k, l.length > 0)}</div>`}
        </div>
        ${k === 'unsorted' ? quick('unsorted', 'Add an idea…') : ''}
      </section>`;
    }).join('');
    board.innerHTML = stageHTML + `<aside class="rail">${rail}</aside>`;
    board.querySelectorAll('.col-body').forEach(b => { if (scroll[b.dataset.k]) b.scrollTop = scroll[b.dataset.k]; });
    flip(prev);
    drawStat();
  }
  function flip(prev) {
    if (!prev) return;
    board.querySelectorAll('.card').forEach(c => {
      const was = prev[c.dataset.id]; if (!was) return;
      const now = c.getBoundingClientRect(), dx = was.left - now.left, dy = was.top - now.top;
      if (!dx && !dy) return;
      c.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.7,.3,1)' });
    });
  }
  function paintGroups(prev) {
    const scroll = board.querySelector('.all-scroll')?.scrollTop || 0;
    const lab = g => (g.labels && g.labels[groupLane]) || groupLane;
    board.innerHTML = `<div class="all-scroll">` + (groups.length ? groups.map(g => {
      const all = kept(g.id), show = all.filter(matches);
      return `<section class="col stage" data-k="${groupLane}" data-b="${esc(g.id)}">
        <header class="col-head">
          <button class="col-name" type="button" data-go="${esc(g.id)}">${esc(g.name)}</button>
          <span class="col-n">${laneCount(all, show)}</span>
          <span class="col-hint">${esc(lab(g))}</span>
        </header>
        <div class="col-body" data-k="${groupLane}" data-b="${esc(g.id)}">
          ${show.length ? show.map(x => cardHTML(x, all.indexOf(x), true)).join('')
            : `<div class="col-empty">${all.length ? `No match for “${esc(query)}” in ${esc(g.name)}.` : `Nothing kept on ${esc(g.name)} yet.`}</div>`}
        </div></section>`;
    }).join('') : '<div class="col-empty">No boards yet.</div>') + `</div>`;
    const sc = board.querySelector('.all-scroll'); if (sc) sc.scrollTop = scroll;
    flip(prev);
    drawStat();
  }
  function setStage(k) {
    if (!sections.includes(k) || k === stageLane) return;
    stageLane = k; paint(null); told();
  }
  function nextScope() {
    for (const l of ['unsorted', 'unsure', 'maybe']) if (lanes.includes(l) && inLane(l).length) return l;
    return null;
  }
  function drawStat() {
    statEl.textContent = query
      ? `${cards.filter(matches).length} of ${cards.length} match`
      : groups ? `${cards.length} kept · ${groups.length} boards`
      : `${nLive()} live` + (reasons ? ` · ${section('done').length} done` : '') + (votes.includes('out') ? ` · ${section('out').length} out` : '');
    const s = groups ? null : nextScope();
    siftBtn.querySelector('.n').textContent = s ? inLane(s).length : 0;
    siftBtn.querySelector('.sift-what').textContent = s && s !== 'unsorted' ? 'Sift ' + label(s) : 'Sift';
    siftBtn.disabled = !s;
    siftBtn.title = groups ? 'open a board to sift it' : s ? `go through ${label(s)}, one card at a time` : 'nothing waiting';
    opts.onStat && opts.onStat({ live: nLive(), next: s, n: s ? inLane(s).length : 0 });
  }

  /* ------------------------------ moving cards ------------------------------ */
  async function move(id, lane, pos, reason) {
    const prev = snapshot();
    const it = byId(id); if (!it) return;
    try {
      Object.assign(it, await store.place(id, { lane, pos, reason }));
      cards.sort(order);
      paint(prev);
    } catch (e) { fail(e); }
  }
  const siblings = it => groups ? kept(it.board_id) : section(it.lane === 'out' && it.reason ? 'done' : it.lane);
  const groupIn = col => col.dataset.b ? kept(col.dataset.b) : section(col.dataset.k);
  async function nudge(id, dir) {
    const it = byId(id); if (!it) return;
    const g = siblings(it), at = g.findIndex(x => x.id === id), to = at + dir;
    if (at < 0 || to < 0 || to >= g.length) return;
    const rest = g.filter(x => x.id !== id);
    await move(id, it.lane, between(rest[to - 1], rest[to]), it.reason);
  }
  async function dropOn(item, col, clientY, over) {
    if (col.dataset.b && col.dataset.b !== item.board_id) return toast('a card stays on the board you sifted it on');
    const k = col.dataset.k;
    const to = k === 'done' ? 'out' : k;
    const reason = k === 'done' ? (item.reason || 'done') : '';
    const group = groupIn(col).filter(x => x.id !== item.id);
    let idx = group.length;
    if (over && over.dataset.id !== item.id) {
      const at = group.findIndex(x => x.id === over.dataset.id);
      if (at >= 0) { const r = over.getBoundingClientRect(); idx = clientY > r.top + r.height / 2 ? at + 1 : at; }
    }
    await move(item.id, to, between(group[idx - 1], group[idx]), reason);
  }
  function refocus(id) {
    const again = board.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (again) { again.focus(); again.scrollIntoView({ block: 'nearest' }); }
  }

  board.addEventListener('keydown', async e => {
    const input = e.target.closest('.quick input');
    if (input) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const title = input.value.trim(); if (!title) return;
      input.value = '';
      try {
        (await store.add([{ title, lane: input.dataset.lane }])).forEach(x => fresh.add(x.id));
        await reload(true);
        board.querySelector(`.quick input[data-lane="${input.dataset.lane}"]`)?.focus();
      } catch (err) { fail(err); }
      return;
    }
    const h = e.target.closest('[data-stage]');
    if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); return setStage(h.dataset.stage); }
    const c = e.target.closest('.card');
    if (!c || groups && !/^(j|k|ArrowUp|ArrowDown|Enter)$/.test(e.key)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const k = c.closest('.col').dataset.k;
      const i = lanes.indexOf(k === 'done' ? 'out' : k);
      const to = e.key === 'ArrowRight' ? i + 1 : i - 1;
      if (to < 0 || to >= lanes.length) return;
      await move(c.dataset.id, lanes[to]);
      return refocus(c.dataset.id);
    }
    if (feat.drag && /^(j|k|ArrowDown|ArrowUp)$/.test(e.key)) {
      e.preventDefault();
      await nudge(c.dataset.id, (e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1);
      return refocus(c.dataset.id);
    }
    if (reasons && /^[dhDH]$/.test(e.key)) {
      e.preventDefault();
      const reason = e.key.toLowerCase() === 'd' ? 'done' : 'handed';
      const it = byId(c.dataset.id);
      if (!it || (it.lane === 'out' && it.reason === reason)) return;
      await move(c.dataset.id, 'out', undefined, reason);
      toast(`buried as ${REASON[reason]}, u puts it back`);
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); openDrawer(c.dataset.id); }
  });

  /* ------------------------------ drag ------------------------------ */
  let dragId = null;
  board.addEventListener('dragstart', e => {
    const c = e.target.closest('.card'); if (!c || !feat.drag) return;
    dragId = c.dataset.id; c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId);
  });
  board.addEventListener('dragend', e => {
    e.target.closest('.card')?.classList.remove('dragging');
    board.querySelectorAll('.col.over').forEach(x => x.classList.remove('over'));
    dragId = null;
  });
  board.addEventListener('dragover', e => {
    const col = e.target.closest('.col'); if (!col || !dragId) return;
    e.preventDefault();
    board.querySelectorAll('.col.over').forEach(x => { if (x !== col) x.classList.remove('over'); });
    col.classList.add('over');
  });
  board.addEventListener('drop', async e => {
    const col = e.target.closest('.col'); if (!col || !dragId) return;
    e.preventDefault(); col.classList.remove('over');
    const item = byId(dragId); if (!item) return;
    await dropOn(item, col, e.clientY, e.target.closest('.card'));
  });

  /* A finger has no native drag, so a long press picks the card up. Below the
     press, and below 10px of travel, the gesture is still a scroll. */
  let held = null, hold = null, holdAt = null, swallow = false;
  board.addEventListener('pointerdown', e => {
    if (!feat.drag || e.pointerType === 'mouse' || e.target.closest('input,textarea,button,a')) return;
    const c = e.target.closest('.card'); if (!c) return;
    holdAt = { x: e.clientX, y: e.clientY, id: e.pointerId };
    hold = setTimeout(() => { hold = null; lift(c); }, 340);
  });
  board.addEventListener('pointermove', e => {
    if (hold && Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 10) { clearTimeout(hold); hold = null; }
    if (!held) return;
    held.moved = true;
    held.el.style.left = (e.clientX - held.gx) + 'px';
    held.el.style.top = (e.clientY - held.gy) + 'px';
    const col = colUnder(e.clientX, e.clientY);
    board.querySelectorAll('.col.over').forEach(x => { if (x !== col) x.classList.remove('over'); });
    if (col) col.classList.add('over');
  });
  board.addEventListener('touchmove', e => { if (held) e.preventDefault(); }, { passive: false });
  board.addEventListener('pointerup', async e => {
    if (hold) { clearTimeout(hold); hold = null; }
    if (!held) return;
    const item = byId(held.id), moved = held.moved;
    const col = colUnder(e.clientX, e.clientY), over = cardUnder(e.clientX, e.clientY, held.id);
    drop();
    if (moved && item && col) await dropOn(item, col, e.clientY, over);
  });
  board.addEventListener('click', e => { if (!swallow) return; swallow = false; e.stopPropagation(); e.preventDefault(); }, true);
  board.addEventListener('contextmenu', e => { if (held) e.preventDefault(); });
  board.addEventListener('pointercancel', () => { if (hold) { clearTimeout(hold); hold = null; } drop(); });
  function lift(c) {
    const r = c.getBoundingClientRect();
    try { c.setPointerCapture(holdAt.id); } catch (_) {}
    const el = c.cloneNode(true);
    el.classList.add('lifted');
    Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
    pitEl.appendChild(el);
    held = { id: c.dataset.id, el, src: c, gx: holdAt.x - r.left, gy: holdAt.y - r.top, moved: false };
    c.classList.add('dragging'); board.classList.add('holding');
    if (navigator.vibrate) navigator.vibrate(12);
  }
  function drop() {
    if (!held) return;
    swallow = held.moved;
    held.el.remove(); held.src.classList.remove('dragging'); board.classList.remove('holding');
    board.querySelectorAll('.col.over').forEach(x => x.classList.remove('over'));
    held = null;
  }
  function under(x, y, s) {
    const was = held && held.el.style.display;
    if (held) held.el.style.display = 'none';
    const el = root.elementFromPoint(x, y);
    if (held) held.el.style.display = was || '';
    return el && el.closest(s);
  }
  const colUnder = (x, y) => under(x, y, '.col');
  const cardUnder = (x, y, not) => { const c = under(x, y, '.card'); return c && c.dataset.id !== not ? c : null; };

  /* ------------------------------ drawer ------------------------------ */
  async function openDrawer(id) {
    let x;
    try { x = store.get ? await store.get(id) : { ...byId(id) }; } catch (e) { return fail(e); }
    if (!x) return;
    sel = id;
    const it = byId(id); if (it) it.comment_count = (x.comments || []).length;
    const cmts = x.comments || [];
    const ro = !feat.edit ? ' readonly' : '';
    drawer.innerHTML = `
    <div class="dw-top">
      <select class="lanechip" data-f="lane"${groups ? ' disabled' : ''}>${lanes.map(k => `<option value="${k}"${k === x.lane ? ' selected' : ''}>${esc(label(k))}</option>`).join('')}</select>
      ${reasons ? `<select class="lanechip" data-f="reason"${x.lane === 'out' ? '' : ' hidden'} title="How this one ended">
        <option value=""${x.reason ? '' : ' selected'}>no</option>
        ${Object.keys(REASON).map(k => `<option value="${k}"${k === x.reason ? ' selected' : ''}>${REASON[k]}</option>`).join('')}
      </select>` : ''}
      <span class="srcchip ${x.source === 'agent' ? 'agent' : ''}"><i></i>${esc(x.source === 'agent' ? 'from ' + by(x) : 'yours')}</span>
      <button class="dw-x" data-f="x" type="button" aria-label="Close">×</button>
    </div>
    <div class="dw-body">
      ${x.img ? `<img class="dw-img" src="${esc(x.img)}" alt="">` : ''}
      <textarea class="dw-title" data-f="title" rows="1"${ro}>${esc(x.title)}</textarea>
      <textarea class="dw-note" data-f="note" rows="1" placeholder="one line, what it is"${ro}>${esc(x.note)}</textarea>
      ${x.url ? `<p class="dw-url"><a href="${esc(x.url)}" data-url="${esc(x.url)}">${esc(x.url)}</a></p>` : ''}
      <div class="dw-stats">
        <div><dt>lane</dt><dd>${esc(label(x.lane))}${x.reason ? ` · ${REASON[x.reason]}` : ''}</dd></div>
        ${x.created_at ? `<div><dt>added</dt><dd>${ago(x.created_at)} ago</dd></div>` : ''}
        <div><dt>from</dt><dd>${esc(x.source === 'agent' ? by(x) : who.me)}</dd></div>
      </div>
      <label class="lbl">Body</label>
      <textarea class="dw-text" data-f="body" placeholder="What is the actual idea? The sift shows this, it is what you decide on."${ro}>${esc(x.body)}</textarea>
      ${feat.comments ? `<label class="lbl">Notes${cmts.length ? ' · ' + cmts.length : ''}</label>
      ${cmts.length ? cmts.map(c => `<div class="cmt"><div class="cmt-h ${c.who === 'agent' ? 'agent' : ''}"><i></i><b>${c.who === 'agent' ? esc(c.author || who.agent) : esc(who.me)}</b></div><p>${esc(c.text)}</p></div>`).join('')
        : '<p class="cmt-empty">Nothing here yet. Worth a line if there is something you would forget before you look at this again.</p>'}
      <div class="composer">
        <textarea data-f="cmt" rows="1" placeholder="Add a note"></textarea>
        <button class="ghost" data-f="send" type="button">Post</button>
      </div>` : ''}
    </div>
    <div class="dw-foot">
      ${groups || !votes.includes('out') ? '' : `<button class="ghost danger" data-f="bury" type="button">${x.lane === 'out' ? 'Dig up' : 'Bury'}</button>`}
      ${feat.remove ? '<button class="ghost" data-f="del" type="button">Delete</button>' : ''}
      <span class="saved">saved</span>
    </div>`;
    drawer.classList.add('on'); drawer.setAttribute('aria-hidden', 'false');
    scrim.classList.add('on'); paint(snapshot()); told();

    const f = k => drawer.querySelector(`[data-f="${k}"]`);
    const grow = el => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
    ['title', 'note', 'body'].forEach(k => { const el = f(k); grow(el); el.addEventListener('input', () => grow(el)); });
    f('title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f('title').blur(); } });
    let t = null;
    const flash = () => { const s = drawer.querySelector('.saved'); if (!s) return; s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 900); };
    const save = patch => {
      clearTimeout(t);
      t = setTimeout(async () => {
        try { await store.edit(id, patch); flash(); await reload(true); } catch (e) { fail(e); }
      }, 450);
    };
    if (feat.edit) {
      f('title').addEventListener('input', () => save({ title: f('title').value.trim() }));
      f('note').addEventListener('input', () => save({ note: f('note').value.trim() }));
      f('body').addEventListener('input', () => save({ body: f('body').value }));
    }
    f('lane').addEventListener('change', async e => { await move(id, e.target.value); openDrawer(id); });
    f('reason')?.addEventListener('change', async e => { await move(id, 'out', undefined, e.target.value); openDrawer(id); });
    f('x').addEventListener('click', closeDrawer);
    f('bury')?.addEventListener('click', async () => { await move(id, x.lane === 'out' ? 'unsorted' : 'out'); closeDrawer(); });
    f('del')?.addEventListener('click', async () => {
      if (!confirm('Delete this idea? Burying keeps it out of the way without losing it.')) return;
      try { await store.remove(id); closeDrawer(); await reload(); toast('deleted'); } catch (e) { fail(e); }
    });
    const send = async () => {
      const box = f('cmt'), v = box.value.trim(); if (!v) return;
      try { await store.comment(id, v); box.value = ''; await openDrawer(id); } catch (e) { fail(e); }
    };
    f('send')?.addEventListener('click', send);
    f('cmt')?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
  }
  function closeDrawer() {
    if (!drawer.classList.contains('on')) return;
    drawer.classList.remove('on'); drawer.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('on'); sel = null; paint(snapshot()); told();
  }
  scrim.addEventListener('click', closeDrawer);
  root.addEventListener('click', e => {
    const u = e.target.closest('[data-url]');
    if (u) { e.preventDefault(); e.stopPropagation(); return open(u.dataset.url); }
  }, true);
  board.addEventListener('click', e => {
    const go = e.target.closest('[data-go]'); if (go) return opts.onGroup && opts.onGroup(groups.find(g => g.id === go.dataset.go));
    if (e.target.closest('[data-copy]')) return copyStage(e.shiftKey);
    const ex = e.target.closest('[data-extra]'); if (ex) return opts.stageActions[ex.dataset.extra].run(stageLane, showing(stageLane));
    const d = e.target.closest('.col-sift'); if (d) return openSift(d.dataset.scope);
    const c = e.target.closest('.card'); if (c) return openDrawer(c.dataset.id);
    const h = e.target.closest('[data-stage]'); if (h) setStage(h.dataset.stage);
  });

  /* ------------------------------ copy out ------------------------------ */
  function listMarkdown(g, withBody) {
    return g.map((x, i) => {
      let s = `${i + 1}. ${x.title}`;
      if (x.reason) s += ` (${REASON[x.reason] || x.reason})`;
      if (x.note) s += `\n   ${x.note}`;
      if (x.url) s += `\n   ${x.url}`;
      if (withBody && x.body) s += `\n\n   ${x.body.trim().replace(/\n/g, '\n   ')}\n`;
      return s;
    }).join('\n') + '\n';
  }
  function stageMarkdown(withBody) {
    if (groups) return groups.map(g => `## ${g.name} · ${(g.labels && g.labels[groupLane]) || groupLane}\n\n` + listMarkdown(kept(g.id).filter(matches), withBody)).join('\n');
    return `## ${meta.name ? meta.name + ' · ' : ''}${label(stageLane)}\n\n` + listMarkdown(showing(stageLane), withBody);
  }
  async function copyStage(withBody) {
    const n = groups ? cards.filter(matches).length : showing(stageLane).length;
    if (!n) return toast('nothing to copy');
    try {
      await (opts.copy ? opts.copy(stageMarkdown(withBody)) : navigator.clipboard.writeText(stageMarkdown(withBody)));
      toast(`${n} copied as markdown` + (withBody ? ', bodies and all' : ' · shift for the bodies'));
    } catch (e) { toast('the clipboard refused: ' + e.message); }
  }

  /* ------------------------------ sift ------------------------------
     One card, four directions. The queue lives here so a skip costs nothing
     and the card order stays stable while you work through it. */
  let q = [], scope = null, busy = false, did = {}, started = 0, seen = new Set(), ended = false;
  let justVoted = null, enterFrom = null, lastLane = null;
  const CALM = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const ms = n => CALM ? Math.round(n * .7) : n;
  const far = n => CALM ? Math.round(n * .09) : n;
  const spin = n => CALM ? 0 : n;
  const EASE_OUT = 'cubic-bezier(.4,0,.75,.25)', EASE_IN = 'cubic-bezier(.2,.7,.3,1)';
  const REST = { b1: 'translateY(13px) scaleX(.985)', b2: 'translateY(25px) scaleX(.968)' };
  const BACK = { b1: 'translateY(25px) scaleX(.968)', b2: 'translateY(38px) scaleX(.95)' };
  const ghost = k => stage.querySelector('.deck i.' + k);
  const settle = (p, cap) => Promise.race([p, new Promise(r => setTimeout(r, cap))]);
  stage.style.setProperty('--zones', votes.length);

  function zoneHTML(l) {
    const hit = justVoted === l;
    return `<button class="zone ${l}${hit ? ' hit' : ''}" type="button" data-lane="${l}">
      <span class="key">${ARROW[l]}</span><span class="lbl">${esc(label(l))}</span>
      <span class="n${hit ? ' bump' : ''}">${inLane(l).length}</span></button>`;
  }
  function drawCard() {
    const x = byId(q[0]);
    if (!x) return drawDone();
    const said = feat.comments ? x.comments || [] : [];
    const depth = Math.min(2, q.length - 1);
    stage.innerHTML = votes.map(zoneHTML).join('') + `
      <div class="deck"><div class="pile">
        ${depth > 1 ? '<i class="b2"></i>' : ''}${depth > 0 ? '<i class="b1"></i>' : ''}
        <article class="sift-card">
          <span class="src${x.source === 'agent' ? ' agent' : ''}">${esc(x.source === 'agent' ? by(x) + ' suggested' : who.me + ' wrote')}${x.created_at ? ` · ${ago(x.created_at)} ago` : ''}</span>
          ${x.img ? `<img class="art" src="${esc(x.img)}" alt="">` : ''}
          <h2>${esc(x.title)}</h2>
          ${feat.edit ? `<div class="jot"><textarea class="jot-in" rows="1" placeholder="one line, what it is" autocomplete="off">${esc(x.note)}</textarea><span>N</span></div>`
            : x.note ? `<p class="note">${esc(x.note)}</p>` : ''}
          ${x.url ? `<a class="link" href="${esc(x.url)}" data-url="${esc(x.url)}">${esc(x.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))} ↗</a>` : ''}
          ${x.body ? `<p class="body">${esc(x.body)}</p>` : ''}
          ${said.length ? `<div class="said">${said.map(c =>
            `<p><b class="${c.who === 'agent' ? 'agent' : ''}">${c.who === 'agent' ? esc((c.author || who.agent) + ' argues') : esc(who.me + ' noted')}</b>${esc(c.text)}</p>`).join('')}</div>` : ''}
        </article>
      </div></div>`;
    justVoted = null;
    stage.querySelector('.art')?.addEventListener('load', fitCard);
    fitCard();
    enter();
    drawFoot();
    const j = stage.querySelector('.jot-in');
    if (j) j.addEventListener('input', () => {
      growJot();
      const deck = stage.querySelector('.deck'), card = stage.querySelector('.sift-card');
      if (deck && card && card.scrollHeight > deck.clientHeight) fitCard();
    });
  }
  function growJot() {
    const j = stage.querySelector('.jot-in'); if (!j) return;
    j.style.height = 'auto';
    j.style.height = j.scrollHeight + 'px';
  }
  /* The card is sized to its text rather than the text to the card: start
     generous, measure, and scale --fit down until it fits. */
  function fitCard() {
    const card = stage.querySelector('.sift-card'), deck = stage.querySelector('.deck');
    if (!card || !deck) return;
    const avail = deck.clientHeight;
    if (!avail) return;
    let f = 1.42;
    const set = v => { f = Math.min(1.42, Math.max(.62, +v.toFixed(3))); card.style.setProperty('--fit', f); growJot(); };
    set(f);
    if (card.scrollHeight > avail) set(f * Math.max(.45, avail / card.scrollHeight));
    for (let i = 0; i < 7 && card.scrollHeight > avail && f > .621; i++) set(f - .05);
    card.classList.toggle('over', card.scrollHeight > card.clientHeight + 1);
  }
  const onResize = () => { if (siftEl.classList.contains('on')) fitCard(); };
  addEventListener('resize', onResize);
  document.fonts && document.fonts.ready.then(onResize);

  function enter() {
    const card = stage.querySelector('.sift-card'); if (!card) return;
    const [dx, dy] = enterFrom ? AWAY[enterFrom] : [0, 0];
    const back = enterFrom
      ? { transform: `translate(${far(dx * 180)}px,${far(dy * 110)}px) rotate(${spin(dx * 3)}deg) scale(.95)`, opacity: 0 }
      : { transform: REST.b1, opacity: .4 };
    enterFrom = null;
    card.animate([back, { transform: 'none', opacity: 1 }], { duration: ms(dx || dy ? 300 : 240), easing: EASE_IN });
    for (const k of ['b1', 'b2']) ghost(k)?.animate([{ transform: BACK[k], opacity: 0 }, {}], { duration: ms(320), easing: EASE_IN });
  }
  function leave(lane) {
    const card = stage.querySelector('.sift-card');
    if (!card) return Promise.resolve();
    const [dx, dy] = AWAY[lane] || [0, 0];
    ghost('b1')?.animate([{}, { transform: 'none', opacity: 1 }], { duration: ms(240), easing: EASE_IN, fill: 'forwards' });
    ghost('b2')?.animate([{}, { transform: REST.b1, opacity: .85 }], { duration: ms(240), easing: EASE_IN, fill: 'forwards' });
    return card.animate(
      [{ transform: 'none', opacity: 1 },
        { transform: `translate(${far(dx * 280)}px,${far(dy * 160)}px) rotate(${spin(dx * 4)}deg) scale(.93)`, opacity: 0 }],
      { duration: ms(240), easing: EASE_OUT, fill: 'forwards' }).finished.catch(() => {});
  }
  const keys = votes.map(l => `${ARROW[l]} ${label(l)}`).join(' · ');
  function drawFoot() {
    const done = started - q.length, pct = started ? Math.round(done / started * 100) : 0;
    const tally = votes.filter(l => did[l]).map(l => `<span class="${l === lastLane ? 'just' : ''}">${ARROW[l]}<b>${did[l]}</b></span>`).join(' ');
    sfoot.innerHTML =
      `<span class="left-n tick">${q.length} left</span>
       <span class="meter"><i class="${pct === 100 ? 'full' : ''}" style="width:${pct}%"></i></span>
       <span class="tally">${tally || 'nothing yet'}</span>
       <span class="keys">${esc(keys)} · space skip · u undo${feat.edit ? ' · n note' : ''}</span>`;
  }
  function drawDone() {
    const top = inLane('in').slice(0, 5);
    const total = votes.reduce((n, l) => n + (did[l] || 0), 0);
    const next = ['unsorted', 'unsure', 'maybe'].find(l => l !== scope && lanes.includes(l) && inLane(l).length);
    stage.innerHTML = `<div class="done">
      <h2>${scope === 'unsorted' ? 'Queue clear.' : 'Pass done.'}</h2>
      <p>${total
        ? `${total} decided: ${votes.map(l => `${did[l] || 0} ${esc(label(l))}`).join(', ')}.${votes.includes('in') ? ` ${esc(label('in'))} is what you meant to keep; drag it into the order you want.` : ''}`
        : 'Nothing decided this pass.'}</p>
      ${top.length ? `<ol>${top.map((x, i) => `<li style="animation-delay:${.18 + i * .05}s">${esc(x.title)}<span>${esc(label('in'))}</span></li>`).join('')}</ol>` : ''}
      <div class="done-acts">
        <button class="ghost" data-act="close" type="button">Back to board</button>
        ${next ? `<button class="go" data-next="${next}" type="button">Sift ${esc(label(next))} <span class="n">${inLane(next).length}</span></button>` : ''}
      </div></div>`;
    drawFoot();
    if (!ended) { ended = true; opts.onPass && opts.onPass({ scope, did: { ...did }, total, done: true }); }
  }
  async function vote(lane) {
    if (busy || !q.length || !votes.includes(lane)) return;
    const id = q[0];
    busy = true; lastLane = lane;
    if (navigator.vibrate) navigator.vibrate(9);
    const flying = leave(lane);
    try {
      const jot = stage.querySelector('.jot-in'), it = byId(id);
      if (jot && it && jot.value.trim() !== (it.note || '')) {
        await store.edit(id, { note: jot.value.trim() });
        it.note = jot.value.trim();
      }
      Object.assign(byId(id) || {}, await store.vote(id, lane));
      cards.sort(order);
      did[lane] = (did[lane] || 0) + 1; seen.add(id); q.shift(); justVoted = lane;
      opts.onVote && opts.onVote(byId(id), lane);
    } catch (e) {
      fail(e); busy = false;
      stage.querySelectorAll('.sift-card, .deck i').forEach(el => el.getAnimations().forEach(a => a.reverse()));
      return;
    }
    await settle(flying, ms(240) + 90);
    busy = false; drawCard();
  }
  async function skip() {
    if (busy || q.length < 2) return;
    busy = true;
    const card = stage.querySelector('.sift-card');
    if (card) await settle(card.animate(
      [{ transform: 'none', opacity: 1 }, { transform: `translateY(${far(34)}px) scale(.93)`, opacity: 0 }],
      { duration: ms(190), easing: EASE_OUT, fill: 'forwards' }).finished.catch(() => {}), ms(190) + 90);
    q.push(q.shift()); busy = false; drawCard();
    toast('skipped, it comes back at the end of this pass');
  }
  async function undo() {
    if (busy) return;
    if (groups) return toast('open a board to take back a call on it');
    busy = true;
    try {
      const it = await store.undo();
      if (!it) { toast('nothing to undo'); busy = false; return; }
      const i = cards.findIndex(x => x.id === it.id);
      const undone = i >= 0 ? cards[i].lane : null;
      if (i >= 0) Object.assign(cards[i], it); else cards.push(it);
      cards.sort(order);
      if (undone && did[undone]) did[undone]--;
      if (siftEl.classList.contains('on')) {
        if (q[0] !== it.id) q.unshift(it.id);
        seen.delete(it.id); ended = false;
        enterFrom = undone; lastLane = null; drawCard();
      } else paint(snapshot());
      toast(`back in ${label(it.lane)}`);
    } catch (e) { fail(e); }
    busy = false;
  }
  function openSift(l) {
    if (groups) return toast('open a board to sift it');
    scope = l || nextScope();
    if (!scope || !inLane(scope).length) return toast('nothing to sift');
    q = inLane(scope).map(x => x.id);
    started = q.length; did = {}; seen = new Set(); ended = false;
    justVoted = null; lastLane = null; enterFrom = null;
    q$('.sift-scope').textContent = 'sifting ' + label(scope);
    q$('.sift-board').textContent = meta.name || '';
    q$('.sift-desc').textContent = meta.description || '';
    siftEl.classList.add('on'); siftEl.setAttribute('aria-hidden', 'false');
    drawCard(); told();
  }
  async function closeSift() {
    if (!siftEl.classList.contains('on')) return;
    siftEl.classList.remove('on'); siftEl.setAttribute('aria-hidden', 'true');
    const n = votes.reduce((a, l) => a + (did[l] || 0), 0);
    if (n && q.length) opts.onPass && opts.onPass({ scope, did: { ...did }, total: n, done: false });
    await reload(); told();
    if (n) toast(`${n} sifted`);
    siftBtn.focus();
  }
  stage.addEventListener('click', e => {
    const z = e.target.closest('.zone'); if (z) return vote(z.dataset.lane);
    const nx = e.target.closest('[data-next]'); if (nx) return openSift(nx.dataset.next);
  });
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    ({ undo, sift: () => openSift(null), close: closeSift })[a.dataset.act]();
  });
  let tx = 0, ty = 0;
  stage.addEventListener('touchstart', e => { const t = e.changedTouches[0]; tx = t.clientX; ty = t.clientY; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (!e.target.closest('.sift-card') || e.target.closest('a,textarea')) return;
    const t = e.changedTouches[0], dx = t.clientX - tx, dy = t.clientY - ty;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 60) return;
    vote(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'in' : 'out') : (dy < 0 ? 'maybe' : 'unsure'));
  }, { passive: true });

  /* ------------------------------ find, keys ------------------------------ */
  function setQuery(v) {
    query = v.trim().toLowerCase();
    find.classList.toggle('hit', !!query);
    paint(null);
  }
  find.addEventListener('input', () => setQuery(find.value));
  find.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); find.value = ''; setQuery(''); find.blur(); }
    else if (e.key === 'Enter') { e.preventDefault(); find.blur(); }
  });
  const active = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  function onKey(e) {
    if (e.defaultPrevented || !host.isConnected) return;
    const a = active(), typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    if (siftEl.classList.contains('on')) {
      if (e.key === 'Escape') { e.preventDefault(); if (typing) return a.blur(); return closeSift(); }
      if (typing) { if (e.key === 'Enter') { e.preventDefault(); a.blur(); } return; }
      if (KEYLANE[e.key]) { e.preventDefault(); vote(KEYLANE[e.key]); }
      else if (e.key === ' ') { e.preventDefault(); skip(); }
      else if (e.key === 'u' || e.key === 'U' || e.key === 'Backspace') { e.preventDefault(); undo(); }
      else if (e.key === 'n' || e.key === 'N') { const j = stage.querySelector('.jot-in'); if (j) { e.preventDefault(); j.focus(); j.select(); } }
      return;
    }
    if (drawer.classList.contains('on')) { if (e.key === 'Escape') { e.preventDefault(); a && a.blur(); closeDrawer(); } return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); openSift(null); }
    else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undo(); }
    else if (e.key === '/' && feat.bar) { e.preventDefault(); find.focus(); find.select(); }
    else if ((e.key === 'c' || e.key === 'C') && feat.copy) { e.preventDefault(); copyStage(e.shiftKey); }
  }
  if (opts.keys !== false) document.addEventListener('keydown', onKey);
  bdesc.addEventListener('click', () => opts.onDescClick && !groups && opts.onDescClick(meta));
  let unsub = store.subscribe ? store.subscribe(() => reload(true)) : null;

  const ready = load().then(() => paint(null), fail);
  return {
    ready,
    reload,
    toast,
    undo,
    copy: copyStage,
    setStage,
    open: openDrawer,
    closeDrawer,
    sift: openSift,
    closeSift,
    get view() { return view(); },
    get board() { return meta; },
    get cards() { return cards.slice(); },
    /* Point the board at another store (another of pit's boards) without
       re-mounting: same element, same listeners. */
    async use(next, at = {}) {
      unsub && unsub();
      store = next;
      unsub = store.subscribe ? store.subscribe(() => reload(true)) : null;
      sel = null; fresh.clear(); stageLane = at.stage || 'in';
      drawer.classList.remove('on'); scrim.classList.remove('on');
      siftEl.classList.remove('on');
      await load(); paint(null);
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      unsub && unsub();
      root.innerHTML = '';
    },
  };
}

/* Theme by setting --pit-* on the host or anything above it; every one falls
   back to pit's own palette (Rosé Pine Dawn light, Catppuccin Frappé dark). */
const TOKENS = (d) => `
  --bg:var(--pit-bg,${d ? '#292c3c' : '#faf4ed'}); --surface:var(--pit-surface,${d ? '#303446' : '#fffaf3'});
  --sunk:var(--pit-sunk,${d ? '#232634' : '#f4ede8'}); --card:var(--pit-card,${d ? '#414559' : '#fffaf3'});
  --ink:var(--pit-ink,${d ? '#c6d0f5' : '#575279'}); --muted:var(--pit-muted,${d ? '#a5adce' : '#797593'});
  --faint:var(--pit-faint,${d ? '#838ba7' : '#9893a5'}); --rule:var(--pit-rule,${d ? '#51576d' : '#cecacd'});
  --hair:var(--pit-hair,${d ? '#414559' : '#dfdad9'}); --spark:var(--pit-spark,${d ? '#e5c890' : '#ea9d34'});
  --spark-ink:var(--pit-spark-ink,${d ? '#232634' : '#2a1f08'}); --cold:var(--pit-cold,${d ? '#8caaee' : '#286983'});
  --dead:var(--pit-dead,${d ? '#737994' : '#9893a5'});
  --shadow:var(--pit-shadow,${d ? '0 1px 2px rgba(0,0,0,.35)' : '0 1px 2px rgba(87,82,121,.07),0 3px 8px rgba(87,82,121,.06)'});
  --lift:var(--pit-lift,${d ? '0 10px 28px rgba(0,0,0,.45)' : '0 8px 24px rgba(87,82,121,.14)'});
  --drop:var(--pit-drop,${d ? '0 18px 56px rgba(0,0,0,.6)' : '0 16px 48px rgba(87,82,121,.20)'});
  color-scheme:var(--pit-scheme,${d ? 'dark' : 'light'});`;

const STYLE = `
:host{display:flex;flex-direction:column;min-height:0;${TOKENS(false)}
  --sans:var(--pit-font,"Inter Tight",system-ui,-apple-system,sans-serif);
  --mono:var(--pit-mono,"JetBrains Mono",ui-monospace,monospace);
  --display:var(--pit-display,"Martian Mono",var(--mono))}
@media (prefers-color-scheme:dark){:host{${TOKENS(true)}}}
*{box-sizing:border-box}
[hidden]{display:none !important}
.pit{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
  font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
button,input,textarea,select{font:inherit;color:inherit}
.bar{flex:none;display:flex;align-items:center;gap:11px;height:52px;padding:0 14px;
  border-bottom:1px solid var(--hair);background:var(--surface)}
.mark{font-family:var(--display);font-weight:700;font-size:16px;letter-spacing:-.07em;flex:none}
.mark::after{content:"";display:inline-block;width:6px;height:6px;background:var(--spark);margin-left:6px;vertical-align:2px}
.bname{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.bdesc{font-size:12.5px;color:var(--faint);max-width:30ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.bdesc:hover{color:var(--muted)}
.bdesc.static{cursor:default}
.bdesc.static:hover{color:var(--faint)}
.bar-sp{flex:1}
.stat{font-family:var(--mono);font-size:11px;color:var(--faint);white-space:nowrap}
.find{flex:none;width:130px;background:var(--card);border:1px solid var(--hair);border-radius:6px;
  padding:6px 10px;font-size:12.5px;transition:width .16s,border-color .15s,box-shadow .15s}
.find:focus{outline:none;width:min(300px,32vw);border-color:var(--spark);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--spark) 18%,transparent)}
.find.hit{border-color:var(--spark)}
.find::placeholder{color:var(--faint)}
.ghost{flex:none;background:none;border:1px solid var(--rule);color:var(--muted);padding:6px 10px;
  border-radius:6px;cursor:pointer;font-size:12.5px;white-space:nowrap}
.ghost:hover{color:var(--ink);border-color:var(--ink)}
.ghost:focus-visible{outline:2px solid var(--spark);outline-offset:2px}
.go{display:flex;align-items:center;gap:8px;flex:none;background:var(--spark);
  color:var(--spark-ink);border:0;padding:8px 13px;border-radius:6px;cursor:pointer;
  font-size:13.5px;font-weight:600;letter-spacing:-.01em}
.go:hover{filter:brightness(1.07)}
.go[disabled]{opacity:.4;cursor:default;filter:none}
.go kbd,.go .n{font-family:var(--mono);font-size:10px;font-weight:500;
  background:color-mix(in srgb,var(--spark-ink) 15%,transparent);border-radius:3px;padding:2px 5px}
.ghost kbd{font-family:var(--mono);font-size:10px}

.board{flex:1;min-height:0;display:grid;gap:0;overflow:hidden;grid-template-columns:minmax(0,1fr) minmax(230px,23vw)}
.col{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--bg);transition:background .15s}
.col.over{background:color-mix(in srgb,var(--spark) 11%,var(--bg))}
.stage{border-right:1px solid var(--rule)}
.stage.is-out{background:color-mix(in srgb,var(--bg) 88%,var(--sunk))}
.col.is-done .col-name{color:var(--spark)}
.card.slim.marked{display:flex;align-items:flex-start;gap:7px}
.card.slim .why{flex:none;margin-top:1px}
.card.slim .t{flex:1;min-width:0}
.card.slim .src{margin-top:6px}
.board.all{grid-template-columns:minmax(0,1fr)}
.all-scroll{flex:1;min-height:0;overflow-y:auto}
.all .stage{flex:none;border-right:0}
.all .stage .col-body{flex:none;overflow:visible;padding-bottom:4px}
.all .stage .col-head{padding-top:22px}
.all .col-name{cursor:pointer;background:none;border:0;padding:0;font:inherit;
  font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink)}
.all .col-name:hover{color:var(--spark)}
.rail{min-height:0;display:flex;flex-direction:column;overflow-y:auto;background:var(--sunk)}
.rail .col{flex:none;background:none;border-bottom:1px solid var(--hair)}
.rail .col:last-child{border-bottom:0}
.rail .col-body{max-height:min(34vh,300px)}
.col-head{flex:none;display:flex;align-items:center;gap:8px;padding:13px 14px 9px}
.stage .col-head{padding:16px 20px 12px}
.col-name{font-family:var(--mono);font-size:10.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.stage .col-name{font-size:12px;color:var(--ink)}
.col-n{font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.col-hint{margin-left:auto;font-family:var(--mono);font-size:9.5px;color:var(--faint)}
.col-sift{background:none;border:0;cursor:pointer;padding:3px 6px;border-radius:4px;
  color:var(--faint);line-height:1;font-family:var(--mono);font-size:9.5px;
  letter-spacing:.13em;text-transform:uppercase;opacity:0;transition:opacity .15s}
.col:hover .col-sift,.col-sift:focus-visible{opacity:1}
@media (hover:none){.col-sift{opacity:1}}
.col-sift:hover{color:var(--spark-ink);background:var(--spark)}
.rail .col-head{cursor:pointer;width:100%;text-align:left;background:none;border:0}
.rail .col-head:hover .col-name{color:var(--ink)}
.rail .col-head:hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}
.col-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 10px 12px;display:flex;flex-direction:column;gap:7px}
.stage .col-body{padding:0 20px 16px;gap:10px}
.stage .col-head,.stage .col-body>*,.stage .quick input{max-width:860px;width:100%;display:block;margin-inline:auto}
.stage .col-head{display:flex}
.col-body::-webkit-scrollbar{width:8px}
.col-body::-webkit-scrollbar-thumb{background:var(--rule);border-radius:4px}
.col-empty{font-size:12.5px;color:var(--faint);padding:13px 8px;border:1px dashed var(--rule);border-radius:7px;text-align:center;line-height:1.4}
.stage .col-empty{padding:34px 20px;font-size:14px;max-width:46ch !important;margin:8px auto 0}
.quick{flex:none;padding:10px;border-top:1px solid var(--hair)}
.stage .quick{padding:12px 20px}
.quick input{width:100%;background:var(--card);border:1px dashed var(--rule);border-radius:7px;padding:9px 10px;font-size:13px;color:var(--ink)}
.quick input::placeholder{color:var(--faint)}
.quick input:focus{outline:none;border-style:solid;border-color:var(--spark);box-shadow:0 0 0 3px color-mix(in srgb,var(--spark) 20%,transparent)}

.card{background:var(--card);border:1px solid var(--hair);border-radius:7px;padding:9px 10px 8px;
  cursor:grab;box-shadow:var(--shadow);text-align:left;width:100%;position:relative;
  transition:box-shadow .15s,border-color .15s,opacity .18s}
.card:hover{border-color:var(--rule);box-shadow:var(--lift)}
.card:focus-visible{outline:2px solid var(--spark);outline-offset:2px}
.card.dragging{opacity:.35;cursor:grabbing}
.card.lifted{position:fixed;z-index:170;margin:0;pointer-events:none;opacity:.96;box-shadow:var(--drop);transform:scale(1.03);cursor:grabbing}
.board.holding{user-select:none;-webkit-user-select:none}
.card.sel{border-color:var(--spark);box-shadow:0 0 0 1px var(--spark)}
.card .t{font-size:13.5px;font-weight:500;line-height:1.32;letter-spacing:-.005em;margin:0 0 3px;overflow-wrap:anywhere}
.card .n{font-size:11.5px;color:var(--muted);line-height:1.36;margin:0;overflow-wrap:anywhere}
.card .f{display:flex;align-items:center;gap:7px;margin-top:8px;font-family:var(--mono);font-size:10px;color:var(--faint)}
.card .src{width:5px;height:5px;border-radius:50%;background:var(--cold);flex:none}
.card .src.agent{background:var(--spark)}
.card .by{color:var(--spark);letter-spacing:.06em}
.card .link,.dw-url a{color:var(--cold);text-decoration:none}
.card .link:hover,.dw-url a:hover{text-decoration:underline}
.card .age{margin-left:auto;white-space:nowrap}
.card .why{font-family:var(--mono);font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;
  border:1px solid currentColor;border-radius:3px;padding:1px 4px;color:var(--cold);opacity:.85}
.card .why.done{color:var(--spark)}
.card.fresh{animation:land .55s cubic-bezier(.2,.7,.3,1)}
@keyframes land{from{opacity:0;transform:translateY(-8px);box-shadow:0 0 0 3px var(--spark)}to{opacity:1;transform:none}}
.card.big{padding:14px 18px 12px 46px;border-radius:9px}
.card.big.has-img{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:14px}
.card.big.has-img>*{grid-column:1}
.card.big.has-img>.num{grid-column:auto}
.card.big .thumb{grid-column:2 !important;grid-row:1 / span 4;width:84px;height:84px;object-fit:cover;border-radius:6px;border:1px solid var(--hair)}
.card.big .num{position:absolute;left:0;top:0;width:46px;padding-top:15px;text-align:center;font-family:var(--mono);font-size:12px;font-weight:700;color:var(--spark)}
.card.big .t{font-size:16.5px;font-weight:600;line-height:1.28;letter-spacing:-.014em;margin:0 0 4px}
.card.big .n{font-size:13px;line-height:1.45}
.card.big .ex{font-size:12.5px;color:var(--faint);line-height:1.5;margin:8px 0 0;padding-left:11px;border-left:2px solid var(--hair);
  overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card.big .f{margin-top:10px}
.stage.is-out .card{background:transparent;box-shadow:none;color:var(--dead);border-style:dashed}
.stage.is-out .card .n,.stage.is-out .card .ex,.stage.is-out .card .f,.stage.is-out .card .num{color:var(--dead)}
.card.slim{padding:7px 9px;box-shadow:none;background:var(--card)}
.card.slim .t{font-size:12.5px;font-weight:400;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rail .col[data-k="out"] .card{background:transparent;border-style:dashed;color:var(--dead)}

.sift{position:fixed;inset:0;z-index:120;background:var(--surface);display:flex;flex-direction:column;
  opacity:0;pointer-events:none;transform:scale(.994);transition:opacity .2s ease,transform .2s cubic-bezier(.2,.7,.3,1)}
.sift.on{opacity:1;pointer-events:auto;transform:none}
.sift-top{flex:none;display:flex;align-items:center;gap:12px;height:52px;padding:0 14px;border-bottom:1px solid var(--hair)}
.sift-board{padding-left:11px;border-left:1px solid var(--rule);font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22ch}
.sift-board:empty{display:none}
.sift-scope{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding-left:11px;border-left:1px solid var(--rule)}
.sift-stage{flex:1;min-height:0;display:grid;gap:10px;padding:12px;
  grid-template-columns:minmax(140px,18vw) minmax(0,1fr) minmax(140px,18vw);grid-template-rows:auto minmax(0,1fr) auto}
.zone{position:relative;overflow:hidden;border:1px dashed var(--rule);background:none;border-radius:9px;
  cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:10px;color:var(--muted);
  transition:background .14s,color .14s,border-color .14s,transform .14s}
.zone:hover,.zone.armed{background:color-mix(in srgb,var(--spark) 14%,transparent);border-color:var(--spark);border-style:solid;color:var(--ink)}
.zone.hit{animation:caught .42s cubic-bezier(.2,.7,.3,1)}
@keyframes caught{0%{background:color-mix(in srgb,var(--spark) 40%,transparent);border-color:var(--spark);border-style:solid;color:var(--ink);transform:scale(1.012)}
  100%{background:none;border-color:var(--rule);color:var(--muted);transform:none}}
.zone.out.hit{animation-name:caught-out}
@keyframes caught-out{0%{background:color-mix(in srgb,var(--dead) 34%,transparent);border-color:var(--dead);border-style:solid;transform:scale(1.012)}
  100%{background:none;border-color:var(--rule);transform:none}}
.zone .n.bump{animation:bump .42s cubic-bezier(.2,.7,.3,1)}
@keyframes bump{0%{transform:translateY(-7px) scale(1.5);color:var(--spark);opacity:0}40%{opacity:1}100%{transform:none;color:var(--faint)}}
.zone .key{font-family:var(--mono);font-size:15px;line-height:1}
.zone .lbl{font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase}
.zone .n{font-family:var(--mono);font-size:10px;color:var(--faint)}
.zone.out{grid-column:1;grid-row:2}
.zone.in{grid-column:3;grid-row:2}
.zone.maybe{grid-column:2;grid-row:1;flex-direction:row;gap:10px}
.zone.unsure{grid-column:2;grid-row:3;flex-direction:row;gap:10px}
.zone.out:hover,.zone.out.armed{background:color-mix(in srgb,var(--dead) 20%,transparent);border-color:var(--dead);color:var(--muted)}
.deck{grid-column:2;grid-row:2;min-height:0;height:100%;display:flex;align-items:center;justify-content:center;transition:transform .18s cubic-bezier(.2,.7,.3,1)}
.pile{position:relative;width:min(820px,100%);max-height:100%;display:flex}
.sift-stage:has(.zone.in:hover) .deck{transform:translateX(9px) rotate(.5deg)}
.sift-stage:has(.zone.out:hover) .deck{transform:translateX(-9px) rotate(-.5deg)}
.sift-stage:has(.zone.maybe:hover) .deck{transform:translateY(-6px)}
.sift-stage:has(.zone.unsure:hover) .deck{transform:translateY(6px)}
.deck i{position:absolute;left:0;right:0;top:0;bottom:0;border-radius:11px;background:color-mix(in srgb,var(--card) 78%,var(--bg));
  border:1px solid var(--hair);pointer-events:none;transform-origin:50% 0;transition:transform .22s cubic-bezier(.2,.7,.3,1),opacity .22s}
.deck i.b1{transform:translateY(13px) scaleX(.985);opacity:.85}
.deck i.b2{transform:translateY(25px) scaleX(.968);opacity:.55}
.sift-card{position:relative;z-index:1;flex:1;min-width:0;max-height:100%;overflow:hidden auto;
  background:var(--card);border:1px solid var(--hair);border-radius:11px;box-shadow:var(--lift);
  padding:clamp(16px,3vh,30px) clamp(18px,3.5vw,40px);display:flex;flex-direction:column;font-size:calc(14px * var(--fit,1));gap:.85em}
.sift-card.over{mask-image:linear-gradient(#000 88%,transparent)}
.sift-card .src{font-family:var(--mono);font-size:.74em;letter-spacing:.13em;text-transform:uppercase;color:var(--faint)}
.sift-card .src.agent{color:var(--spark)}
.sift-card .art{display:block;max-width:100%;max-height:min(42vh,26em);object-fit:contain;align-self:flex-start;border-radius:8px}
.sift-card h2{font-size:2.15em;font-weight:600;line-height:1.14;letter-spacing:-.028em;margin:0;overflow-wrap:anywhere}
.sift-card .note{margin:0;font-size:1.06em;color:var(--muted)}
.sift-card .link{font-family:var(--mono);font-size:.82em;color:var(--cold);text-decoration:none;align-self:flex-start}
.sift-card .link:hover{text-decoration:underline}
.sift-card .body{font-size:1em;color:var(--muted);margin:0;max-width:64ch;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;padding-left:.85em;border-left:2px solid var(--hair)}
.sift-card .said{padding:.6em .85em;background:var(--sunk);border-radius:7px;font-size:.92em;color:var(--muted);max-width:64ch;display:flex;flex-direction:column;gap:.55em}
.sift-card .said p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.sift-card .said b{display:block;color:var(--faint);font-weight:500;font-family:var(--mono);font-size:.72em;letter-spacing:.13em;text-transform:uppercase;margin-bottom:.15em}
.sift-card .said b.agent{color:var(--spark)}
.jot{display:flex;gap:8px;align-items:flex-start;margin:-.35em 0 0}
.jot span{margin-top:.5em;font-family:var(--mono);font-size:.7em;color:var(--faint);opacity:0}
.jot textarea{flex:1;min-width:0;max-width:52ch;background:none;border:0;resize:none;overflow:hidden;display:block;line-height:1.42;
  border-bottom:1px dashed transparent;padding:2px 0;font-size:1.06em;color:var(--muted)}
.jot:hover textarea{border-bottom-color:var(--rule)}
.jot textarea:focus{outline:none;color:var(--ink);border-bottom-color:var(--spark);border-bottom-style:solid}
.jot textarea::placeholder{color:var(--faint)}
.jot:hover span,.jot textarea:focus + span{opacity:1}
.sift-foot{flex:none;display:flex;align-items:center;gap:13px;flex-wrap:wrap;padding:11px 14px;border-top:1px solid var(--hair);font-family:var(--mono);font-size:11px;color:var(--muted)}
.meter{flex:1;min-width:100px;height:3px;background:var(--sunk);border-radius:2px;overflow:hidden}
.meter i{display:block;height:100%;width:0;border-radius:2px;background:linear-gradient(90deg,var(--cold),var(--spark));transition:width .32s cubic-bezier(.2,.7,.3,1)}
.meter i.full{animation:glow 1.1s ease-out}
@keyframes glow{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--spark) 70%,transparent)}100%{box-shadow:0 0 0 7px transparent}}
.tally{display:flex;gap:10px}
.tally b{color:var(--ink);font-weight:700}
.tally .just{color:var(--spark);animation:bump .42s cubic-bezier(.2,.7,.3,1)}
.left-n.tick{animation:tick .3s ease-out}
@keyframes tick{0%{transform:translateY(-4px);opacity:.3}100%{transform:none;opacity:1}}
.done{grid-column:1/-1;grid-row:1/-1;display:flex;flex-direction:column;justify-content:center;padding:clamp(24px,6vh,60px) clamp(24px,5vw,70px);animation:rise .42s cubic-bezier(.2,.7,.3,1)}
.done>*{animation:rise .5s cubic-bezier(.2,.7,.3,1) backwards}
.done>*:nth-child(2){animation-delay:.06s}
.done>*:nth-child(3){animation-delay:.12s}
.done>*:nth-child(4){animation-delay:.18s}
.done li{animation:rise .45s cubic-bezier(.2,.7,.3,1) backwards}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.done h2{font-family:var(--display);font-size:clamp(20px,2.6vw,30px);letter-spacing:-.05em;margin:0 0 8px}
.done>p{color:var(--muted);margin:0 0 22px;max-width:56ch}
.done ol{margin:0 0 24px;padding:0;list-style:none;counter-reset:w;max-width:660px}
.done li{display:flex;gap:14px;align-items:baseline;overflow-wrap:anywhere;padding:9px 0;border-bottom:1px solid var(--hair);counter-increment:w;font-size:15px}
.done li::before{content:counter(w);font-family:var(--mono);font-size:11px;color:var(--spark);font-weight:700;width:12px;flex:none}
.done li span{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--faint);white-space:nowrap}
.done-acts{display:flex;gap:10px;flex-wrap:wrap}

.scrim{position:fixed;inset:0;z-index:130;background:rgba(10,13,15,.36);opacity:0;pointer-events:none;transition:opacity .2s}
.scrim.on{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);z-index:140;background:var(--surface);
  border-left:1px solid var(--rule);box-shadow:var(--drop);display:flex;flex-direction:column;
  transform:translateX(102%);transition:transform .24s cubic-bezier(.2,.7,.3,1);visibility:hidden}
.drawer.on{transform:none;visibility:visible}
.dw-top{flex:none;display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--hair)}
.lanechip{appearance:none;background:var(--sunk);border:1px solid var(--hair);border-radius:5px;padding:4px 9px;
  font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);cursor:pointer}
.srcchip{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
.srcchip i{width:5px;height:5px;border-radius:50%;background:var(--cold)}
.srcchip.agent{color:var(--spark)}
.srcchip.agent i{background:var(--spark)}
.dw-x{margin-left:auto;background:none;border:0;color:var(--faint);cursor:pointer;font-size:18px;line-height:1;padding:2px 7px;border-radius:4px}
.dw-x:hover{color:var(--ink);background:var(--sunk)}
.dw-body{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 22px}
.dw-img{display:block;max-width:100%;max-height:40vh;object-fit:contain;border-radius:8px;margin-bottom:12px}
.dw-url{margin:-8px 0 14px;font-family:var(--mono);font-size:11px;overflow-wrap:anywhere}
.dw-title,.dw-note{width:100%;background:none;border:0;padding:0;resize:none;overflow:hidden;display:block}
.dw-title{font-size:20px;font-weight:600;line-height:1.24;letter-spacing:-.022em;margin:0 0 8px;overflow-wrap:anywhere}
.dw-note{font-size:13px;color:var(--muted);line-height:1.45;margin:0 0 16px}
.dw-title:focus,.dw-note:focus{outline:none}
.dw-stats{display:flex;flex-wrap:wrap;gap:0 22px;padding:12px 0;margin-bottom:18px;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.dw-stats div{display:flex;flex-direction:column;gap:1px}
.dw-stats dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.dw-stats dd{margin:0;font-family:var(--mono);font-size:13px;font-weight:500}
.lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);display:block;margin:0 0 7px}
.dw-text{width:100%;min-height:104px;background:var(--card);color:var(--ink);border:1px solid var(--hair);border-radius:7px;padding:11px 12px;font-size:13.5px;line-height:1.55;resize:none;overflow:hidden;margin-bottom:20px}
.dw-text:focus{outline:none;border-color:var(--rule);box-shadow:0 0 0 3px color-mix(in srgb,var(--spark) 20%,transparent)}
.dw-text::placeholder,.composer textarea::placeholder{color:var(--faint)}
.cmt{padding:11px 0;border-bottom:1px solid var(--hair)}
.cmt:first-of-type{border-top:1px solid var(--hair)}
.cmt-h{display:flex;align-items:center;gap:7px;margin-bottom:4px;font-family:var(--mono);font-size:10px;color:var(--faint)}
.cmt-h i{width:5px;height:5px;border-radius:50%;background:var(--cold);flex:none}
.cmt-h.agent i{background:var(--spark)}
.cmt-h b{color:var(--muted);font-weight:500;letter-spacing:.1em;text-transform:uppercase}
.cmt p{margin:0;font-size:13.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.cmt-empty{font-size:13px;color:var(--faint);padding:10px 0 4px;line-height:1.45;margin:0}
.composer{display:flex;gap:8px;margin-top:12px}
.composer textarea{flex:1;min-height:38px;max-height:120px;background:var(--card);color:var(--ink);border:1px solid var(--hair);border-radius:7px;padding:9px 11px;font-size:13.5px;resize:none}
.composer textarea:focus{outline:none;border-color:var(--rule)}
.dw-foot{flex:none;display:flex;gap:9px;align-items:center;padding:11px 14px;border-top:1px solid var(--hair)}
.danger:hover{color:var(--spark-ink);background:var(--spark);border-color:var(--spark)}
.saved{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--faint);opacity:0;transition:opacity .2s}
.saved.on{opacity:1}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%) translateY(14px);background:var(--ink);color:var(--bg);
  border-radius:7px;padding:9px 15px;font-size:12.5px;box-shadow:var(--lift);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:200;max-width:90vw}
.toast.on{opacity:1;transform:translateX(-50%)}

@media (max-width:860px){
  .board{grid-template-columns:none !important;grid-template-rows:minmax(0,1.5fr) minmax(0,1fr)}
  .board.all{grid-template-rows:minmax(0,1fr)}
  .stage{border-right:0;border-bottom:1px solid var(--rule)}
  .stage .col-head,.stage .col-body,.stage .quick{padding-left:14px;padding-right:14px}
  .rail .col-body{max-height:none}
  .stat,.bar .bdesc{display:none}
  .bar{gap:8px;padding:0 10px}
  .find{width:96px}
  .find:focus{width:min(220px,52vw)}
  .sift-top .bdesc,.sift-top .sift-board{display:none}
  .sift-foot .keys{display:none}
  .sift-stage{grid-template-columns:repeat(var(--zones,4),1fr);grid-template-rows:minmax(0,1fr) auto;gap:8px;padding:8px}
  .deck{grid-column:1/-1;grid-row:1;align-self:stretch;width:100%}
  .deck i{display:none}
  .zone{grid-row:2 !important;grid-column:auto !important;flex-direction:column !important;gap:3px !important;padding:9px 4px;min-height:48px}
  .zone.out{order:1}.zone.unsure{order:2}.zone.maybe{order:3}.zone.in{order:4}
  .zone .key{display:none}
  .drawer{width:100vw}
}
@media (prefers-reduced-motion:reduce){
  .sift-stage:has(.zone:hover) .deck{transform:none}
  .card.fresh{animation:none}
  .done>*,.done li{animation:none}
  .deck i{transition:none}
}
`;
