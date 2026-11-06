// Zen on a page: drives the real app against a fake session with one page. Every write to /api is stubbed.
// node pagezen.js [base] [token]
const fs = require('fs');
const { chromium } = require('playwright-core');
const exe = process.env.CHROME_BIN;
const base = process.argv[2] || 'http://127.0.0.1:7299';
const token = process.argv[3] || '';
const OUT = __dirname + '/../../shots/build/';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const zenKeys = /const zenKeysScript = `(.*)`/.exec(fs.readFileSync(__dirname + '/../../../internal/server/outputs.go', 'utf8'))[1];
const sid = 'fa4e0000-0000-0000-0000-000000000000';
const at = new Date().toISOString();
const session = {
  id: 'fa4e0000', sessionId: sid, title: 'A session with a page', cwd: '/home/you/code/app', state: 'your-turn', attachable: true, updated: at, startedAt: at,
  shown: [{ session: sid, name: 'report', title: 'A report', kind: 'html', path: '/home/you/code/app/report.html', url: '/fakepage/report.html', shown: at, updated: at, note: 'A note' }],
};

async function open(b, opts, split) {
  const ctx = await b.newContext(opts);
  await ctx.addInitScript((s) => { try { localStorage.setItem('atc.notifask', '1'); localStorage.setItem('atc.pages.split', s); } catch {} }, JSON.stringify(split));
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  await p.route('**/api/**', (r) => {
    const u = new URL(r.request().url()).pathname;
    if (r.request().method() !== 'GET') return r.fulfill({ status: 204 });
    if (u === '/api/events') return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: `event: sessions\ndata: ${JSON.stringify([session])}\n\n` });
    if (u === '/api/sessions') return r.fulfill({ json: [session] });
    if (u.startsWith(`/api/sessions/${sid}/turns`)) return r.fulfill({ json: { turns: [] } });
    return r.continue();
  });
  await p.route('**/fakepage/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>r</title><body style="margin:0;background:#def"><h1>A page</h1>${zenKeys}` }));
  if (token) await p.goto(`${base}/?token=${token}`);
  await p.goto(`${base}/#/s/${sid}/p/report`);
  await p.waitForSelector('.ppane iframe', { state: 'attached', timeout: 15000 });
  await p.waitForTimeout(800);
  return [ctx, p];
}
const frameBox = (p) => p.locator('.ppane iframe').first().boundingBox();
const inner = (p) => p.frameLocator('.ppane iframe').first().locator('h1');
const zenOn = (p) => p.evaluate(() => document.body.classList.contains('pagezen'));
const txZen = (p) => p.evaluate(() => document.body.classList.contains('zen'));

