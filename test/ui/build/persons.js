// A person per language on a private instance: changing language swaps character, background and name, and the
// panel makes and picks persons. Writes persons.json, so never point it at a real atc.
const { chromium } = require('playwright-core');
const fs = require('fs');
const base = process.argv[2] || 'http://127.0.0.1:7299';
const OUT = process.argv[3] || __dirname + '/../../shots/build/';
const FAKE = fs.readFileSync(__dirname + '/fakecall.js', 'utf8');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const { id } of (await (await fetch(base + '/api/call/persons')).json()).persons) await fetch(`${base}/api/call/persons/${id}`, { method: 'DELETE' });
  await post('/api/call/persons', { name: 'Mira', character: 'woman', background: 'night.jpg', voices: { tr: 'voice_f' } });
  await post('/api/call/persons', { name: 'Hoca', character: 'professor', voices: { tr: 'voice_m', en: 'en_merchant' } });
  await post('/api/call/persons', { name: 'Sessiz', character: 'professor', background: 'evening.jpg', voices: { tr: 'voice_m', en: 'voice_en' } });
  await post('/api/call/persons/pick', { lang: 'tr', id: 'mira' });
  await post('/api/call/persons/pick', { lang: 'en', id: 'hoca' });

  const b = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const [label, scheme, width] of [['light400', 'light', 400], ['dark620', 'dark', 620]]) {
    const ctx = await b.newContext({ viewport: { width, height: 860 }, isMobile: width < 900, hasTouch: width < 900, colorScheme: scheme });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('atc.setup.skip', '1'); localStorage.setItem('atc.notifask', '1'); } catch {} });
    await ctx.route('**/call.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE }));
    const p = await ctx.newPage();
    const asked = [];
    const errors = [];
    p.on('request', (r) => asked.push(new URL(r.url()).pathname));
    p.on('pageerror', (e) => errors.push(e.message));
    const seen = (s) => asked.some((a) => a.includes(s));
    const shot = (n) => p.screenshot({ path: `${OUT}persons-${label}-${n}.png` });
    await p.goto(base + '/#/call');
    await p.waitForSelector('.callp');
    await p.evaluate(() => window.__call.set({ phase: 'active', since: Date.now() }, { state: 'listening', lang: 'tr' }));
    await p.waitForFunction(() => document.querySelector('.cph .w')?.textContent.includes('Mira'), null, { timeout: 8000 }).catch(() => {});
    ok(await p.locator('.cph .w').innerText() === 'assistant, Mira', 'Turkish: the name is the Turkish person');
    await p.waitForTimeout(3000);
    ok(seen('/personas/woman/rig.json') && seen('/_rooms/night.jpg'), 'Turkish: her character and background load');
    await shot('tr');
    const drawn = async () => (await p.locator('.cpers .fr').screenshot()).length > 30000;
    ok(await drawn(), 'Turkish: the frame shows a picture, not an empty canvas');

    asked.length = 0;
    await p.evaluate(() => window.__call.set({}, { lang: 'en' }));
    await p.waitForTimeout(3000);
    ok(await p.locator('.cph .w').innerText() === 'assistant, Hoca', 'English: the name changes with the language');
    ok(seen('/personas/professor/rig.json') && !seen('/_rooms/'), 'English: the other character, in its own room');
    await shot('en');
    ok(await drawn(), 'English: the frame shows a picture');

    await p.evaluate(() => window.__call.set({}, { line: 'focus', title: 'Focus', person: 'sessiz' }));
    await p.waitForTimeout(500);
    ok(await p.locator('.cph .w').innerText() === 'Focus, Sessiz', 'an agent with a person: that person, whatever the language');
    await p.evaluate(() => window.__call.set({}, { line: 'other', title: 'Other', person: '' }));
    await p.waitForTimeout(300);
    ok(await p.locator('.cph .w').innerText() === 'Other, Hoca', 'an agent without one: who the assistant is in this language');
    await p.evaluate(() => window.__call.set({}, { line: 'assistant', title: '', person: '' }));

    asked.length = 0;
    const view = (name) => p.locator('.cview').getByRole('button', { name, exact: true });
    await view('Line').click();
    await p.waitForTimeout(800);
    ok(await view('Line').getAttribute('aria-pressed') === 'true', 'the view switch is on the frame');
    ok(await p.locator('.cph .w').innerText() === 'assistant, Hoca', 'the person stays who they are in the line view');
    await shot('line');
    await p.evaluate(() => window.__call.set({}, { lang: 'tr' }));
    await p.waitForTimeout(800);
    ok(!seen('rig.json'), 'a language change in the line view loads no character');
    await view('Bars').click();
    await p.waitForTimeout(500);
    await shot('bars');
    ok(await p.locator('.cview [aria-pressed="true"]').innerText() === 'Bars', 'bars');
    await view('Character').click();
    await p.waitForTimeout(3000);
    ok(seen('/personas/woman/rig.json') && await drawn(), 'back to Character: the person of the language spoken now');
    await p.evaluate(() => window.__call.set({}, { lang: 'en' }));
    await view('Line').click();
    await p.reload();
    await p.waitForSelector('.callp');
    ok(await p.locator('.cview [aria-pressed="true"]').innerText() === 'Line', 'the view is kept on this device');
    await p.evaluate(() => window.__call.set({ phase: 'active', since: Date.now() }, { state: 'listening', lang: 'en' }));
    await view('Character').click();
    await p.waitForTimeout(500);

    await p.getByRole('button', { name: 'Person', exact: true }).click();
    await p.waitForSelector('.picks .vpick');
    await shot('panel');
    ok(await p.locator('.picks [role=radiogroup]').count() === 2, 'one group per language');
    ok(await p.locator('.picks [role=radiogroup]').last().locator('.vpick').count() === 2, 'only persons with an English voice are offered in English');
    await p.getByRole('radio', { name: /Sessiz/ }).last().click();
    await p.waitForFunction(() => document.querySelector('.cph .w')?.textContent.includes('Sessiz'));
    ok(true, 'a pick for the language being spoken shows at once');
    await p.getByRole('radio', { name: /Hoca/ }).last().click();
    await p.waitForFunction(() => document.querySelector('.cph .w')?.textContent.includes('Hoca'));

    ok(await p.getByRole('link', { name: 'Edit persons' }).count() === 1, 'the panel points at the persons page');

    await p.goto(base + '/#/settings/persons');
    await p.waitForSelector('.gallery .personcard');
    ok(await p.locator('.slots .slot').count() === 2, 'a slot per language');
    ok(await p.locator('.gallery .personcard:not(.new)').count() === 3, 'everyone is in the gallery');
    await p.waitForFunction(() => document.querySelectorAll('.gallery .face img').length === 3, null, { timeout: 90000 });
    await p.waitForTimeout(300);
    await shot('gallery');
    ok(await p.evaluate(() => [...document.querySelectorAll('.gallery .face img')].every((i) => i.naturalWidth > 0)), 'portraits are real pictures');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'gallery: no sideways scroll');
    await p.locator('.slot').first().getByRole('radio', { name: /Hoca/ }).click();
    await p.waitForFunction(() => document.querySelector('.slotcap b')?.textContent === 'Hoca');
    ok(true, 'a slot swaps who speaks that language');
    await p.locator('.slot').first().getByRole('radio', { name: /Mira/ }).click();
    await p.waitForFunction(() => document.querySelector('.slotcap b')?.textContent === 'Mira');

    await p.locator('.gallery .personcard', { hasText: 'Sessiz' }).click();
    await p.waitForSelector('.peditor');
    await p.waitForTimeout(3000);
    await shot('edit');
    ok(await p.locator('.picktiles').first().locator('.tile').count() === 3, 'orb and two characters: line and bars are views, not characters');
    ok(await p.locator('.pvframe canvas').count() === 1, 'the editor has a live preview');
    await p.locator('.tile', { hasText: 'Orb' }).click();
    await p.waitForTimeout(500);
    ok(await p.locator('.peditor').getByText('draws its own surroundings').count() === 1, 'the orb takes no background');
    await p.locator('.tile', { hasText: 'Professor' }).click();
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'editor: no sideways scroll');
    await p.getByRole('link', { name: 'Cancel' }).click();
    await p.waitForSelector('.gallery');

    if (width < 900) {
      await p.goto(base + '/#/settings');
      await p.waitForSelector('.setnav a');
      ok(!(await p.isVisible('.setpage')), 'phone: Settings opens on the list of pages');
      await shot('list');
      await p.locator('.setnav a', { hasText: 'Persons' }).click();
      await p.waitForSelector('.gallery');
      ok(!(await p.isVisible('.setnav')), 'phone: a page takes the whole screen');
      await p.locator('.settings .pghead .icon').click();
      await p.waitForSelector('.setnav a');
      ok(await p.isVisible('.setnav'), 'phone: Back returns to the list');
    }
    ok(errors.length === 0, `no page errors ${errors.join('; ')}`);
    await ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all ok');
  process.exit(fails ? 1 : 0);
})();
