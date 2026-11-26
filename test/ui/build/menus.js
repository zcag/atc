// A session's More menu is on top of everything under it, the State pane's output rows included (its rounded corners aside).
const { chromium } = require('playwright-core');
const exe = process.env.CHROME_BIN;
const base = process.argv[2] || 'http://127.0.0.1:7299';
const ok = (c, m) => console.log(c ? 'ok  ' : 'FAIL', m);
const COVERED = () => {
  const sheet = document.querySelector('.hd .more .menu'), r = sheet.getBoundingClientRect(), over = new Set();
  for (let y = r.top + 6; y < Math.min(r.bottom - 6, innerHeight); y += 8) for (let x = r.left + 6; x < r.right - 6; x += 8) {
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
  if (!(await p.$('.statep'))) await p.click('.hd .ptog[aria-keyshortcuts="Backslash"], .hd .ptog >> nth=-1');
  await p.waitForSelector('.statep .orow');
  await p.waitForTimeout(1000);
  ok(!(await p.$('.statep .peek, .tx .peek')), 'the bay peek popover class is not used inside a session');
  await p.$eval('.statep .outs', (c) => c.scrollIntoView({ block: 'start' }));
  await p.click('.hd .more > div > button');
  await p.waitForSelector('.hd .more .menu');
  const under = await p.evaluate(() => {
    const r = document.querySelector('.hd .more .menu').getBoundingClientRect();
    return [...document.querySelectorAll('.statep .orow')].filter((e) => { const c = e.getBoundingClientRect(); return c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top; }).length;
  });
  ok(under > 0, `${under} output rows lie under the open menu`);
  const covered = await p.evaluate(COVERED);
  ok(!covered.length, `nothing paints over the menu${covered.length ? ': ' + covered.join(', ') : ''}`);
  const stray = await p.evaluate(STRAY_Z);
  ok(!stray.length, `nothing in the transcript or State pane sits above menus${stray.length ? ': ' + stray.join(', ') : ''}`);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
