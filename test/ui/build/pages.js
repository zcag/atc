// The Pages view against fake sessions and pages in two bays: the gallery inside the shell, a page beside the index,
// j k [ 0 \ and Copy link, the page alone, Changes on an updated page, and the phone's gallery and full-screen page.
// Every write to /api is stubbed.
const { chromium } = require('playwright-core');
const exe = process.env.CHROME_BIN;
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = __dirname + '/../../shots/build/';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const hash = (p) => p.evaluate(() => decodeURIComponent(location.hash));

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const ses = (n, bay, title) => ({ id: `${n}0000000`, sessionId: `${n}0000000-0000-0000-0000-000000000000`, title, cwd: `/home/you/code/${bay}`, state: 'your-turn', attachable: true, updated: ago(5), startedAt: ago(90) });
const A = ses('a', 'app', 'Checkout errors'), B = ses('b', 'app', 'Release notes'), D = ses('d', 'docs', 'Docs site');
const page = (s, name, title, min) => ({ session: s.sessionId, name, title, kind: 'html', path: `${s.cwd}/${name}.html`, url: `/fakepage/${name}.html`, shown: ago(min), updated: ago(min), of: s.title, cwd: s.cwd });
const PAGES = [page(A, 'errors', 'Error report', 3), page(B, 'notes', 'Release notes draft', 20), page(A, 'timeline', 'Deploy timeline', 60), page(D, 'nav', 'Docs navigation', 30)];
const SESSIONS = [A, B, D].map((s) => ({ ...s, shown: PAGES.filter((p) => p.session === s.sessionId) }));
const inApp = PAGES.filter((p) => p.cwd.endsWith('/app'));

async function open(b, opts) {
  const ctx = await b.newContext(opts);
  await ctx.addInitScript(() => { try { localStorage.setItem('atc.notifask', '1'); sessionStorage.setItem('atc.setup.skip', '1'); } catch {} });
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  await p.route('**/api/**', (r) => {
    const u = new URL(r.request().url()).pathname;
    if (r.request().method() !== 'GET') return r.fulfill({ status: 204 });
    if (u === '/api/events') return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: `event: sessions\ndata: ${JSON.stringify(SESSIONS)}\n\n` });
    if (u === '/api/sessions') return r.fulfill({ json: SESSIONS });
    if (u === '/api/pages') return r.fulfill({ json: PAGES });
    if (u === '/api/pins' || u === '/api/history') return r.fulfill({ json: [] });
    if (/^\/api\/sessions\/[^/]+\/turns/.test(u)) return r.fulfill({ json: { turns: [] } });
    return r.continue();
  });
  await p.route('**/fakepage/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="margin:0;background:#def"><h1>${new URL(r.request().url()).pathname}</h1>` }));
  return [ctx, p];
}

