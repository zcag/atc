const { chromium } = require('/home/user/proj/ui-kit/node_modules/playwright-core');
const fs = require('fs');
const { fakeSessions } = require('./fake.js');
const exe = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = __dirname + '/../../shots/build/';
const FAKE = fs.readFileSync(__dirname + '/fakecall.js', 'utf8');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };

const row = (o) => ({ sessionId: `hold-${o.id}-0000-0000-0000-000000000000`, id: `hold${o.id}`, cwd: '/home/user/proj/atc', attachable: true, updated: new Date().toISOString(), ...o });
const FEED = [
  row({ id: 1, title: 'Invoice spec', cwd: '/home/user/proj/shop', state: 'needs-you', activity: 'Keep both?', asks: [{ id: 'a', questions: [{ question: 'Keep both date formats, or normalise to cents?', options: [{ label: 'Keep both', description: 'x' }, { label: 'Normalise', description: 'y' }] }] }] }),
  row({ id: 2, title: 'atc hold screen', state: 'your-turn', summary: { status: 'Shipped to master and installed on both machines' } }),
  row({ id: 5, title: 'Review PR 8', cwd: '/home/user/proj/shop', state: 'your-turn', summary: { status: 'Request changes on the search filters PR' } }),
  row({ id: 6, title: 'shop-api', cwd: '/home/user/proj/shop', state: 'your-turn', summary: { status: 'Ready for review, not pushed' } }),
  row({ id: 3, title: 'Price parsing', cwd: '/home/user/proj/shop', state: 'working', activity: 'Running the spec', promptAt: new Date(Date.now() - 134000).toISOString() }),
  row({ id: 4, title: 'tracker sweep', state: 'working', activity: 'Reading mail' }),
];
const posts = [];
const prep = async (ctx) => {
  await ctx.addInitScript(() => { try { localStorage.setItem('atc.notifask', '1'); } catch {} });
  await ctx.route('**/call.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE }));
  await ctx.route('**/api/**', (r) => { if (r.request().method() === 'GET') return r.continue(); posts.push(new URL(r.request().url()).pathname); return r.fulfill({ status: 204 }); });
};
const phone = (b, scheme, h = 860, w = 400) => b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme, permissions: ['microphone'] });
const hash = (p) => p.evaluate(() => location.hash);
const box = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; }, sel);
const open = async (c, feed, at = '/#/hold') => { await prep(c); const p = await c.newPage(); await fakeSessions(p, base, (list) => [...list.filter((s) => s.kind === 'hub'), ...feed]); await p.goto(base + at); return p; };

(async () => {
  const b = await chromium.launch({ executablePath: exe, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const scheme of ['light', 'dark']) {
    const ctx = await phone(b, scheme);
    const p = await open(ctx, FEED);
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.waitForSelector('.hold .hr .sb', { timeout: 8000 });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${OUT}hold-400-${scheme}.png` });

    const tiles = await p.$$eval('.hold .htile span:first-child', (l) => l.map((e) => e.textContent));
    ok(tiles.includes('usage') && tiles.includes('mem'), `${scheme}: tiles show usage and memory`);
    const dial = await box(p, '.hold .dial'), band = await box(p, '.hband');
    ok(dial.y < band.y && dial.r > 370 && dial.h >= 100, 'Call is big, on the right, raised out of the band');
    ok((await p.$$('.hold .hkeys button')).length === 4, 'four shortcuts under it');
    ok((await p.$eval('.hold .hr b', (e) => e.textContent)) === 'Invoice spec', 'what needs them comes first');
    ok((await p.$$('.hold .hr')).length === 4, 'Waiting lists every waiting session');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
    const small = await p.$$eval('.hold a, .hold button', (l) => l.filter((e) => e.getBoundingClientRect().height < 44).length);
    ok(small === 0, 'every target is at least 44px');

    await p.tap('.hold .hr .ask .btn');
    await p.waitForTimeout(300);
    ok(posts.some((u) => u.includes('/answer') || u.includes('hold-1')), 'an answer goes out from the row');
    ok(await hash(p) === '#/hold', 'and stays on the screen');

    await p.tap('.htabs button:nth-child(2)');
    ok((await p.$$('.hold .hr.working')).length === 2, 'Working lists the running ones');
    await p.screenshot({ path: `${OUT}hold-working-400-${scheme}.png` });
    await p.tap('.htabs button:nth-child(3)');
    ok((await p.$$('.hold .hr')).length >= 6, 'Recent lists them all');

    await p.tap('.hold .dial');
    await p.waitForTimeout(500);
    ok(await p.evaluate(() => window.__dialed === 1), 'Call dials');
    ok(await hash(p) === '#/call', 'and shows the call');
    await ctx.close();

    const c2 = await phone(b, scheme);
    const q = await open(c2, FEED, '/#/usage');
    await q.waitForTimeout(800);
    const hold = async () => { await q.evaluate(() => (location.hash = '#/hold')); await q.waitForSelector('.hold .hr .sb'); };
    await hold();
    await q.evaluate(() => window.leaveHold());
    await q.waitForTimeout(300);
    ok(await hash(q) === '#/usage', 'leaving goes back to where it was');
    for (const [sel, want, what] of [['.hold .sess', /^#?\/?$|^#\/$/, 'Sessions opens the board'], ['.hkeys button:nth-child(1)', /^#\/assist$/, 'Assistant opens the conversation'], ['.hkeys button:nth-child(3)', /^#\/g\//, 'Pages opens pages'], ['.hkeys button:nth-child(4)', /^#\/backlog$/, 'Backlog opens the backlog'], ['.hold .hr > a', /^#\/s\//, 'a row opens its session'], ['button.htile', /^#\/(usage|resources)$/, 'a tile opens its page']]) {
      await hold();
      await q.tap(sel);
      await q.waitForTimeout(300);
      ok(want.test(await hash(q)), what);
    }
    await hold();
    await q.tap('.hkeys button:nth-child(2)');
    await q.waitForTimeout(300);
    ok(!(await q.$('.hold')), 'New leaves the screen');
    ok(await q.isVisible('.veil, .sheet, [class*="newsess"], textarea'), 'for the new session sheet');
    await c2.close();

    const c3 = await phone(b, scheme);
    const n = await open(c3, []);
    await n.waitForSelector('.hlist .none');
    await n.waitForTimeout(600);
    await n.screenshot({ path: `${OUT}hold-empty-400-${scheme}.png` });
    await c3.close();

    for (const [w, h] of [[360, 640], [620, 1300]]) {
      const c = await phone(b, scheme, h, w);
      const s = await open(c, FEED);
      await s.waitForSelector('.hold .hr .sb');
      await s.waitForTimeout(800);
      await s.screenshot({ path: `${OUT}hold-${w}-${scheme}.png` });
      ok((await box(s, '.hold')).w === w, `${w}px: the whole width`);
      ok((await box(s, '.hkeys')).b === h, `${w}px: the shortcuts on screen`);
      ok((await box(s, '.hlist')).h > 120, `${w}px: room for the list`);
      await c.close();
    }
    ok(errs.length === 0, `no page errors ${errs.join(' | ')}`);
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'hold: all ok');
  process.exit(fails ? 1 : 0);
})();
