// The phone half of step 8: what the web hands the Android app for its widget (APP.setSessions) and its palette
// (APP.setLook). Writes both to /tmp/atc-phone-{feed,look}.json, which the redroid check feeds to the app.
const { chromium } = require('playwright-core');
const { fakeSessions, needsIn } = require('./fake.js');
const fs = require('fs');
const exe = process.env.CHROME_BIN;
const base = process.argv[2] || 'http://127.0.0.1:7299';
const ok = (c, m) => console.log(c ? 'ok  ' : 'FAIL', m);
const fake = (list) => {
  needsIn(list, 1, ['Storefront']);
  const p = list.find((s) => s.title === 'Storefront session');
  Object.assign(p, { title: '#101 Checkout: missing tax lines', asks: [{ id: 'claude', key: 'f00dfeed0001', permission: 'Bash', patterns: ['bundle exec rspec spec/models/invoice_spec.rb'] }] });
  for (const s of list) if (s.asks) s.asks.forEach((a, i) => { a.key = a.key || `k${i}${s.sessionId.slice(0, 6)}`; });
  return list;
};
(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const ctx = await b.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('atc.notifask', '1'); } catch {}
    window.__feeds = [];
    window.AtcApp = {
      setLook: (j) => { window.__look = j; }, setSessions: (j) => { window.__feeds.push(j); },
      version: () => 999, versionName: () => 'test', pushStatus: () => 'ok', shared: () => '', clearShared: () => {}, setTargets: () => {},
      openExternal: () => {}, checkUpdate: () => {}, keepScreenOn: () => {}, speak: () => {}, stopSpeaking: () => {},
    };
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/\/api\/(?!events)/, (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204 }));
  await fakeSessions(p, base, fake);
  await p.goto(base + '/');
  await p.waitForTimeout(3500);
  const raw = await p.evaluate(() => window.__feeds.at(-1));
  const look = await p.evaluate(() => window.__look);
  const feed = JSON.parse(raw || '{}');
  const needs = (feed.sessions || []).filter((s) => s.state === 'needs-you');
  const q = needs.find((s) => s.ask?.options);
  const perm = needs.find((s) => s.ask?.tool);
  ok(feed.type === 'sessions' && needs.length >= 2, `the feed carries the waiting sessions (${needs.length})`);
  ok(q && q.ask.text && q.ask.options.join('|') === 'Keep both|Normalise to cents' && q.ask.sid === q.sid && q.ask.id === 'a1' && q.ask.key, 'a question comes with its options, ids and key');
  ok(perm && perm.ask.tool === 'Bash' && perm.ask.cmd.startsWith('bundle exec rspec') && !perm.ask.options && perm.bay === 'Storefront', 'a permission comes with its tool, command and bay');
  ok((feed.sessions || []).some((s) => s.summary), 'finished sessions carry the summary status');
  ok(look && JSON.parse(look).palettes?.atc?.dark?.needs, 'the palette is handed over');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  fs.writeFileSync('/tmp/atc-phone-feed.json', raw || '');
  fs.writeFileSync('/tmp/atc-phone-look.json', look || '');
  await b.close();
})();
