const { chromium } = require('playwright-core');
const exe = process.env.CHROME_BIN;
(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const p = await b.newPage();
  await p.goto(process.argv[2]);
  await p.waitForTimeout(3000);
  console.log(await p.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`);
    const probe = (fam) => { const s = document.createElement('span'); s.style.font = `13px ${fam}`; s.textContent = 'Re-review done; cookie system explained'; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); };
    const said = document.querySelector('.said, .it .t, p');
    return { faces, sans: probe('var(--sans)'), rec: probe('Recursive'), mono: probe('"Recursive Mono"'), saidFont: said && getComputedStyle(said).fontFamily };
  }));
  await b.close();
})();
