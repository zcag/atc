// The one ask outside the transcript (compact form): the board row, the peek, terminal mode.
// node asks.js [base]
const { chromium } = require('/home/user/proj/ui-kit/node_modules/playwright-core');
const { fakeSessions, needsIn } = require('./fake.js');
const exe = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = __dirname + '/../../shots/build/';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const PERM = [{ id: 'p1', permission: 'Bash', patterns: ['bundle exec rspec spec/models/invoice_spec.rb'] }];

(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const open = async (scheme, phone, change, init = () => {}) => {
    const ctx = await b.newContext(phone ? { viewport: { width: 400, height: 860 }, colorScheme: scheme, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    await ctx.addInitScript(init);
    const p = await ctx.newPage(), writes = [], errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/\/api\/(?!events)/, async (r) => {
      const q = r.request();
      if (q.method() === 'GET') return r.continue();
      writes.push({ path: new URL(q.url()).pathname, body: q.postData() || '' });
      if (q.url().includes('/asks/')) await new Promise((res) => setTimeout(res, 600));
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const list = await fakeSessions(p, base, change);
    return { ctx, p, writes, errs, list };
  };
  const quiet = () => { try { localStorage.setItem('atc.notifask', '1'); localStorage.removeItem('atc.project'); } catch {} };

  for (const scheme of ['light', 'dark']) {
    {
      const { ctx, p, writes, errs } = await open(scheme, false, (l) => {
        needsIn(l, 2);
        const perm = l.filter((s) => s.state === 'needs-you')[1];
        if (perm) Object.assign(perm, { asks: PERM, activity: 'Bash' });
        return l;
      }, quiet);
      await p.goto(base + '/');
      await p.waitForTimeout(3000);
      const rows = p.locator('.bgrp.waiting .bwrap');
      const n = await rows.count();
      let q = null, perm = null;
      for (let i = 0; i < n && !(q && perm); i++) {
        const t = await rows.nth(i).innerText();
        if (!perm && /Bash|bundle exec/.test(t)) perm = rows.nth(i); else if (!q) q = rows.nth(i);
      }
      await q.locator('.brow').click({ position: { x: 600, y: 10 } });
      await p.waitForTimeout(300);
      const ask = q.locator('.ask.compact');
      ok(await ask.isVisible(), `${scheme}: the opened row carries the ask`);
      ok((await ask.locator('.acts .btn kbd').allTextContents()).slice(0, 2).join() === '1,2', `${scheme}: options are numbered`);
      await p.screenshot({ path: `${OUT}asks-board-1400-${scheme}.png` });
      const hash = await p.evaluate(() => location.hash);
      await ask.locator('.acts .btn').first().focus();
      await p.keyboard.press('1');
      await p.waitForTimeout(150);
      ok(writes.some((w) => w.path.endsWith('/asks/a1') && JSON.parse(w.body).answers?.[0]?.[0] === 'Keep both'), `${scheme}: 1 answers the focused ask (stubbed)`);
      ok(await p.evaluate(() => location.hash) === hash, `${scheme}: 1 inside the ask does not switch bays`);
      ok(!(await ask.locator('.ast .slow').isVisible()), `${scheme}: no "Sending" before 400 ms`);
      await p.waitForTimeout(300);
      ok(await ask.locator('.ast .slow').isVisible(), `${scheme}: "Sending" after 400 ms`);
      await p.waitForTimeout(600);
      ok(/Sent \d\d:\d\d\./.test(await ask.locator('.ast').textContent().catch(() => '')), `${scheme}: Sent`);
      await p.screenshot({ path: `${OUT}asks-board-sent-1400-${scheme}.png` });
      await q.locator('.brow').click({ position: { x: 600, y: 10 } });
      if (perm) {
        await perm.locator('.brow').click({ position: { x: 600, y: 10 } });
        await p.waitForTimeout(300);
        const labels = (await perm.locator('.ask.compact .acts .btn').allTextContents()).map((x) => x.replace(/^\d/, ''));
        ok(labels[0] === 'Allow once' && labels[labels.length - 1] === 'Deny', `${scheme}: a permission reads ${labels.join(', ')}`);
        ok(await perm.locator('.ask.compact .acts .btn').first().evaluate((e) => e.classList.contains('primary')), `${scheme}: Allow once is the primary`);
        await p.screenshot({ path: `${OUT}asks-perm-1400-${scheme}.png` });
      } else ok(false, `${scheme}: no permission row found`);
      ok(!errs.length, `${scheme}: no page errors ${errs.join(' | ')}`);
      await ctx.close();
    }
    {
      let sid;
      const { ctx, p, errs } = await open(scheme, false, (l) => { needsIn(l, 1); sid = l.find((s) => s.state === 'needs-you').sessionId; return l; }, () => { try { localStorage.setItem('atc.notifask', '1'); localStorage.setItem('atc.pane', 'out'); } catch {} });
      await p.goto(`${base}/#/s/${sid}`);
      await p.waitForTimeout(3000);
      ok(await p.isVisible('.askstrip .ask.compact'), `${scheme}: terminal mode shows the ask above the terminal`);
      await p.screenshot({ path: `${OUT}asks-term-1400-${scheme}.png` });
      ok(!errs.length, `${scheme}: no page errors ${errs.join(' | ')}`);
      await ctx.close();
    }
    {
      const { ctx, p, writes, errs } = await open(scheme, true, (l) => needsIn(l, 2, ['shop', 'dotfiles', 'notes']), () => { try { localStorage.setItem('atc.project', 'atc'); } catch {} });
      await p.goto(base + '/');
      await p.waitForTimeout(3000);
      await p.tap('.offneeds');
      await p.waitForTimeout(400);
      ok(await p.isVisible('.peeksheet .ask.rows'), `${scheme} phone: the sheet carries the asks as rows`);
      ok(!(await p.$('.peeksheet #pending-ask')) && !(await p.$('.peeksheet .ask .who2')), `${scheme} phone: no transcript id or header in the sheet`);
      ok((await p.$$eval('.peeksheet .ask kbd', (l) => l.filter((k) => k.offsetParent && getComputedStyle(k).visibility !== 'hidden').length)) === 0, `${scheme} phone: no key hints`);
      ok((await p.$eval('.peeksheet .ask .opt', (e) => e.getBoundingClientRect().height)) >= 44, `${scheme} phone: 44px answers`);
      await p.screenshot({ path: `${OUT}asks-peek-400-${scheme}.png` });
      await p.tap('.peeksheet .ask .opt');
      await p.waitForTimeout(1200);
      ok(writes.some((w) => w.path.includes('/asks/')), `${scheme} phone: a tap answers (stubbed)`);
      ok(await p.isVisible('.peeksheet .ask .ast'), `${scheme} phone: the answer's state shows`);
      ok(!errs.length, `${scheme} phone: no page errors ${errs.join(' | ')}`);
      await ctx.close();
    }
  }
  await b.close();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
