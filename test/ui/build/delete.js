// Deleting a session asks once (Enter confirms, Esc keeps it), then deletes it at once with no toast;
// a private session keeps its Erase dialog and gets no hover x.
const { chromium } = require('playwright-core');
const { fakeSessions } = require('./fake');
const exe = process.env.CHROME_BIN;
const base = process.argv[2] || 'http://127.0.0.1:7299';
const out = process.env.SHOTS || '/tmp/atc-delete';
const ok = (c, m) => console.log(c ? 'ok  ' : 'FAIL', m);
require('fs').mkdirSync(out, { recursive: true });

const mk = (t, i, extra = {}) => Object.assign(JSON.parse(JSON.stringify(t)), {
  sessionId: `del${i}-0000-0000-0000-000000000000`, id: `del${i}`, title: `Sample session ${i}`, cwd: '/home/you/code/sample',
  state: 'your-turn', parked: false, pinned: false, private: false, asks: [], agent: '', kind: 'background', updated: new Date(Date.now() - i * 60000).toISOString(), ...extra,
});

(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const run = async (w, h, scheme) => {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: w < 900 });
    const p = await ctx.newPage();
    const dels = [], patches = [];
    await p.route(/\/api\//, (r) => {
      const q = r.request();
      if (q.method() === 'DELETE') dels.push(new URL(q.url()).pathname);
      if (q.method() === 'PATCH') patches.push(q.postDataJSON());
      return q.method() === 'GET' ? r.continue() : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await fakeSessions(p, base, (l) => {
      const t = l.find((s) => s.kind === 'background') || l[0];
      return [mk(t, 1), mk(t, 2), mk(t, 3, { state: 'needs-you', pinned: true }), mk(t, 4, { private: true, title: 'Private sample' }), mk(t, 5), mk(t, 6)];
    });
    await p.addInitScript((sc) => { try { localStorage.setItem('atc.notifask', '1'); localStorage.removeItem('atc.project'); } catch {} document.documentElement.dataset.scheme = sc; }, scheme);
    await p.goto(`${base}/#/`);
    await p.waitForSelector('[data-sid^="del1"]');
    await p.evaluate((sc) => (document.documentElement.dataset.scheme = sc), scheme);
    await p.waitForTimeout(500);
    const tag = `${w}-${scheme}`;
    const row = (i) => p.$(`[data-sid^="del${i}"]`);
    const confirmDel = async () => { await p.waitForSelector('.dlgveil'); await p.keyboard.press('Enter'); await p.waitForSelector('.dlgveil', { state: 'detached' }); await p.waitForTimeout(150); };
    if (w >= 900) {
      ok(!(await p.$('.rdel:visible')), `${tag}: no x on a calm list`);
      await p.hover('[data-sid^="del1"]');
      ok(!!(await p.$('.bwrap:hover > .rx > .rdel:visible, .rr:hover > .rx > .rdel:visible')), `${tag}: hover shows the x`);
      await p.screenshot({ path: `${out}/board-hover-${tag}.png` });
      await p.click('.bwrap:hover > .rx > .rpin');
      ok(patches.at(-1)?.pinned === true, `${tag}: the pin beside the x pins it`);
      await p.hover('[data-sid^="del3"]');
      ok(await p.$eval('.bwrap:hover > .rx > .rpin', (e) => e.classList.contains('on') && e.title === 'Unpin'), `${tag}: a pinned row's pin unpins`);
      await p.hover('.bays .bay[data-bay="sample"] .n');
      await p.waitForSelector('.peek .pk');
      await p.hover('.peek .pk:has([href*="del3"])');
      ok(!!(await p.$('.pk:hover > .rx > .rpin:visible')) && !!(await p.$('.pk:hover > .rx > .rdel:visible')), `${tag}: a peek row shows pin and x on hover`);
      await p.screenshot({ path: `${out}/peek-hover-${tag}.png` });
      await p.click('.pk:hover > .rx > .rpin');
      ok(patches.at(-1)?.pinned === false, `${tag}: the peek's pin unpins`);
      await p.mouse.move(700, 700);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(200);
      await p.hover('[data-sid^="del1"]');
      await p.hover('[data-sid^="del4"]');
      ok(!(await p.$('.rdel:visible')), `${tag}: no x on a private row`);
      await p.hover('[data-sid^="del1"]');
      await p.click('.bwrap:hover > .rx > .rdel');
      await confirmDel();
      await p.waitForTimeout(200);
      ok(!(await row(1)), `${tag}: the row goes at once`);
      ok(!(await p.$('.toast')), `${tag}: no toast after deleting`);
      ok(dels.length === 1, `${tag}: sent right after confirming`);
      await p.mouse.move(5, 5);
      await p.keyboard.press('j');
      await p.waitForTimeout(100);
      const cur = await p.$eval('.brow.cur', (e) => e.dataset.sid);
      await p.screenshot({ path: `${out}/board-cursor-${tag}.png` });
      await p.keyboard.press('Delete');
      await p.waitForSelector('.dlgveil');
      await p.keyboard.press('Escape');
      await p.waitForSelector('.dlgveil', { state: 'detached' });
      await p.waitForTimeout(150);
      ok(!!(await p.$(`[data-sid="${cur}"]`)) && dels.length === 1, `${tag}: Esc in the confirm keeps it`);
      await p.keyboard.press('Delete');
      await confirmDel();
      await p.waitForTimeout(100);
      ok(!(await p.$(`[data-sid="${cur}"]`)) && dels.length === 2, `${tag}: Delete on the cursor row deletes it`);
      dels.length = 0;
      await p.goto(`${base}/#/s/del5`);
      await p.waitForSelector('.hd h1');
      await p.waitForTimeout(800);
      await p.hover('.rail [data-sid^="del5"]').catch(() => {});
      await p.mouse.move(700, 500);
      await p.screenshot({ path: `${out}/rail-sel-${tag}.png` });
      await p.keyboard.press('Delete');
      await confirmDel();
      await p.waitForTimeout(300);
      ok(!(await p.evaluate(() => location.hash.startsWith('#/s/del5'))) && dels.length === 1, `${tag}: Delete in the session deletes it and leaves`);
      dels.length = 0;
      await p.goto(`${base}/#/s/del6`);
      await p.waitForSelector('.hd h1');
      await p.waitForTimeout(500);
      await p.click('.hd .more > div > button');
      const labels = await p.$$eval('.hd .more .mitem .lb', (l) => l.map((e) => e.textContent));
      ok(labels.includes('Delete') && !labels.includes('Delete…'), `${tag}: More says Delete`);
      await p.screenshot({ path: `${out}/more-${tag}.png` });
      await p.click('.hd .more .mitem.danger');
      await confirmDel();
      await p.waitForTimeout(200);
      ok(!(await p.$('.veil')) && dels.length === 1, `${tag}: More's Delete asks, then deletes`);
      await p.goto(`${base}/#/s/del4`);
      await p.waitForSelector('.hd h1');
      await p.waitForTimeout(500);
      await p.keyboard.press('Delete');
      await p.waitForTimeout(200);
      ok(await p.evaluate(() => location.hash.startsWith('#/s/del4')), `${tag}: Delete does nothing on a private session`);
      await p.click('.hd .more > div > button');
      await p.click('.hd .more .mitem.danger');
      await p.waitForTimeout(300);
      ok(!!(await p.$('.veil')), `${tag}: Erase still asks first`);
    } else {
      ok(!(await p.$('.rdel:visible')), `${tag}: no x on phone`);
      await p.screenshot({ path: `${out}/phone-${tag}.png` });
      const r = await row(2);
      const bx = await r.boundingBox();
      await p.mouse.move(bx.x + 60, bx.y + bx.height / 2);
      await p.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y })); }, [bx.x + 60, bx.y + bx.height / 2]);
      await p.waitForSelector('.msheet');
      const labels = await p.$$eval('.msheet .mitem .lb', (l) => l.map((e) => e.textContent));
      ok(labels.includes('Delete'), `${tag}: the sheet has Delete`);
      await p.screenshot({ path: `${out}/phone-sheet-${tag}.png` });
      await p.click('.msheet .mitem.danger');
      await confirmDel();
      await p.waitForTimeout(200);
      ok(!(await row(2)) && !(await p.$('.veil:not(.mveil)')) && dels.length === 1, `${tag}: Delete from the sheet asks, then deletes it`);
      await p.screenshot({ path: `${out}/phone-toast-${tag}.png` });
    }
    await ctx.close();
  };
  for (const sc of ['light', 'dark']) {
    await run(1440, 900, sc);
    await run(620, 1300, sc);
    await run(400, 860, sc);
  }
  await b.close();
})();
