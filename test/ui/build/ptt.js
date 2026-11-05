// Push to talk with the real call.js and a fake microphone: audio reaches the line only while the button is held, with
// talk-down and talk-up around it, and the toggle sticks. The call line is stubbed in the browser; all writes are too.
const { chromium } = require('playwright-core');
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = process.argv[3] || __dirname + '/../../shots/build/';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const json = (r, v) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });

async function open(b, { width, scheme, ptt }) {
  const phone = width < 900;
  const ctx = await b.newContext({ viewport: { width, height: 860 }, colorScheme: scheme, isMobile: phone, hasTouch: phone, permissions: ['microphone'] });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('atc.setup.skip', '1'); localStorage.setItem('atc.notifask', '1'); } catch {} });
  if (ptt) await ctx.addInitScript(() => { try { localStorage.setItem('atc.callPtt', '1'); } catch {} });
  await ctx.route(/\/api\//, (r) => {
    const req = r.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return json(r, {});
    if (path === '/api/events') return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: sessions\ndata: []\n\n' });
    if (path === '/api/sessions') return json(r, []);
    if (path === '/api/agents') return json(r, []);
    if (path === '/api/me') return r.fetch().then((x) => (x.ok() ? x.json().then((me) => json(r, { ...me, call: true })) : r.fulfill({ response: x })));
    return r.continue();
  });
  const line = { cmds: [], seq: [], loud: 0, frames: 0, reset() { this.loud = this.frames = 0; } };
  await ctx.routeWebSocket(/\/api\/call\/line/, (ws) => {
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        const o = JSON.parse(m);
        if (o.cmd !== 'stats') { line.cmds.push(o.cmd); line.seq.push(o.cmd); }
        if (o.cmd === 'call' || o.cmd === 'resume') ws.send(JSON.stringify({ event: 'active' }));
        return;
      }
      line.frames++;
      const a = new Int16Array(m.buffer, m.byteOffset, m.length >> 1);
      const sound = a.some((v) => v !== 0);
      if (sound) line.loud++;
      line.seq.push(sound ? 'loud' : 'quiet');
    });
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  if (process.env.ATC_TEST_TOKEN) await p.goto(`${base}/?token=${process.env.ATC_TEST_TOKEN}`);
  return { ctx, p, line, errors };
}

