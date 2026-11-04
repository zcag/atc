// With nothing new, a session opens on its last message, whoever wrote it, not on the prompt that started that turn.
const { chromium } = require('/home/user/proj/ui-kit/node_modules/playwright-core');
const exe = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const base = process.argv[2] || 'http://127.0.0.1:7299';
const ok = (c, m) => console.log(c ? 'ok  ' : 'FAIL', m);
const LOOK = () => {
  const el = document.querySelector('.tx');
  const all = [...el.querySelectorAll('[data-you], [data-said]')], last = all[all.length - 1];
  const v = el.getBoundingClientRect();
  return { since: !!el.querySelector('#since'), kind: last?.hasAttribute('data-said') ? 'reply' : 'you', y: last ? Math.round(last.getBoundingClientRect().top - v.top) : null,
    view: el.clientHeight, top: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight };
};
(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const live = await (await fetch(base + '/api/sessions')).json();
  const hist = await (await fetch(base + '/api/history?limit=30')).json();
  const list = [...live.filter((s) => s.state === 'your-turn' || s.state === 'stopped'), ...hist].filter((s, i, a) => a.findIndex((x) => x.sessionId === s.sessionId) === i).slice(0, 8);
  for (const [name, vp] of [['desktop', { width: 1400, height: 900 }], ['phone', { width: 400, height: 800 }]]) {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    const seen = Object.fromEntries(list.map((s) => [s.sessionId, new Date().toISOString()]));
    await p.route(/\/api\//, (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204 }));
    await p.route('**/api/seen', (r) => r.request().method() === 'GET' ? r.fulfill({ json: seen }) : r.fulfill({ status: 204 }));
    let replies = 0;
    for (const s of list) {
      await p.goto(`${base}/#/s/${s.sessionId}`);
      await p.waitForTimeout(2000);
      if (!(await p.$('.tx [data-you], .tx [data-said]'))) continue;
      const w = await p.evaluate(LOOK);
      if (w.since) continue;
      if (w.kind === 'reply') replies++;
      const placed = (w.y >= 0 && w.y <= 40) || (w.top >= w.max - 1 && w.y >= 0 && w.y < w.view);
      ok(placed, `${name}: ${(s.title || s.sessionId).slice(0, 28)} opens on its last message, ${w.kind}, ${w.y}px down, ${w.max - w.top}px below`);
    }
    ok(replies > 0, `${name}: at least one session ended on a reply (${replies})`);
    await ctx.close();
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
