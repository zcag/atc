const { chromium } = require('playwright-core');
const [base = 'http://127.0.0.1:7299', bay = 'listings'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_BIN });
  for (const [w, h, dpr] of [[1400, 900, 1], [400, 860, 2]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 900 });
    await ctx.addInitScript((x) => { try { localStorage.setItem('atc.notifask', '1'); localStorage.setItem('atc.project', x); } catch {} }, bay);
    const p = await ctx.newPage();
    await p.route('**/api/**', (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204 }));
    await p.goto(base + '/');
    await p.waitForTimeout(3000);
    console.log(w, 'backlog line:', await p.locator('.bhead .blline').innerText());
    await p.screenshot({ path: `${__dirname}/../../shots/build/final-bay-${w}.png` });
    await ctx.close();
  }
  await b.close();
})();
