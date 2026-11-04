// The board's "new since you looked" marks come from /api/seen, so every device agrees.
// node seen.js [base]
const { chromium } = require('playwright-core');
const exe = process.env.CHROME_BIN;
const base = process.argv[2] || 'http://127.0.0.1:7299';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const sid = (n) => `seen${n}000-0000-0000-0000-000000000000`;

(async () => {
  const real = await (await fetch(base + '/api/sessions')).json();
  const proto = (Array.isArray(real) ? real : real.sessions).find((s) => s.state === 'your-turn') || real[0];
  const turn = iso(-10 * 60000);
  const mk = (n, title) => ({ ...JSON.parse(JSON.stringify(proto)), sessionId: sid(n), id: `seen${n}`, title, cwd: '/home/you/code/seentest', state: 'your-turn', parked: false, pinned: false, asks: [], updated: turn });
  const list = [...(Array.isArray(real) ? real : real.sessions), mk(1, 'looked after its turn'), mk(2, 'looked before its turn'), mk(3, 'never looked at')];
  const seen = { [sid(1)]: iso(-5 * 60000), [sid(2)]: iso(-60 * 60000) };
  const b = await chromium.launch({ executablePath: exe });

  const open = async (events, pane) => {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript((pane) => { try { localStorage.setItem('atc.notifask', '1'); localStorage.removeItem('atc.project'); localStorage.removeItem('atc.seen'); if (pane) localStorage.setItem('atc.pane', pane); } catch {} }, pane);
    const p = await ctx.newPage(), writes = [], errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/\/api\/(?!events)/, (r) => {
      const q = r.request(), u = new URL(q.url());
      if (q.method() !== 'GET') { writes.push({ path: u.pathname, body: q.postData() || '' }); return r.fulfill({ status: 204 }); }
      if (u.pathname === '/api/seen') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(seen) });
      return r.continue();
    });
    await p.route('**/api/events', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: `event: sessions\ndata: ${JSON.stringify(list)}\n\n` + events.map((e) => `event: seen\ndata: ${JSON.stringify(e)}\n\n`).join('') }));
    return { ctx, p, writes, errs };
  };
  const fresh = (p, n) => p.$eval(`.bview [data-sid="${sid(n)}"]`, (e) => e.classList.contains('fresh')).catch(() => null);

  {
    const { ctx, p, errs } = await open([]);
    await p.goto(`${base}/`);
    await p.waitForTimeout(3000);
    ok(await fresh(p, 1) === false, 'looked at after its turn: not marked');
    ok(await fresh(p, 2) === true, 'looked at before its turn ended: marked new');
    ok(await fresh(p, 3) === true, 'never looked at, turn ended after atc started keeping marks: marked new');
    ok(!errs.length, `no page errors ${errs.join(' | ')}`);
    await ctx.close();
  }
  {
    const { ctx, p } = await open([{ sessionId: sid(2), at: iso(0), from: 'another-device' }]);
    await p.goto(`${base}/`);
    await p.waitForTimeout(3000);
    ok(await fresh(p, 2) === false, 'looked at on another device: the mark clears here');
    await ctx.close();
  }
  {
    const { ctx, p, writes } = await open([], 'out');
    await p.goto(`${base}/#/s/${sid(2)}`);
    await p.waitForTimeout(3000);
    ok(writes.some((w) => w.path === '/api/seen' && w.body.includes(sid(2))), 'opening it in the terminal marks it seen on the server (stubbed)');
    await ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
