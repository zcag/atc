// A call to the user ringing in the browser, with the real call.js and a fake microphone: a ring on /api/events rings
// the page, Answer sends accept and the call goes live, Decline sends hangup, another device answering stops it, a
// stale ring and leaving the page while it rings send nothing. The call line and every write are stubbed in the browser.
const { chromium } = require('playwright-core');
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = process.argv[3] || __dirname + '/../../shots/build/';
const REASON = 'Checkout errors jumped to 8% after the last deploy';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const json = (r, v) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });

async function open(b, { width, scheme }) {
  const phone = width < 900;
  const ctx = await b.newContext({ viewport: { width, height: 860 }, colorScheme: scheme, isMobile: phone, hasTouch: phone, permissions: ['microphone'] });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('atc.setup.skip', '1'); localStorage.setItem('atc.notifask', '1'); } catch {} });
  const rings = [];
  await ctx.route(/\/api\//, (r) => {
    const req = r.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return json(r, {});
    if (path === '/api/events') {
      const ring = rings.shift();
      return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 100\nevent: sessions\ndata: []\n\n' + (ring ? `event: ring\ndata: ${JSON.stringify(ring)}\n\n` : '') });
    }
    if (path === '/api/sessions') return json(r, []);
    if (path === '/api/agents') return json(r, []);
    if (path === '/api/me') return r.fetch().then((x) => (x.ok() ? x.json().then((me) => json(r, { ...me, call: true })) : r.fulfill({ response: x })));
    return r.continue();
  });
  const line = { cmds: [], frames: 0, ws: null };
  await ctx.routeWebSocket(/\/api\/call\/line/, (ws) => {
    line.ws = ws;
    ws.onMessage((m) => {
      if (typeof m !== 'string') return void line.frames++;
      const o = JSON.parse(m);
      if (o.cmd === 'stats') return;
      line.cmds.push(o.cmd);
      if (o.cmd === 'accept') ws.send(JSON.stringify({ event: 'active' }));
      if (o.cmd === 'hangup') ws.send(JSON.stringify({ event: 'ended', why: 'hangup' }));
    });
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  if (process.env.ATC_TEST_TOKEN) await p.goto(`${base}/?token=${process.env.ATC_TEST_TOKEN}`);
  await p.goto(`${base}/#/`);
  await p.waitForTimeout(800);
  const ring = async (at = Math.floor(Date.now() / 1000)) => { line.cmds.length = 0; rings.push({ reason: REASON, at }); };
  return { ctx, p, line, errors, ring };
}

const until = async (p, f, ms = 3000) => { for (let t = 0; t < ms && !f(); t += 20) await p.waitForTimeout(20); return !!f(); };
const fits = (p, sel) => p.locator(sel).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

  for (const scheme of ['light', 'dark']) {
    const { ctx, p, line, errors, ring } = await open(b, { width: 1400, scheme });
    await ring();
    await p.waitForSelector('.callp.ringing', { timeout: 3000 });
    ok(await until(p, () => line.cmds.includes('ring-here')), `the page rings the call with ring-here (${scheme})`);
    ok(!line.cmds.includes('ringing'), 'and never claims to be the phone ringing');
    ok((await p.locator('.callp .st').textContent()).includes('Checkout errors'), 'the panel says why');
    ok(await p.locator('.callp .oncall.ring').count() === 1, 'and that it is calling you');
    ok(await p.locator('.console .answer').count() === 1, 'the console line can answer too');
    await p.screenshot({ path: `${OUT}ring-desktop-${scheme}.png` });
    if (scheme === 'dark') { await ctx.close(); continue; }

    await p.keyboard.press('Shift+A');
    ok(await until(p, () => line.cmds.includes('accept')), 'Shift+A answers with accept');
    await p.waitForSelector('.callp.active', { timeout: 3000 });
    const f0 = line.frames;
    await p.waitForTimeout(500);
    ok(line.frames - f0 > 10, `answered, the microphone reaches the line (${line.frames - f0} frames)`);
    await p.keyboard.press('Shift+E');
    ok(await until(p, () => line.cmds.includes('hangup')), 'End hangs up');
    await p.waitForTimeout(3000);

    await ring();
    await p.waitForSelector('.callp.ringing', { timeout: 3000 });
    await p.locator('.callp .ctl .btn.end').click();
    ok(await until(p, () => line.cmds.includes('hangup')), 'Decline sends hangup');
    ok(!line.cmds.includes('accept'), 'and no accept');
    await p.waitForSelector('.callp.ended', { timeout: 2000 });
    ok((await p.locator('.callp .st').textContent()).includes('declined'), 'the panel says it was declined');
    await p.waitForTimeout(3000);

    await ring();
    await p.waitForSelector('.callp.ringing', { timeout: 3000 });
    line.ws.send(JSON.stringify({ event: 'ended', why: 'answered on another device' }));
    await p.waitForSelector('.callp.ended', { timeout: 2000 });
    ok((await p.locator('.callp .st').textContent()).includes('another device'), 'answered on the phone, the page stops ringing and says so');
    ok(!line.cmds.includes('hangup'), 'without declining it');
    await p.waitForTimeout(3000);

    await ring(Math.floor(Date.now() / 1000) - 120);
    await p.waitForTimeout(1500);
    ok(await p.locator('.callp').count() === 0 && !line.cmds.includes('ring-here'), 'a stale ring does nothing');

    await ring();
    await p.waitForSelector('.callp.ringing', { timeout: 3000 });
    await p.goto('about:blank');
    await p.waitForTimeout(300);
    ok(!line.cmds.includes('hangup'), 'leaving the page while it rings does not decline the call');
    ok(errors.length === 0, `no page errors ${errors}`);
    await ctx.close();
  }

  for (const [width, scheme] of [[400, 'light'], [400, 'dark'], [620, 'dark']]) {
    const s = await open(b, { width, scheme });
    await s.ring();
    await s.p.waitForSelector('.callp.full.ringing', { timeout: 3000 });
    ok(await s.p.evaluate(() => location.hash) === '#/call', `at ${width} the ring opens the call screen`);
    ok(await fits(s.p, '.callp .ctl'), `Answer and Decline fit at ${width}`);
    await s.p.screenshot({ path: `${OUT}ring-phone-${width}-${scheme}.png` });
    if (width === 400 && scheme === 'light') {
      await s.p.goto(`${base}/#/`);
      await s.p.waitForSelector('.callpill .answer');
      ok(await fits(s.p, '.callpill'), 'the call pill fits Answer and Decline');
      await s.p.screenshot({ path: `${OUT}ring-pill-${width}.png` });
      await s.p.locator('.callpill .answer').tap();
      ok(await until(s.p, () => s.line.cmds.includes('accept')), 'a tap on the pill answers');
    }
    ok(s.errors.length === 0, `no page errors at ${width} ${s.errors}`);
    await s.ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} failed` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
