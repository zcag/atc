const { chromium } = require('/home/user/proj/ui-kit/node_modules/playwright-core');
const { fakeSessions, needsIn } = require('./fake.js');
const exe = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = __dirname + '/../../shots/build/';
const ok = (c, m) => console.log(c ? 'ok  ' : 'FAIL', m);
const stub = (p) => p.route(/\/api\/(?!events)/, (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204 }));
const OLD = new Date(Date.now() - 30 * 86400000).toISOString();
const fake = (list) => {
  needsIn(list, 0, ['pinbay', 'pinbay', 'pinbay']);
  const mine = list.filter((s) => s.cwd.endsWith('/pinbay'));
  Object.assign(mine[0], { title: 'pinned-stopped', state: 'stopped', asks: [], pinned: true, updated: OLD, startedAt: OLD });
  Object.assign(mine[1], { title: 'pinned-turn', state: 'your-turn', asks: [], pinned: true });
  Object.assign(mine[2], { title: 'asking', pinned: false });
  return list;
};
(async () => {
  const b = await chromium.launch({ executablePath: exe });
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    await ctx.addInitScript(() => { try { localStorage.setItem('atc.notifask', '1'); } catch {} });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await stub(p);
    const list = await fakeSessions(p, base, fake);
    await p.goto(base + '/');
    await p.waitForTimeout(2500);
    await p.locator('.bay[data-bay=pinbay] .bn').click();
    await p.waitForTimeout(800);
    if (await p.locator('.bview').count() === 0) { await p.keyboard.press('b'); await p.waitForTimeout(500); }
    const pinned = await p.locator('.bgrp.pinned .brow .t').allInnerTexts();
    ok(pinned.join() === 'pinned-stopped,pinned-turn', `${scheme}: Pinned leads, whatever the state, stopped too: ${pinned}`);
    ok((await p.locator('.bgrp').first().getAttribute('class')).includes('pinned'), `${scheme}: Pinned is the first group`);
    ok((await p.locator('.bgrp.waiting .brow .t').allInnerTexts()).join() === 'asking', `${scheme}: a pinned row is not repeated in Waiting`);
    ok(/2 waiting on you/.test(await p.locator('.b2').innerText()), `${scheme}: the count includes a pinned session waiting on you`);
    ok(await p.locator('.bwrap.pinned.waiting').count() === 1, `${scheme}: a pinned session waiting keeps its edge`);
    const c = await p.locator('.bay[data-bay=pinbay] .cn.n').evaluate((e) => { const s = getComputedStyle(e); return s.color !== getComputedStyle(e.closest('.bay').querySelector('.bn .n')).color; });
    ok(c, `${scheme}: the count does not take the bay name's ink`);
    await p.screenshot({ path: `${OUT}pins-board-1400-${scheme}.png` });
    const real = list.find((s) => s.attachable && s.state !== 'past' && !s.cwd.endsWith('/pinbay')) || list[0];
    await p.goto(`${base}/#/s/${real.sessionId}`);
    await p.waitForTimeout(2000);
    const tops = await p.locator('.hd .l1 .r button.kb:visible').evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().top)));
    ok(tops.length > 1 && new Set(tops).size === 1, `${scheme}: header buttons line up: ${tops}`);
    ok(await p.locator('.hd .kb.pin').count() === 1, `${scheme}: the header has a pin toggle`);
    for (const [w, h] of [[1400, 900], [400, 800]]) {
      await p.setViewportSize({ width: w, height: h });
      await p.waitForTimeout(300);
      await p.locator('.hd .more > div > button').click();
      await p.waitForTimeout(200);
      const m = await p.locator('.hd .more .sheet').evaluate((s) => { const r = s.getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= innerWidth, over: [...s.querySelectorAll('.btn')].filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent) }; });
      ok(m.fits && !m.over.length, `${scheme} ${w}: the More menu fits, nothing overflows ${m.over}`);
      await p.screenshot({ path: `${OUT}pins-more-${w}-${scheme}.png` });
      await p.locator('.hd .more > div > button').click();
    }
    ok(!errs.length, `${scheme}: no page errors ${errs}`);
    await ctx.close();
  }
  await b.close();
})();
