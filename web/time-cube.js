export const SLOT = 5, SAME_STRETCH = 300, OUTSIDE = "outside sessions";

const tally = (m, name) => (m[name] ||= { name, cost: 0, ids: new Set() });
const most = (m) => Object.values(m).map(({ ids, ...x }) => ({ ...x, sessions: ids.size })).sort((a, b) => b.cost - a.cost || (a.name > b.name ? 1 : -1));
export const dayKey = (ms) => new Date(ms).toLocaleDateString("en-CA");

// `cost` is seconds here, so the spend page's bars, hours and lists draw time too.
export function timeCube(sessions, runs, sel = {}) {
  const buckets = {}, bays = {}, rows = [], devices = {}, hours = {};
  const ours = (s) => !sel.profile || s.profile === sel.profile, inBay = (s) => !sel.bay || s.bay === sel.bay;
  let total = 0, before = 0, range = 0;
  for (const s of sessions) {
    if (!ours(s)) continue;
    let secs = 0, days = 0;
    for (const [d, n] of Object.entries(s.days)) {
      range += n;
      if (inBay(s)) {
        const b = tally(buckets, d);
        b.cost += n;
        b.ids.add(s.sessionId);
        (b.models ||= {})[s.bay] = (b.models[s.bay] || 0) + n;
      }
      if (sel.bucket && d !== sel.bucket) continue;
      const y = tally(bays, s.bay);
      y.cost += n;
      y.ids.add(s.sessionId);
      secs += n;
      days++;
    }
    if (!inBay(s)) continue;
    total += secs;
    before += s.before || 0;
    if (secs) rows.push({ ...s, secs, count: days });
  }
  const by = new Map(sessions.map((s) => [s.sessionId, s]));
  const kept = [];
  for (const r of runs) {
    const s = by.get(r.s);
    if (!s || !ours(s) || !inBay(s)) continue;
    const from = r.t * SLOT * 1000, secs = r.n * SLOT, day = dayKey(from);
    const h = (hours[day] ||= Array(24).fill(0));
    for (let t = from; t < from + secs * 1000; t += SLOT * 1000) h[new Date(t).getHours()] += SLOT;
    if (sel.bucket && day !== sel.bucket) continue;
    kept.push({ from, to: from + secs * 1000, secs, s, day });
    const d = tally(devices, r.d || "unknown");
    d.cost += secs;
    d.ids.add(r.s);
  }
  kept.sort((a, b) => a.from - b.from);
  const list = Object.fromEntries(Object.entries(buckets).map(([k, { ids, ...x }]) => [k, { ...x, sessions: ids.size }]));
  return { total, before, range, buckets: list, bays: most(bays), devices: most(devices), hours, runs: kept, rows: rows.sort((a, b) => b.secs - a.secs), ...stretches(kept) };
}

// A stretch is time in a row with no gap over five minutes; a switch is a change of session inside one.
export function stretches(runs) {
  const out = [];
  let switches = 0, at = null;
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r.from - last.to <= SAME_STRETCH * 1000) {
      if (!r.s.screen && at && at !== r.s.sessionId) switches++;
      last.to = Math.max(last.to, r.to);
      last.secs += r.secs;
      last.ids.add(r.s.sessionId);
    } else { out.push({ from: r.from, to: r.to, secs: r.secs, ids: new Set([r.s.sessionId]) }); at = null; }
    if (!r.s.screen) at = r.s.sessionId;
  }
  const len = out.map((x) => x.secs).sort((a, b) => a - b);
  return { stretches: out, switches, longest: out.reduce((m, x) => (!m || x.secs > m.secs ? x : m), null), typical: len.length ? len[len.length >> 1] : 0, counted: len.reduce((a, b) => a + b, 0) };
}

// The spend of each session in the same days, over every account: {sessionId: {cost, days: {day: cost}}}.
export function costs(reports, profile) {
  const out = {};
  for (const [name, rep] of Object.entries(reports)) {
    if (profile && name !== profile) continue;
    for (const s of rep?.sessions || []) {
      const x = (out[s.sessionId] ||= { cost: 0, days: {} });
      for (const [d, ms] of Object.entries(s.slices || {})) {
        const c = Object.values(ms).reduce((a, v) => a + v[0] + v[1] + v[2] + v[3], 0);
        x.cost += c;
        x.days[d] = (x.days[d] || 0) + c;
      }
    }
  }
  return out;
}

export function againstSpend(rows, spend, day) {
  const of = (x) => (x ? (day ? x.days[day] || 0 : x.cost) : 0);
  const seen = new Set(rows.map((r) => r.sessionId));
  let opened = 0, rest = 0, unopened = 0;
  for (const r of rows) opened += of(spend[r.sessionId]);
  for (const [id, x] of Object.entries(spend)) if (!seen.has(id) && of(x) > 0) { rest += of(x); unopened++; }
  return { of, opened, rest, unopened };
}
