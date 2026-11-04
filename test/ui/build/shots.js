const { chromium } = require('/home/user/proj/ui-kit/node_modules/playwright-core');
const exe = '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const OUT = __dirname + '/../../shots/build/';
const [step, ...targets] = process.argv.slice(2);

(async () => {
  const b = await chromium.launch({ executablePath: exe });
  for (const t of targets) {
    const [tag, base, route, name, theme] = t.split('|');
    for (const scheme of ['light', 'dark']) for (const w of [1400, 400]) {
      const ctx = await b.newContext({ viewport: { width: w, height: w < 900 ? 860 : 900 }, hasTouch: w < 900, isMobile: w < 900, colorScheme: scheme, deviceScaleFactor: w < 900 ? 2 : 1 });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base + '/' + route, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(3500);
      if (theme) { await p.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme); await p.waitForTimeout(300); }
      const file = `${OUT}${step}-${name}-${tag}-${w}-${scheme}.png`;
      await p.screenshot({ path: file });
      console.log(file.replace(OUT, ''), errs.length ? 'ERR ' + errs.join(' | ') : '');
      await ctx.close();
    }
  }
  await b.close();
})();