(async () => {
  const b = await chromium.launch({ executablePath: exe });
  for (const scheme of ['light', 'dark']) {
    const W = 1400, H = 900;
    let [ctx, p] = await open(b, { viewport: { width: W, height: H }, colorScheme: scheme }, true);
    const before = await frameBox(p);
    ok(await p.isVisible('.pgsplit .pgchat') && before.x > 300, `${scheme}: page sits beside the transcript`);
    await p.evaluate(() => { window.frameSeen = document.querySelector('.ppane iframe'); });

    await p.keyboard.press('z');
    await p.waitForTimeout(250);
    ok(await txZen(p) && !await zenOn(p), `${scheme}: z with focus outside the page is the transcript's zen`);
    await p.keyboard.press('z');
    await p.waitForTimeout(250);
    ok(!await txZen(p), `${scheme}: z leaves it`);

    await inner(p).click();
    await p.keyboard.press('z');
    await p.waitForTimeout(300);
    const full = await frameBox(p);
    ok(await zenOn(p) && !await txZen(p), `${scheme}: z from inside a plain page is the page's zen`);
    ok(full.x === 0 && full.y === 0 && full.width === W && full.height === H, `${scheme}: the page fills the window (${full.x},${full.y} ${full.width}x${full.height})`);
    ok(await p.evaluate(() => window.frameSeen === document.querySelector('.ppane iframe')), `${scheme}: the page is not reloaded`);
    ok(await p.isVisible('.pzenout'), `${scheme}: Leave zen is on screen`);
    await p.screenshot({ path: `${OUT}pagezen-1400-${scheme}.png` });

    await p.keyboard.press('j');
    await p.waitForTimeout(150);
    ok((await p.evaluate(() => location.hash)).includes('/p/report'), `${scheme}: other keys stay inside zen`);
    await p.keyboard.press('z');
    await p.waitForTimeout(300);
    const back = await frameBox(p);
    ok(!await zenOn(p) && await p.isVisible('.pgchat') && back.x === before.x && back.width === before.width, `${scheme}: z from inside the page brings the split back`);

    await p.locator('.pzen').click();
    await p.waitForTimeout(250);
    ok(await zenOn(p), `${scheme}: Zen on the page's bar`);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    ok(!await zenOn(p) && (await p.evaluate(() => location.hash)).includes('/s/'), `${scheme}: esc from inside the page leaves zen and stays in the session`);

    await p.locator('.pzen').click();
    await p.waitForTimeout(250);
    await p.goBack();
    await p.waitForTimeout(300);
    ok(!await zenOn(p) && await p.isVisible('.pgchat'), `${scheme}: the back button leaves zen`);

    await p.locator('.pzen').click();
    await p.waitForTimeout(250);
    await p.locator('.pzenout').click();
    await p.waitForTimeout(250);
    ok(!await zenOn(p), `${scheme}: Leave zen leaves it`);

    await p.locator('.pgchat').click({ position: { x: 20, y: 200 } });
    await p.keyboard.press('z');
    await p.waitForTimeout(250);
    ok(await txZen(p), `${scheme}: clicking back in the transcript makes z the transcript's again`);
    await p.keyboard.press('z');
    ok(!p.errs.length, `${scheme}: no page errors ${p.errs.join(' | ')}`);
    await ctx.close();

    [ctx, p] = await open(b, { viewport: { width: W, height: H }, colorScheme: scheme }, false);
    ok(!await p.isVisible('.pgchat'), `${scheme}: page only`);
    await p.keyboard.press('z');
    await p.waitForTimeout(300);
    const only = await frameBox(p);
    ok(await zenOn(p) && only.y === 0 && only.height === H, `${scheme}: z on a page alone maximizes it`);
    await p.keyboard.press('z');
    await p.waitForTimeout(250);
    ok(!await zenOn(p) && await p.isVisible('.pbar'), `${scheme}: and z leaves it`);
    ok(!p.errs.length, `${scheme} page only: no page errors ${p.errs.join(' | ')}`);
    await ctx.close();

    for (const w of [400, 620]) {
      [ctx, p] = await open(b, { viewport: { width: w, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme }, true);
      await p.screenshot({ path: `${OUT}pagezen-${w}-before-${scheme}.png` });
      ok(!await p.isVisible('.pzen'), `${scheme} ${w}: no Zen on the page bar, the bar has no room`);
      await p.locator('.hd .more button').first().tap();
      await p.waitForTimeout(200);
      await p.getByRole('menuitem', { name: 'Zen', exact: true }).or(p.locator('.hd .more button', { hasText: /^Zen$/ })).first().tap();
      await p.waitForTimeout(300);
      const f = await frameBox(p);
      ok(await zenOn(p) && f.x === 0 && f.y === 0 && f.width === w && f.height === 860, `${scheme} ${w}: More, Zen fills the screen (${f.width}x${f.height})`);
      const out = await p.locator('.pzenout').boundingBox();
      ok(out && out.height >= 44 && out.x + out.width <= w, `${scheme} ${w}: Leave zen is a real target (${out && out.height}px)`);
      await p.screenshot({ path: `${OUT}pagezen-${w}-${scheme}.png` });
      await p.locator('.pzenout').tap();
      await p.waitForTimeout(250);
      ok(!await zenOn(p) && await p.isVisible('.hd'), `${scheme} ${w}: Leave zen brings the header back`);
      ok(!p.errs.length, `${scheme} ${w}: no page errors ${p.errs.join(' | ')}`);
      await ctx.close();
    }
  }
  await b.close();
  console.log(fails ? `${fails} failed` : 'all ok');
  process.exit(fails ? 1 : 0);
})();
