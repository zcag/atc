export const sliceCost = (c) => c[0] + c[1] + c[2] + c[3];

const tally = (m, key) => (m[key] ||= { name: key, cost: 0, ids: new Set() });
const byCost = (m) => Object.values(m).map(({ ids, ...x }) => ({ ...x, sessions: ids.size })).sort((a, b) => b.cost - a.cost || (a.name > b.name ? 1 : -1));

// Each view leaves out its own selection: the bars still show every day when one day is picked, the bays every bay.
export function cube(sessions, sel = {}) {
  const buckets = {}, bays = {}, models = {}, hosts = {}, rows = [];
  const kinds = [0, 0, 0, 0];
  let total = 0, msgs = 0, toks = 0, range = 0;
  for (const s of sessions) {
    const inBay = !sel.bay || s.bay === sel.bay, inHost = !sel.host || s.host === sel.host;
    const row = { ...s, cost: 0, msgs: 0, tokens: 0, top: {} };
    for (const [b, ms] of Object.entries(s.slices || {})) {
      const inB = !sel.bucket || b === sel.bucket;
      for (const [m, c] of Object.entries(ms)) {
        const inM = !sel.model || m === sel.model, cost = sliceCost(c);
        range += cost;
        if (inBay && inHost && inM) {
          const x = tally(buckets, b);
          x.cost += cost;
          x.ids.add(s.sessionId);
          (x.models ||= {})[m] = (x.models[m] || 0) + cost;
        }
        if (inB && inHost && inM) { const x = tally(bays, s.bay); x.cost += cost; x.ids.add(s.sessionId); }
        if (inB && inHost && inBay) { const x = tally(models, m); x.cost += cost; x.ids.add(s.sessionId); }
        if (inB && inM && inBay) { const x = tally(hosts, s.host || ""); x.cost += cost; x.ids.add(s.sessionId); }
        if (inB && inBay && inHost && inM) {
          total += cost; msgs += c[4]; toks += c[5];
          for (let i = 0; i < 4; i++) kinds[i] += c[i];
          row.cost += cost; row.msgs += c[4]; row.tokens += c[5];
          row.top[m] = (row.top[m] || 0) + cost;
        }
      }
    }
    if (row.msgs) {
      row.model = Object.entries(row.top).sort((a, b) => b[1] - a[1])[0][0];
      rows.push(row);
    }
  }
  const barList = Object.fromEntries(Object.entries(buckets).map(([k, { ids, ...x }]) => [k, { ...x, sessions: ids.size }]));
  return { buckets: barList, bays: byCost(bays), models: byCost(models), hosts: byCost(hosts), rows: rows.sort((a, b) => b.cost - a.cost), kinds, total, msgs, tokens: toks, range };
}

export function niceMax(m) {
  if (!(m > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(m));
  return [1, 2, 2.5, 5, 10].find((k) => k * p >= m) * p;
}
