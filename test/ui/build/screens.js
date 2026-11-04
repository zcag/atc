const { chromium } = require('/home/user/proj/ui-kit/node_modules/playwright-core');
const exe = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const base = process.argv[2] || 'http://127.0.0.1:7303';
const only = process.argv[3] || '';
const OUT = __dirname + '/../../shots/build/';
const ok = (c, m) => console.log(c ? 'ok  ' : 'FAIL', m);
const posts = [];
const stub = (p) => p.route('**/api/**', (r) => {
  if (r.request().method() === 'GET') return r.continue();
  posts.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
  return r.fulfill({ status: 204 });
});
const wait = (p, ms) => p.waitForTimeout(ms);

async function context(b, phone, scheme) {
  const ctx = await b.newContext(phone ? { viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme } : { viewport: { width: 1400, height: 900 }, colorScheme: scheme });
  await ctx.addInitScript(() => { try { localStorage.setItem('atc.notifask', '1'); localStorage.removeItem('atc.nsdraft'); } catch {} });
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  await stub(p);
  return [ctx, p];
}

async function desktop(b) {
  const [ctx, p] = await context(b, false, 'light');
  await p.goto(base + '/');
  await wait(p, 2500);

  if (!only || only === 'new') {
    await p.keyboard.press('+');
    await wait(p, 900);
    ok(await p.isVisible('.nsdlg'), 'new session: + opens the sheet');
    ok(await p.evaluate(() => document.activeElement?.id === 'ns-prompt'), 'new session: the prompt has focus');
    ok(await p.locator('.nsfl .fo').count() > 0, 'new session: folders listed');
    await p.keyboard.type('Make the page tabs reachable by keyboard');
    await p.locator('#ns-folder').click();
    await p.keyboard.type('atc');
    await wait(p, 200);
    const first = await p.locator('.nsfl .fo').first().innerText();
    ok(/atc/.test(first), `new session: "atc" ranks ${first.split('\n')[0]} first`);
    await p.screenshot({ path: `${OUT}s7-new-search-1400-light.png` });
    await p.keyboard.press('Enter');
    await wait(p, 200);
    ok(/atc/.test(await p.locator('label[for=ns-folder] span').innerText()), 'new session: enter picks the folder');
    await p.screenshot({ path: `${OUT}s7-new-1400-light.png` });
    await p.keyboard.press('Escape');
    await wait(p, 200);
    ok(!(await p.isVisible('.nsdlg')), 'new session: esc closes');
    await p.keyboard.press('+');
    await wait(p, 600);
    ok(/page tabs/.test(await p.inputValue('#ns-prompt')), 'new session: the draft survives a close');
    posts.length = 0;
    await p.locator('#ns-prompt').focus();
    await p.keyboard.press('Enter');
    await wait(p, 600);
    ok(posts.some((x) => x.startsWith('POST /api/sessions')), `new session: enter starts (${posts.join(', ')})`);
    if (await p.isVisible('.nsdlg')) await p.keyboard.press('Escape');
    await p.evaluate(() => localStorage.removeItem('atc.nsdraft'));
  }

  if (!only || only === 'palette') {
    await p.goto(base + '/');
    await wait(p, 2000);
    await p.keyboard.press('/');
    await wait(p, 600);
    ok(await p.isVisible('.pal'), 'palette: / opens it');
    ok(await p.locator('.pal-g').count() > 0, 'palette: groups when empty');
    await p.screenshot({ path: `${OUT}s7-palette-1400-light.png` });
    await p.keyboard.type('usa');
    await wait(p, 300);
    ok(/Usage/.test(await p.locator('.pal-o.on').innerText()), 'palette: "usa" puts Usage on top');
    await p.screenshot({ path: `${OUT}s7-palette-query-1400-light.png` });
    await p.keyboard.press('Enter');
    await wait(p, 800);
    ok(await p.evaluate(() => location.hash === '#/usage'), 'palette: enter runs it');
    await p.keyboard.press('/');
    await wait(p, 400);
    await p.keyboard.type('1');
    await wait(p, 300);
    ok(await p.locator('.pal-g b').first().innerText() === 'Bay', 'palette: 1 alone is bay 1');
    await p.keyboard.press('Escape');
    await p.keyboard.press('/');
    await wait(p, 400);
    for (let i = 0; i < 8 && !(await p.locator('.pal-o.on .sb').count()); i++) await p.keyboard.press('ArrowDown');
    const ses = p.locator('.pal-o.on .sb');
    if (await ses.count()) {
      await p.keyboard.press('Tab');
      await wait(p, 700);
      ok(await p.isVisible('.pal') && await p.isVisible('.pal-scrim.previewing') && await p.evaluate(() => location.hash.startsWith('#/s/')), 'palette: tab previews the session behind it');
      ok(true, 'palette: previewing ' + await p.evaluate(() => location.hash));
      await p.keyboard.press('Escape');
      await wait(p, 500);
      ok(await p.evaluate(() => location.hash === '#/usage'), 'palette: esc after a preview goes back where you were');
    } else await p.keyboard.press('Escape');
    ok(!(await p.isVisible('.pal')), 'palette: esc closes');
  }

  if (!only || only === 'usage') {
    await p.goto(base + '/#/usage');
    await wait(p, 3500);
    ok(await p.isVisible('.scrpane.usage'), 'usage: inside the shell');
    ok(await p.isVisible('.bays .views .kb.on >> text=Usage'), 'usage: the bay bar shows Usage as a fourth view');
    ok(await p.locator('.lim').count() > 0, 'usage: limits drawn');
    ok(await p.locator('.hm i').count() >= 24, 'usage: hour map drawn');
    await p.screenshot({ path: `${OUT}s7-usage-1400-light.png` });
    await p.locator('.lim .pct .x').first().hover();
    await wait(p, 200);
    ok(await p.isVisible('.xp'), 'usage: a number explains itself');
    await p.mouse.move(5, 500);
    const bay = p.locator('tr.pick').first();
    if (await bay.count()) { await bay.click(); await wait(p, 200); ok(await p.locator('.tools .btn').count() === 1, 'usage: a bay filters sessions'); }
  }

  if (!only || only === 'backlog') {
    await p.goto(base + '/#/backlog');
    await wait(p, 2500);
    ok(await p.isVisible('.backlogv'), 'backlog: inside the shell');
    ok(await p.isVisible('.bays .views .kb.on >> text=Backlog'), 'backlog: Backlog as the fourth view');
    const all = p.locator('.backlogv .hd .kb', { hasText: 'All bays' });
    if (await all.count()) await all.click();
    await p.locator('.bk-bar .seg button', { hasText: 'All' }).last().click();
    await wait(p, 300);
    const n = await p.locator('.bk-it').count();
    ok(true, `backlog: ${n} rows`);
    if (n > 1) {
      await p.locator('#bk-add').focus();
      await p.keyboard.press('Escape');
      await p.keyboard.press('j');
      await wait(p, 150);
      ok(await p.locator('.bk-it.sel').count() === 1, 'backlog: j moves the selection');
    }
    await p.screenshot({ path: `${OUT}s7-backlog-1400-light.png` });
  }

  if (!only || only === 'agents') {
    await p.goto(base + '/#/agents');
    await wait(p, 2500);
    ok(await p.isVisible('.agentsv'), 'agents: inside the shell');
    ok(await p.locator('.ar').count() > 0, 'agents: listed');
    ok(await p.isVisible('.agd .hd h1'), 'agents: the chosen agent beside the list');
    await p.keyboard.press('j');
    await wait(p, 300);
    ok(/#\/agents\//.test(await p.evaluate(() => location.hash)), 'agents: j moves to the next agent');
    await p.screenshot({ path: `${OUT}s7-agents-1400-light.png` });
  }
  ok(!p.errs.length, 'desktop: no page errors ' + p.errs.join(' | '));
  await ctx.close();
}

async function shots(b) {
  for (const scheme of ['light', 'dark']) {
    for (const phone of [false, true]) {
      const w = phone ? 400 : 1400;
      const [ctx, p] = await context(b, phone, scheme);
      const shot = (n) => p.screenshot({ path: `${OUT}s7-${n}-${w}-${scheme}.png` });
      await p.goto(base + '/');
      await wait(p, 2200);
      await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })));
      await wait(p, 900);
      if (!(await p.isVisible('.nsdlg'))) { await p.locator('.tabbar button', { hasText: 'Board' }).tap().catch(() => {}); }
      await shot('new');
      await p.keyboard.press('Escape');
      await p.goto(base + '/#/usage'); await wait(p, 3500); await shot('usage');
      await p.goto(base + '/#/backlog'); await wait(p, 2000); await shot('backlog');
      await p.goto(base + '/#/agents'); await wait(p, 2000); await shot('agents');
      if (phone) { await p.locator('.ar').first().tap(); await wait(p, 600); await shot('agent'); }
      await p.goto(base + '/'); await wait(p, 2000);
      if (phone) await p.locator('.tabbar button', { hasText: 'Go' }).tap();
      else await p.keyboard.press('/');
      await wait(p, 800);
      await shot('palette');
      ok(!p.errs.length, `${w} ${scheme}: no page errors ${p.errs.join(' | ')}`);
      await ctx.close();
    }
  }
}

(async () => {
  const b = await chromium.launch({ executablePath: exe });
  if (only !== 'shots') await desktop(b);
  if (!only || only === 'shots') await shots(b);
  await b.close();
})();
