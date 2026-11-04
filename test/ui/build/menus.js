// A session's More menu is on top of everything under it, the State pane's file cards included, and those cards keep to their own width.
const { chromium } = require('playwright-core');
const exe = process.env.CHROME_BIN;
const base = process.argv[2] || 'http://127.0.0.1:7299';
const ok = (c, m) => console.log(c ? 'ok  ' : 'FAIL', m);
const COVERED = () => {
  const sheet = document.querySelector('.hd .more .sheet'), r = sheet.getBoundingClientRect(), over = new Set();
  for (let y = r.top + 2; y < Math.min(r.bottom, innerHeight); y += 8) for (let x = r.left + 2; x < r.right; x += 8) {
    const t = document.elementFromPoint(x, y);
    if (t && !sheet.contains(t)) over.add(`${t.tagName.toLowerCase()}.${t.className}`);
  }
  return [...over];
};
const STRAY_Z = () => [...document.querySelectorAll('.statep *, .tx *')].filter((e) => {
  const c = getComputedStyle(e);
  return c.zIndex !== 'auto' && +c.zIndex >= 10 && !e.matches('.slash, .lightbox, .droptarget');
}).map((e) => `${e.tagName.toLowerCase()}.${e.className} z=${getComputedStyle(e).zIndex}`);
(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const live = await (await fetch(base + '/api/sessions')).json();
  let s;
  for (const c of live) {
    const out = await (await fetch(`${base}/api/sessions/${c.sessionId}/outputs`)).json().catch(() => ({}));
    if ((out.files || out.made || []).length >= 4 || JSON.stringify(out).split('"path"').length > 5) { s = c; break; }
  }
  if (!s) return console.log('FAIL no session with files to test on');
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  await p.route(/\/api\//, (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204 }));
  await p.goto(`${base}/#/s/${s.sessionId}`);
  await p.waitForTimeout(2500);
  if (!(await p.$('.statep'))) await p.click('.hd .l2.items button.stat');
  await p.waitForSelector('.statep .card');
  await p.waitForTimeout(1000);
  const cards = await p.$$eval('.statep .card .pv', (l) => l.map((pv) => {
    const inner = pv.querySelector('.pvtext, .peek');
    return inner ? inner.getBoundingClientRect().width - pv.getBoundingClientRect().width : 0;
  }));
  ok(cards.length > 0 && cards.every((d) => Math.abs(d) < 1), `${cards.length} card previews are as wide as their card`);
  ok(!(await p.$('.statep .peek, .tx .peek')), 'the bay peek popover class is not used inside a session');
  await p.$eval('.statep .card', (c) => c.scrollIntoView({ block: 'start' }));
  await p.click('.hd .more button.kb');
  await p.waitForSelector('.hd .more .sheet');
  const under = await p.evaluate(() => {
    const r = document.querySelector('.hd .more .sheet').getBoundingClientRect();
    return [...document.querySelectorAll('.statep .card .pv')].filter((e) => { const c = e.getBoundingClientRect(); return c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top; }).length;
  });
  ok(under > 0, `${under} card previews lie under the open menu`);
  const covered = await p.evaluate(COVERED);
  ok(!covered.length, `nothing paints over the menu${covered.length ? ': ' + covered.join(', ') : ''}`);
  const stray = await p.evaluate(STRAY_Z);
  ok(!stray.length, `nothing in the transcript or State pane sits above menus${stray.length ? ': ' + stray.join(', ') : ''}`);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
