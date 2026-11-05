// A session's call action: Call opens on an agent that can talk, Call about this goes to the assistant from anything else.
// Run on a private instance; all writes are stubbed here.
const { chromium } = require('playwright-core');
const fs = require('fs');
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = process.argv[3] || __dirname + '/../../shots/build/';
const FAKE = fs.readFileSync(__dirname + '/fakecall.js', 'utf8');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };

const run = (over) => ({ id: over.sessionId.slice(0, 8), state: 'your-turn', cwd: '/home/you/code/app', updated: new Date().toISOString(), startedAt: new Date().toISOString(), ...over });
const FOCUS = run({ sessionId: 'f0c05000-0000-0000-0000-000000000000', title: 'Focus', agent: 'focus' });
const QUIET = run({ sessionId: 'a9e17000-0000-0000-0000-000000000000', title: 'Quiet', agent: 'quiet' });
const BROKEN = run({ sessionId: 'b40ce000-0000-0000-0000-000000000000', title: 'Broken', agent: 'broken' });
const PLAIN = run({ sessionId: 'c0de0000-0000-0000-0000-000000000000', title: 'Plain session' });
const AGENTS = [{ name: 'focus', title: 'Focus', talk: true }, { name: 'quiet', title: 'Quiet' }, { name: 'broken', title: 'Broken', talk: true, error: 'no such folder' }];
const json = (r, v) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });

async function open(b, { width = 1400, scheme = 'light', app = false } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: 860 }, colorScheme: scheme, isMobile: width < 900, hasTouch: width < 900 });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('atc.setup.skip', '1'); localStorage.setItem('atc.notifask', '1'); } catch {} });
  if (app) await ctx.addInitScript(() => { window.__native = 0; window.AtcApp = { call: () => { window.__native++; }, openExternal() {}, setSessions() {} }; });
  const list = [FOCUS, QUIET, BROKEN, PLAIN];
  const posts = [];
  await ctx.route(/\/api\//, (r) => {
    const req = r.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') { if (path.startsWith('/api/call/')) posts.push([path, req.postDataJSON()]); return json(r, {}); }
    if (path === '/api/events') return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: `event: sessions\ndata: ${JSON.stringify(list)}\n\n` });
    if (path === '/api/sessions') return json(r, list);
    if (path === '/api/agents') return json(r, AGENTS);
    if (path === '/api/me') return r.fetch().then((x) => (x.ok() ? x.json().then((me) => json(r, { ...me, call: true })) : r.fulfill({ response: x })));
    return r.continue();
  });
  await ctx.route('**/call.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE }));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  if (process.env.ATC_TEST_TOKEN) await p.goto(`${base}/?token=${process.env.ATC_TEST_TOKEN}`);
  return { ctx, p, posts, errors };
}

const settled = (p) => p.waitForTimeout(200);
const toSession = async (p, s) => {
  await p.goto(`${base}/#/s/${s.sessionId}`);
  await p.waitForSelector('.hd h1');
  await p.waitForFunction((t) => document.querySelector('.hd h1')?.textContent === t, s.title);
};
const menu = async (p) => {
  await p.click('.hd .more button.kb');
  await p.waitForSelector('.hd .more .sheet');
  return p.$$eval('.hd .more .sheet button', (l) => l.map((x) => x.textContent.trim()));
};
const press = (p, label) => p.locator('.hd .more .sheet button', { hasText: new RegExp(`^${label}$`) }).click();
const palette = async (p) => {
  await p.keyboard.press('Control+k');
  await p.waitForSelector('.pal input');
  await p.keyboard.type('call');
  await p.waitForTimeout(200);
  return p.locator('.pal').innerText();
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME_BIN });

  {
    const { ctx, p, posts, errors } = await open(b);
    await toSession(p, FOCUS);
    const items = await menu(p);
    ok(items.includes('Call') && !items.includes('Call about this'), 'an agent that can talk: Call, not Call about this');
    await press(p, 'Call');
    await p.waitForFunction(() => window.__dialed === 1);
    await settled(p);
    ok(JSON.stringify(posts) === JSON.stringify([['/api/call/to', { agent: 'focus' }]]), `Call asks for the line to the agent and nothing else: ${JSON.stringify(posts)}`);

    posts.length = 0;
    await p.evaluate(() => window.__call.set({ phase: 'active', since: Date.now() }));
    await menu(p);
    await press(p, 'Call');
    await settled(p);
    ok(posts.length === 1 && posts[0][0] === '/api/call/to' && await p.evaluate(() => window.__dialed) === 1, 'on a live call Call moves the line, no second dial');
    ok(!errors.length, `no page errors ${errors.join('; ')}`);
    await ctx.close();
  }

  for (const [s, why] of [[QUIET, 'an agent without talk'], [BROKEN, 'a talking agent that cannot start'], [PLAIN, 'a plain session']]) {
    const { ctx, p, posts } = await open(b);
    await toSession(p, s);
    const items = await menu(p);
    ok(items.includes('Call about this') && !items.includes('Call'), `${why}: Call about this`);
    await press(p, 'Call about this');
    await p.waitForFunction(() => window.__dialed === 1);
    await settled(p);
    ok(posts.length === 1 && posts[0][0] === '/api/call/about' && posts[0][1].id === s.sessionId, `${why}: tells the assistant which session`);
    await ctx.close();
  }

  {
    const { ctx, p, posts } = await open(b);
    await toSession(p, FOCUS);
    const text = await palette(p);
    ok(/\bCall\b/.test(text) && !text.includes('Call about this'), 'palette on the agent: Call');
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__dialed === 1);
    await settled(p);
    ok(posts.some(([u, v]) => u === '/api/call/to' && v.agent === 'focus'), 'palette Call opens on the agent');
    await toSession(p, PLAIN);
    ok((await palette(p)).includes('Call about this'), 'palette on a plain session: Call about this');
    await ctx.close();
  }

  {
    const { ctx, p, posts } = await open(b, { width: 620, app: true });
    await toSession(p, FOCUS);
    await menu(p);
    await press(p, 'Call');
    await p.waitForFunction(() => window.__native === 1);
    await settled(p);
    ok(posts.length === 1 && posts[0][1].agent === 'focus' && !(await p.evaluate(() => window.__dialed)), 'in the app: the native dial, the line asked for over the same API');
    await ctx.close();
  }

  for (const [width, scheme] of [[400, 'light'], [620, 'dark'], [1400, 'dark']]) {
    const { ctx, p } = await open(b, { width, scheme });
    await toSession(p, FOCUS);
    await menu(p);
    const fits = await p.$eval('.hd .more .sheet', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
    ok(fits, `${width} ${scheme}: the menu fits`);
    await p.screenshot({ path: `${OUT}callmenu-${width}-${scheme}.png` });
    await ctx.close();
  }

  await b.close();
  if (fails) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
