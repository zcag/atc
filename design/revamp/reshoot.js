// node reshoot.js [id ...]: screenshots every shot of the named items (all items when none are named) as WebP, keeping each shot's size.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
global.window = {};
const here = __dirname;
require(path.join(here, 'items.js'));
const ids = process.argv.slice(2);
const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args]).toString().trim();
const size = (name, webp) => {
  if (fs.existsSync(webp)) return py('import sys; from PIL import Image; print(*Image.open(sys.argv[1]).size)', webp).split(' ');
  if (/-620$/.test(name)) return ['620', '1300'];
  if (/-phone/.test(name)) return ['400', '860'];
  return ['1440', '900'];
};
for (const it of window.ITEMS) {
  if (ids.length && !ids.includes(it.id)) continue;
  for (const [shot] of it.shots || []) {
    const mock = path.join(here, 'mocks', it.mock + '.html');
    if (!fs.existsSync(mock)) { console.log('no mock', mock); continue; }
    const webp = path.join(here, 'shots', shot + '.webp');
    const png = webp.replace(/webp$/, 'png');
    const [w, h] = size(shot.replace(/-dark$/, ''), webp);
    const args = [mock, png, w, h];
    if (/-dark$/.test(shot)) args.push('dark');
    execFileSync(path.join(here, 'shoot.sh'), args);
    py('import sys, os; from PIL import Image; Image.open(sys.argv[1]).save(sys.argv[2], "WEBP", quality=88, method=6); os.remove(sys.argv[1])', png, webp);
    console.log(shot, w + 'x' + h);
  }
}
