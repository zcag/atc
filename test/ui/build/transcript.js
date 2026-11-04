// Step 3, the transcript: drives the real app (through the dev proxy) and checks it against the
// approved behaviour. Every write to /api is stubbed, so nothing reaches a real session.
// node transcript.js [base]
const { chromium } = require('/home/user/proj/ui-kit/node_modules/playwright-core');
const exe = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const base = process.argv[2] || 'http://127.0.0.1:7301';
const OUT = __dirname + '/../../shots/build/';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ASK = { id: 'test-ask-1', questions: [{ question: 'Esc on phone Back: close the dialog or go back a screen?', options: [
  { label: 'Close the dialog', description: 'Back dismisses it; a second Back leaves the screen' },
  { label: 'Go back a screen', description: "today's behavior: the dialog closes with the screen" }] }] };
const PERM = { id: 'test-perm-1', permission: 'Bash', patterns: ['go test ./internal/server/...'] };

async function open(b, { w, scheme, sid, patch, seen, ask = {}, voice }) {
  const phone = w < 900;
  const ctx = await b.newContext({ viewport: { width: w, height: phone ? 860 : 900 }, colorScheme: scheme, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript((cfg) => {
    try { localStorage.setItem('atc.notifask', '1'); } catch {}
    window.__mut = cfg;
    const ES = window.EventSource;
    window.EventSource = class extends ES {
      addEventListener(type, fn, o) {
        if (type !== 'sessions') return super.addEventListener(type, fn, o);
        const wrap = (e) => {
          window.__last = { fn, data: e.data };
          const list = JSON.parse(e.data), m = window.__mut;
          if (m?.sid) list.forEach((x) => { if (x.sessionId === m.sid) Object.assign(x, m.patch || {}); });
          fn({ data: JSON.stringify(list) });
        };
        window.__emit = () => window.__last && wrap({ data: window.__last.data });
        return super.addEventListener(type, wrap, o);
      }
    };
  }, { sid, patch });
  const p = await ctx.newPage();
  const errs = [], writes = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/api/**', async (r) => {
    const q = r.request(), u = new URL(q.url());
    if (q.method() === 'GET' && u.pathname === '/api/seen' && seen !== undefined) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(seen ? { [sid]: seen } : {}) });
    if (q.method() === 'GET') return r.continue();
    writes.push({ m: q.method(), path: u.pathname, body: q.postData() || '' });
    if (u.pathname.includes('/asks/')) {
      await wait(ask.delay ?? 700);
      return ask.fail ? r.fulfill({ status: 502, body: 'laptop did not confirm the answer' }) : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (u.pathname.endsWith('/upload')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/home/user/.cache/atc/uploads/trace-before.json' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await p.goto(`${base}/#/s/${sid}`);
  await p.waitForSelector('.tx .flow .tb', { timeout: 15000 });
  await p.waitForTimeout(2500);
  return { ctx, p, errs, writes, phone };
}
const shot = (p, name, w, scheme) => p.screenshot({ path: `${OUT}s3-${name}-${w}-${scheme}.png` });
const css = (p, sel, prop) => p.$eval(sel, (e, k) => getComputedStyle(e)[k], prop).catch(() => null);

(async () => {
  const b = await chromium.launch({ executablePath: exe, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const list = await (await fetch(`${base}/api/sessions`)).json();
  const byTitle = (t) => list.find((s) => (s.title || '').includes(t));
  const long = byTitle('db migration') || list.find((s) => s.state === 'your-turn');
  const edits = byTitle('atc redesign build') || long;
  const quiet = list.find((s) => s.state === 'your-turn' && s.attachable && s.kind !== 'hub' && s.sessionId !== long.sessionId) || list.find((s) => s.attachable && s.kind !== 'hub' && s.sessionId !== long.sessionId) || long;
  const qturns = (await (await fetch(`${base}/api/sessions/${quiet.sessionId}/turns`)).json()).turns;
  const qmark = qturns[qturns.length - 1].end || qturns[qturns.length - 1].at;
  const turns = (await (await fetch(`${base}/api/sessions/${long.sessionId}/turns`)).json()).turns;
  const mark = turns[Math.max(0, turns.length - 3)].end || turns[turns.length - 1].at;
  console.log('long', long.title, '| edits', edits.title, '| quiet', quiet.title);

  for (const scheme of ['light', 'dark']) {
    for (const w of [1400, 400]) {
      const tag = `${w} ${scheme}`;
      // reading: the document, the margin, the reading size
      {
        const { ctx, p, errs, writes, phone } = await open(b, { w, scheme, sid: long.sessionId, seen: '' });
        ok(await css(p, '.tx .prose', 'fontFamily') && (await css(p, '.tx .prose', 'fontFamily')).includes('system-ui'), `${tag}: prose is the system font`);
        ok(await css(p, '.tx .prose', 'fontSize') === (phone ? '17px' : '17.5px'), `${tag}: reading size ${await css(p, '.tx .prose', 'fontSize')}`);
        ok(await css(p, '.tx .lead p', 'fontSize') === '16px' && await css(p, '.tx .lead p', 'fontWeight') === '500', `${tag}: your prompt is a 16px/500 head`);
        ok(phone ? !(await p.isVisible('.tx .flow > .mg time')) && await p.isVisible('.tx .lead-at') : await p.isVisible('.tx .flow > .mg time'), `${tag}: ${phone ? 'margin inline above the paragraph' : 'margin notes beside the text'}`);
        ok(!phone || (await p.$$eval('kbd', (l) => l.filter((k) => k.offsetParent).length)) === 0, `${tag}: no key hints on the phone`);
        if (!phone) {
          ok(await p.evaluate(() => document.activeElement?.classList.contains('tx')), `${tag}: the reader has focus`);
          const y0 = await p.$eval('.tx', (e) => e.scrollTop);
          await p.keyboard.press('Shift+K'); await p.waitForTimeout(700);
          const y1 = await p.$eval('.tx', (e) => e.scrollTop);
          ok(y1 < y0, `${tag}: K goes to the previous turn (${y0} -> ${y1})`);
          await p.keyboard.press('Shift+J'); await p.waitForTimeout(700);
          const y2 = await p.$eval('.tx', (e) => e.scrollTop);
          ok(y2 > y1, `${tag}: J goes to the next turn`);
          await p.keyboard.press('PageUp'); await p.waitForTimeout(300);
          ok(await p.$eval('.tx', (e) => e.scrollTop) < y2, `${tag}: page keys scroll the reader`);
          await p.keyboard.press('l'); await p.waitForTimeout(2500);
          ok(!(await p.$('.tx .fold')) && await p.isVisible('.tx .steps'), `${tag}: l opens everything, every turn and step`);
          await p.keyboard.press('l'); await p.waitForTimeout(400);
          ok((await p.$$('.tx .fold')).length >= turns.length - 1, `${tag}: l again is the outline, every turn one line`);
          await p.keyboard.press('l'); await p.waitForTimeout(1500);
          ok((await p.$$('.tx .fold')).length < turns.length, `${tag}: l comes back round to the story`);
          await p.keyboard.press('c'); await p.waitForTimeout(300);
          ok(await p.isVisible('.tx .toc'), `${tag}: c shows Contents`);
          await shot(p, 'contents', w, scheme);
          await p.keyboard.press('c');
          await p.keyboard.press('f'); await p.waitForTimeout(300);
          ok(await p.isVisible('.pop.find'), `${tag}: f opens find`);
          await p.keyboard.press('Escape'); await p.waitForTimeout(200);
          ok(await p.evaluate(() => document.activeElement?.classList.contains('tx')), `${tag}: closing find gives the reader its keys back`);
          await p.keyboard.press('End'); await p.waitForTimeout(800);
        }
        if (phone) { await p.$eval('.tx', (e) => e.scrollTo({ top: e.scrollHeight })); await p.waitForTimeout(500); }
        await shot(p, 'read', w, scheme);
        ok(writes.some((x) => x.path === '/api/seen' && x.body.includes('"from"')), `${tag}: seen is marked on the server when read to the end`);
        const fold = await p.$('.tx .fold');
        if (fold) {
          await fold.click(); await p.waitForTimeout(1500);
          ok(!(await p.$('.tx .fold[aria-expanded="false"]#' + (await fold.getAttribute('id').catch(() => 'x')))), `${tag}: a folded turn opens`);
        }
        const side = await p.$(phone ? '.tx .inl-steps' : '.tx .side');
        if (side) { await side.scrollIntoViewIfNeeded(); await side.click(); await p.waitForTimeout(400); ok(await p.isVisible('.tx .steps'), `${tag}: a step note opens to every step`); await shot(p, 'fold', w, scheme); }
        ok(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
        await ctx.close();
      }
      // since you last looked
      {
        const { ctx, p, errs } = await open(b, { w, scheme, sid: long.sessionId, seen: mark });
        ok(await p.isVisible('#since'), `${tag}: the since divider shows`);
        const txt = await p.textContent('#since .l').catch(() => '');
        ok(/^Since you last looked, \d\d:\d\d$/.test(txt), `${tag}: "${txt}"`);
        ok(await css(p, '#since', 'borderTopWidth') === '2px', `${tag}: a 2px rule`);
        const top = await p.$eval('#since', (e) => e.getBoundingClientRect().top - e.closest('.tx').getBoundingClientRect().top);
        ok(top >= 0 && top < 60, `${tag}: it lands on the divider (${Math.round(top)}px)`);
        await shot(p, 'since', w, scheme);
        ok(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
        await ctx.close();
      }
      // the ask: answer with a key, sending after 400 ms, sent, accepted
      {
        const now = new Date().toISOString();
        const { ctx, p, errs, writes, phone } = await open(b, { w, scheme, sid: quiet.sessionId, patch: { state: 'needs-you', asks: [ASK], updated: now, activity: 'AskUserQuestion', parked: false }, seen: qmark });
        ok(await p.isVisible('#pending-ask'), `${tag}: the question is in the transcript`);
        ok((await css(p, '#pending-ask', 'boxShadow') || '').includes('3px 0px 0px 0px inset'), `${tag}: the ask has a 3px edge`);
        ok((await p.$$eval('#pending-ask .opt kbd', (l) => l.map((k) => k.textContent))).join() === '1,2,', `${tag}: options are numbered`);
        ok(await p.isVisible('#pending-ask .opt.type'), `${tag}: Or type an answer`);
        await p.$eval('#pending-ask', (e) => e.scrollIntoView({ block: 'center' }));
        await shot(p, 'ask', w, scheme);
        if (phone) await p.tap('#pending-ask .opt:first-child');
        else {
          await p.click('.hd h1');
          for (let n = 0; n < 2 && !(await p.evaluate(() => document.activeElement?.id === 'pending-ask')); n++) { await p.keyboard.press('Shift+N'); await p.waitForTimeout(500); }
          ok(await p.evaluate(() => document.activeElement?.id === 'pending-ask'), `${tag}: N brings focus to the question, past a since divider that cannot reach the top`);
          await p.keyboard.press('1');
        }
        await p.waitForTimeout(150);
        ok(!(await p.isVisible('#pending-ask .ast .slow')), `${tag}: no "Sending" before 400 ms`);
        await p.waitForTimeout(400);
        ok(await p.isVisible('#pending-ask .ast .slow'), `${tag}: "Sending" after 400 ms`);
        await p.waitForTimeout(500);
        const a = writes.find((x) => x.path.endsWith('/asks/test-ask-1'));
        ok(a && JSON.parse(a.body).answers?.[0]?.[0] === 'Close the dialog', `${tag}: 1 answered the focused ask with option 1 (stubbed)`);
        ok(/Sent \d\d:\d\d\./.test(await p.textContent('#pending-ask .ast')), `${tag}: Sent`);
        ok(await p.$eval('#pending-ask .opt:nth-child(2)', (e) => e.disabled), `${tag}: the other options lock`);
        await shot(p, 'ask-sent', w, scheme);
        await p.evaluate(() => { window.__mut.patch = { state: 'working', asks: [], activity: 'Read web/app.js' }; window.__emit(); });
        await p.waitForTimeout(600);
        const line = await p.textContent('.tx .ask.line .adl').catch(() => '');
        ok(/You answered 1, Close the dialog, \d\d:\d\d/.test(line), `${tag}: accepted, one line: "${line.trim()}"`);
        await p.$eval('.tx .ask.line', (e) => e.scrollIntoView({ block: 'center' }));
        await shot(p, 'ask-accepted', w, scheme);
        ok(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
        await ctx.close();
      }
      // a failed answer: the reason and Retry
      {
        const { ctx, p, errs } = await open(b, { w, scheme, sid: quiet.sessionId, patch: { state: 'needs-you', asks: [ASK], updated: new Date().toISOString() }, ask: { fail: true, delay: 200 } });
        await p.click('#pending-ask .opt:nth-child(2)');
        await p.waitForTimeout(800);
        ok(/Not sent\..*laptop did not confirm/.test(await p.textContent('#pending-ask .ast.failed').catch(() => '')), `${tag}: failure says why`);
        ok(await p.evaluate(() => document.activeElement?.textContent === 'Retry'), `${tag}: Retry has focus`);
        await p.$eval('#pending-ask', (e) => e.scrollIntoView({ block: 'center' }));
        await shot(p, 'ask-failed', w, scheme);
        ok(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
        await ctx.close();
      }
      // a permission
      if (w === 1400) {
        const { ctx, p } = await open(b, { w, scheme, sid: quiet.sessionId, patch: { state: 'needs-you', asks: [PERM], updated: new Date().toISOString() } });
        const labels = await p.$$eval('#pending-ask .opt .lb', (l) => l.map((x) => x.textContent));
        ok(labels[0] === 'Allow once' && labels[labels.length - 1] === 'Deny', `${tag}: permission reads ${labels.join(', ')}`);
        await p.$eval('#pending-ask', (e) => e.scrollIntoView({ block: 'center' }));
        await shot(p, 'perm', w, scheme);
        await ctx.close();
      }
      // answered somewhere else: the push on the phone
      {
        const at = new Date().toISOString();
        const { ctx, p, errs } = await open(b, { w, scheme, sid: quiet.sessionId, patch: { state: 'working', asks: [], updated: at, answered: { ask: 'perm-elsewhere', what: 'Allow once', via: 'push', device: 'phone', at } } });
        await p.$eval('.tx', (e) => e.scrollTo({ top: e.scrollHeight }));
        await p.waitForTimeout(300);
        const line = await p.textContent('.tx p.adl').catch(() => '');
        ok(/You answered Allow once, \d\d:\d\d \(from the notification on phone\)/.test(line), `${tag}: an answer from the push says so: "${line}"`);
        await p.$eval('.tx p.adl', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
        await shot(p, 'answered-push', w, scheme);
        ok(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
        await ctx.close();
      }
      // working: queue, stop, slash, attach, drafts
      {
        const { ctx, p, errs, writes, phone } = await open(b, { w, scheme, sid: quiet.sessionId, patch: { state: 'working', turnDone: false, activity: 'Bash go test ./internal/server/...', updated: new Date().toISOString() } });
        ok(await p.isVisible('.tx .work .livebar'), `${tag}: the live step has the one moving bar`);
        ok((await p.textContent('.composer .send')) === 'Queue', `${tag}: Send reads Queue while it works`);
        const ta = '.composer textarea';
        await p.click(ta);
        await p.keyboard.press('Escape');
        await p.waitForTimeout(200);
        ok(await p.isVisible('.cstrip.confirm'), `${tag}: Esc in an empty box asks "Stop the agent?"`);
        await shot(p, 'interrupt', w, scheme);
        await p.keyboard.press('Enter');
        await p.waitForTimeout(300);
        ok(writes.some((x) => x.path.endsWith('/keys') && x.body.includes('\\u001b')), `${tag}: enter stops it (stubbed)`);
        await p.click(ta);
        await p.keyboard.type('/co');
        await p.waitForTimeout(200);
        ok(await p.isVisible('.slash .sl.on'), `${tag}: / lists slash commands`);
        await shot(p, 'slash', w, scheme);
        await p.keyboard.press('Tab');
        ok((await p.inputValue(ta)).startsWith('/compact'), `${tag}: tab completes it`);
        await p.fill(ta, '');
        await p.keyboard.type('When the tests pass, also run them on laptop before you merge.');
        await p.waitForTimeout(900);
        ok(writes.some((x) => x.path.startsWith('/api/drafts/') && x.body.includes('"from"')), `${tag}: the draft is saved on the server`);
        if (phone) await p.tap('.composer .send'); else await p.keyboard.press('Enter');
        await p.waitForTimeout(400);
        ok(await p.isVisible('.tx .queued'), `${tag}: the message is queued under the transcript`);
        ok(!writes.some((x) => x.path.endsWith('/send')), `${tag}: nothing was sent while it works`);
        await p.$eval('.tx .queued', (e) => e.scrollIntoView({ block: 'center' }));
        await shot(p, 'queued', w, scheme);
        await p.click('.tx .queued .btn:has-text("Cancel")');
        ok(await p.isVisible('.tx .queued.gone'), `${tag}: Cancel leaves an Undo`);
        await p.click('.tx .queued.gone .btn');
        ok(await p.isVisible('.tx .queued .qt'), `${tag}: Undo puts it back`);
        await p.click('.tx .queued .btn:has-text("Edit")');
        ok((await p.inputValue(ta)).includes('laptop before you merge'), `${tag}: Edit brings it back into the box`);
        await p.fill(ta, '');
        await p.setInputFiles('.composer input[type=file]', { name: 'trace-before.json', mimeType: 'application/json', buffer: Buffer.from('{"calls": 41}') });
        await p.waitForTimeout(600);
        ok(await p.isVisible('.composer .att .nm'), `${tag}: an attachment shows as a chip`);
        await shot(p, 'attach', w, scheme);
        await p.click('.composer .att .rm');
        if (phone) ok((await p.$eval('.composer .att-b', (e) => e.getBoundingClientRect().height)) >= 44, `${tag}: 44px targets in the composer`);
        ok(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
        await ctx.close();
      }
      // edits fold open to the diff
      if (w === 1400) {
        const { ctx, p, errs } = await open(b, { w, scheme, sid: edits.sessionId });
        const ef = await p.$$('.tx .ef > li > button');
        if (ef.length) {
          const last = ef[ef.length - 1];
          await last.scrollIntoViewIfNeeded(); await last.click(); await p.waitForTimeout(300);
          ok(await p.isVisible('.tx .ef .code .l'), `${tag}: an edited file opens to its diff`);
          ok(await p.evaluate(() => { const l = [...document.querySelectorAll('.tx .ef .code .l')]; const i = l.findIndex((x) => x.classList.contains('add')); return i < 0 || !l.slice(i).some((x, j) => x.classList.contains('del') && l[i + j - 1]?.classList.contains('add')); }), `${tag}: deletions come before additions`);
          await p.$eval('.tx .ef li.open', (e) => e.scrollIntoView({ block: 'start' }));
          await p.$eval('.tx', (e) => (e.scrollTop -= 60));
          await shot(p, 'edits', w, scheme);
        } else ok(false, `${tag}: no edits found to open`);
        ok(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
        await ctx.close();
      }
    }
  }
  await b.close();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