const dial = async (p) => {
  await p.goto(`${base}/#/assist`);
  await p.waitForTimeout(800);
  await p.keyboard.press('.');
  await p.waitForSelector('.callp.active');
};
const until = async (p, f, ms = 3000) => { for (let t = 0; t < ms && !f(); t += 20) await p.waitForTimeout(20); return !!f(); };
const clipped = (p) => p.locator('.callp .ctl .btn').evaluateAll((l) => l.filter((b) => {
  const r = b.getBoundingClientRect(), box = b.closest('.callp').getBoundingClientRect();
  return b.scrollWidth > b.clientWidth + 1 || r.right > box.right + 1;
}).map((b) => b.textContent));
const listen = async (p, line, ms = 500) => { line.reset(); await p.waitForTimeout(ms); return { frames: line.frames, loud: line.loud }; };

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

  const { ctx, p, line, errors } = await open(b, { width: 1400, scheme: 'light' });
  await dial(p);
  let got = await listen(p, line);
  ok(got.frames > 10 && got.loud > 5, `open mic by default (${got.loud}/${got.frames} frames with sound)`);
  ok((await clipped(p)).length === 0, `docked controls fit with Mute ${await clipped(p)}`);
  await p.screenshot({ path: OUT + 'ptt-desktop-off.png' });
  await p.keyboard.press('t');
  await p.waitForSelector('.ctalk .talkb');
  await p.waitForTimeout(200);
  got = await listen(p, line);
  ok(got.frames > 10 && got.loud === 0, `toggled on, mic closed (${got.loud}/${got.frames})`);
  ok(await p.locator('.callp .ctl .btn', { hasText: 'Mute' }).count() === 0, 'no Mute while push to talk is on');
  await p.screenshot({ path: OUT + 'ptt-desktop-light.png' });

  const talk = p.locator('.ctalk .talkb');
  const box = await talk.boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  line.seq.length = 0;
  await p.mouse.down();
  ok(await until(p, () => line.cmds.at(-1) === 'talk-down'), 'pressing sends talk-down');
  got = await listen(p, line);
  ok(got.loud > 5, `held, audio flows (${got.loud}/${got.frames})`);
  ok((await talk.textContent()).includes('let go'), 'the button says so while held');
  await p.screenshot({ path: OUT + 'ptt-desktop-held.png' });
  const released = line.seq.length;
  await p.mouse.up();
  ok(await until(p, () => line.cmds.at(-1) === 'talk-up'), 'letting go sends talk-up');
  const up = line.seq.indexOf('talk-up');
  const lastLoud = line.seq.lastIndexOf('loud', up);
  ok(lastLoud > released, 'the tail of the word is sent after letting go');
  await p.waitForTimeout(400);
  const after = line.seq.slice(up).filter((x) => x === 'loud').length;
  ok(after <= 1, `at most the frame being filled follows talk-up (${after})`);
  ok(line.seq.slice(0, up).filter((x) => x === 'talk-down').length === 1, 'one talk-down for one press');

  const ups = line.cmds.filter((c) => c === 'talk-up').length;
  await p.mouse.down();
  await p.waitForTimeout(50);
  await p.mouse.up();
  await p.waitForTimeout(50);
  await p.mouse.down();
  await p.waitForTimeout(400);
  ok(line.cmds.filter((c) => c === 'talk-up').length === ups, 'pressing again within the tail keeps the same turn open');
  await p.mouse.up();
  await until(p, () => line.cmds.filter((c) => c === 'talk-up').length === ups + 1);
  await p.waitForTimeout(100);

  const before = line.cmds.length;
  await p.mouse.move(5, 5);
  await p.keyboard.down(' ');
  await p.waitForTimeout(40);
  await p.keyboard.down(' ');
  await until(p, () => line.cmds.length > before);
  await p.waitForTimeout(100);
  ok(line.cmds.slice(before).join() === 'talk-down', 'space presses, its key repeat does nothing more');
  await p.keyboard.up(' ');
  ok(await until(p, () => line.cmds.slice(before).join() === 'talk-down,talk-up'), 'letting go of space lets go');

  await p.keyboard.press('t');
  await p.waitForTimeout(200);
  got = await listen(p, line);
  ok(await p.locator('.talkb').count() === 0 && got.loud > 5, `toggled off, open mic and no talk button (${got.loud}/${got.frames})`);
  await p.keyboard.press('t');
  await p.keyboard.press('Shift+E');
  await p.waitForTimeout(300);
  await p.reload();
  await dial(p);
  await p.waitForTimeout(200);
  got = await listen(p, line);
  ok(await p.locator('.ctalk .talkb').count() === 1 && got.frames > 10 && got.loud === 0, `the next call starts with it on, nothing sent (${got.loud}/${got.frames})`);
  ok(errors.length === 0, `no page errors ${errors}`);
  await ctx.close();

  for (const [width, scheme] of [[400, 'light'], [400, 'dark'], [620, 'dark']]) {
    const s = await open(b, { width, scheme, ptt: true });
    await dial(s.p);
    await s.p.waitForTimeout(300);
    const row = await s.p.locator('.callp .ctl').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    ok(row, `controls fit at ${width}`);
    ok((await clipped(s.p)).length === 0, `no clipped button at ${width} ${await clipped(s.p)}`);
    await s.p.screenshot({ path: `${OUT}ptt-phone-${width}-${scheme}.png` });
    const t = await s.p.locator('.ctalk .talkb').boundingBox();
    await s.p.touchscreen.tap(t.x + t.width / 2, t.y + t.height / 2);
    ok(await until(s.p, () => s.line.cmds.join().includes('talk-down,talk-up')), `a touch presses and lets go at ${width}`);
    if (width === 400 && scheme === 'light') {
      await s.p.goto(`${base}/#/`);
      await s.p.waitForSelector('.callpill .talkb');
      await s.p.screenshot({ path: `${OUT}ptt-pill-${width}.png` });
      ok(await s.p.locator('.callpill').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the call pill still fits with Talk');
    }
    ok(s.errors.length === 0, `no page errors at ${width} ${s.errors}`);
    await s.ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} failed` : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