(async () => {
  const b = await chromium.launch({ executablePath: exe });
  for (const scheme of ['light', 'dark']) {
    const [ctx, p] = await open(b, { viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    await p.goto(`${base}/#/pages`);
    await p.waitForSelector('.pggal .pcard');
    ok((await hash(p)).startsWith('#/g/'), `${scheme}: #/pages lands on #/g/<bay>`);
    ok(await p.isVisible('.pggal') && await p.isVisible('.bays'), `${scheme}: Pages sits inside the shell, under the bay bar`);
    ok(await p.locator('.views [aria-pressed="true"]', { hasText: 'Pages' }).count() === 1, `${scheme}: the view switch marks Pages`);
    await p.goto(`${base}/#/g/app`);
    await p.waitForTimeout(800);
    const cards = await p.locator('.pggal .pcard').count();
    ok(cards === inApp.length, `${scheme}: the gallery shows the bay's ${inApp.length} pages (${cards})`);
    ok(/Error report/.test(await p.locator('.pggal .pcard').first().innerText()), `${scheme}: newest first`);
    await p.screenshot({ path: `${OUT}pages-1400-${scheme}.png` });
    await p.locator('.pggal .pcard .cap').first().click();
    await p.waitForSelector('.pghd h1');
    ok((await p.locator('.pghd h1').innerText()) === 'Error report' && await p.locator('.pgread .pgbody2 > *').count() > 0, `${scheme}: a card opens the page`);
    ok(await p.locator('.pgidx .pgi').count() === inApp.length, `${scheme}: the index beside it lists the bay's pages`);
    ok(await p.locator('.pgidx img, .pgidx iframe').count() === 0, `${scheme}: no thumbnails in the index`);
    await p.keyboard.press('j');
    await p.waitForTimeout(400);
    const h1 = await hash(p);
    ok(h1.endsWith('/notes'), `${scheme}: j opens the next page (${h1})`);
    ok(await p.locator('.pgi.sel').getAttribute('data-pk') === `${B.sessionId}/notes`, `${scheme}: the open page is marked in the index`);
    await p.keyboard.press('k');
    await p.waitForTimeout(300);
    ok((await hash(p)).endsWith('/errors'), `${scheme}: k goes back up`);
    await p.keyboard.press('[');
    await p.waitForTimeout(200);
    ok(!(await p.isVisible('.pgidx')), `${scheme}: [ hides the index`);
    await p.keyboard.press('[');
    await p.waitForTimeout(200);
    ok(await p.isVisible('.pgidx'), `${scheme}: [ brings it back`);
    await p.keyboard.press('0');
    await p.waitForTimeout(600);
    ok((await hash(p)).startsWith('#/g/all'), `${scheme}: 0 shows every bay`);
    ok(await p.locator('.pgidx .grp').count() > 1, `${scheme}: grouped by bay`);
    await p.screenshot({ path: `${OUT}pages-all-1400-${scheme}.png` });
    await p.keyboard.press('0');
    await p.waitForTimeout(600);
    ok((await hash(p)).startsWith('#/g/app'), `${scheme}: 0 again returns to the bay`);
    await p.locator('.pghd .kb', { hasText: 'Copy link' }).click();
    await p.waitForTimeout(200);
    ok(await p.locator('.toast', { hasText: 'Link copied' }).count() === 1, `${scheme}: Copy link says so`);
    await p.keyboard.press('Backslash');
    await p.waitForTimeout(1500);
    const ho = await hash(p);
    ok(ho.startsWith(`#/s/${A.id}`) && ho.includes('/p/errors') && await p.isVisible('.ppane .pbar'), `${scheme}: \\ opens the page beside its session (${ho})`);
    await p.locator('.pbar [aria-label="Open in Pages"]').click();
    await p.waitForTimeout(800);
    ok((await hash(p)).startsWith('#/g/app'), `${scheme}: Open in Pages returns to the Pages view`);
    await p.goto(`${base}/#/p/${A.sessionId}/errors`);
    await p.waitForTimeout(1500);
    ok(await p.isVisible('.palone .ppane .pbar'), `${scheme}: #/p/<session>/<name> still opens the page alone`);
    await p.screenshot({ path: `${OUT}pages-alone-1400-${scheme}.png` });
    const at = Date.parse(PAGES[0].updated);
    await p.evaluate(([k, t]) => { const m = JSON.parse(localStorage.getItem('atc.pages.seen') || '{}'); m[k] = t; localStorage.setItem('atc.pages.seen', JSON.stringify(m)); }, [`${A.sessionId}/errors`, at - 600000]);
    await p.goto(`${base}/#/g/all/${A.sessionId}/errors`);
    await p.reload();
    await p.waitForSelector('.pghd h1');
    await p.waitForTimeout(500);
    const changes = p.locator('.pghd .kb', { hasText: 'Changes' });
    ok(await changes.count() === 1 && /updated .*, seen /.test(await p.locator('.pghd .l2').textContent()), `${scheme}: an updated page offers Changes and says when it was seen`);
    await p.keyboard.press('d');
    await p.waitForTimeout(200);
    ok(await changes.getAttribute('aria-pressed') === 'false', `${scheme}: d turns the change marks off`);
    await p.screenshot({ path: `${OUT}pages-updated-1400-${scheme}.png` });
    ok(!p.errs.length, `${scheme}: no page errors ${p.errs.join(' | ')}`);
    await ctx.close();
  }
  for (const scheme of ['light', 'dark']) {
    const [ph, q] = await open(b, { viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });
    await q.goto(`${base}/#/g/app`);
    await q.waitForSelector('.pggal .pcard');
    ok(!(await q.isVisible('.pgread')), `${scheme} phone: the gallery is the screen`);
    ok(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scheme} phone: nothing wider than the screen`);
    await q.screenshot({ path: `${OUT}pages-400-${scheme}.png` });
    await q.locator('.pggal .pcard .cap').first().tap();
    await q.waitForSelector('.pghd h1');
    await q.waitForTimeout(500);
    ok(await q.isVisible('.pgread') && !(await q.isVisible('.pgidx')), `${scheme} phone: a tap opens the page full screen`);
    ok(await q.isVisible('.pghd .more') && !(await q.isVisible('.pghd .kb.danger')), `${scheme} phone: one Actions button`);
    await q.screenshot({ path: `${OUT}pagefull-400-${scheme}.png` });
    await q.locator('.pghd .more button').first().tap();
    await q.waitForTimeout(300);
    await q.screenshot({ path: `${OUT}pageacts-400-${scheme}.png` });
    await q.keyboard.press('Escape');
    await q.waitForTimeout(200);
    await q.locator('.pghd .back').tap();
    await q.waitForTimeout(500);
    ok(await q.isVisible('.pggal .pcard'), `${scheme} phone: Back returns to the gallery`);
    ok(!q.errs.length, `${scheme} phone: no page errors ${q.errs.join(' | ')}`);
    await ph.close();
  }
  await b.close();
  console.log(fails ? `${fails} failed` : 'all ok');
  process.exit(fails ? 1 : 0);
})();
