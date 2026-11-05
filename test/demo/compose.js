// Lays the raw screens from shots.js out into the README's images: each screen in a window on a backdrop,
// phones in a frame. Every pixel inside a window or a phone is an unretouched screenshot; only the frame and
// the backdrop are drawn here. Run like shots.js, with (page, {out, raw, modes, only}). raw is a URL serving
// the shots folder; the PNGs land in out/<mode>/ for test/demo/shots-encode.sh.
async (page, { raw = "http://127.0.0.1:7440/raw", out = "/tmp/atc-final", modes = ["dark", "light"], only = null } = {}) => {
  const browser = page.context().browser();
  const css = (mode) => {
    const dark = mode === "dark";
    return `
    * { box-sizing: border-box; }
    html, body { margin: 0; background: transparent; }
    #stage { position: relative; overflow: hidden; border-radius: 22px;
      background: ${dark
        ? "radial-gradient(1100px 760px at 86% 12%, #3a2a78 0%, transparent 62%), radial-gradient(900px 700px at 8% 96%, #0f4f55 0%, transparent 60%), #0b0e16"
        : "radial-gradient(1100px 760px at 86% 12%, #dcd2fb 0%, transparent 62%), radial-gradient(900px 700px at 8% 96%, #c6ece6 0%, transparent 60%), #f3f2ef"}; }
    .win { position: absolute; border-radius: 12px; overflow: hidden; background: ${dark ? "#0b0e12" : "#fff"};
      box-shadow: 0 0 0 1px ${dark ? "#ffffff24" : "#00000026"}, 0 30px 80px ${dark ? "#000000b0" : "#2a254066"}; }
    .bar { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 12px; background: ${dark ? "#171a21" : "#ebeaf0"}; }
    .bar i { width: 11px; height: 11px; border-radius: 50%; background: ${dark ? "#3b3f4a" : "#c9c7d2"}; }
    .win img, .ph img { display: block; width: 100%; }
    .ph { position: absolute; padding: 9px; border-radius: 42px; background: #0a0a0c;
      box-shadow: 0 0 0 1.5px ${dark ? "#ffffff30" : "#00000050"}, 0 30px 70px ${dark ? "#000000c0" : "#2a254080"}; }
    .ph img { border-radius: 26px; }
    .band { position: absolute; top: 0; bottom: 0; overflow: hidden; }
    .band img { position: absolute; top: 0; height: 100%; width: auto; }`;
  };
  const win = (src, x, y, w) => `<div class="win" style="left:${x}px;top:${y}px;width:${w}px"><div class="bar"><i></i><i></i><i></i></div><img src="${src}"></div>`;
  const ph = (src, x, y, w) => `<div class="ph" style="left:${x}px;top:${y}px;width:${w}px"><img src="${src}"></div>`;
  const solo = (name, sw = 1560, sh = 940) => ({ w: sw + 120, h: sh + 30 + 100, body: (r) => win(`${r}/${name}.png`, 60, 50, sw) });
  const row = (names, y = 56, w = 390, gap = 50, tilt = 0) => ({
    w: names.length * w + (names.length - 1) * gap + 2 * 70, h: Math.round((w - 18) * (2340 / 1080)) + 18 + 2 * y + tilt,
    body: (r) => names.map((n, i) => ph(`${r}/${n}.png`, 70 + i * (w + gap), y + (i % 2 ? tilt : 0), w)).join(""),
  });

  const layouts = {
    hero: { w: 1960, h: 1220, body: (r) => win(`${r}/desk.png`, 250, 60, 1660) + ph(`${r}/ring-headsup.png`, 40, 240, 440) },
    "call-ring": row(["ring-full", "call-speaking", "recents"], 56, 400, 60),
    assistant: solo("assistant"),
    board: solo("board", 1560, 1040),
    transcript: solo("transcript", 1560, 1040),
    pages: solo("pages"),
    agents: solo("agents"),
    usage: solo("usage", 1560, 1040),
    resources: solo("resources", 1560, 1040),
    browser: solo("browser", 1560, 900),
    terminal: { w: 1360, h: 890, body: (r) => win(`${r}/tui.png`, 60, 50, 1240) },
    palette: solo("palette", 1560, 860),
    new: solo("new", 1560, 860),
    backlog: solo("backlog", 1560, 760),
    settings: solo("settings", 1560, 680),
    phones: row(["phone-hold", "phone-read", "phone-reply", "phone-page"], 56, 390, 46),
    themes: {
      w: 1640, h: 900, once: true,
      body: (r) => {
        const names = ["dark/theme-atc", "dark/theme-frappe", "dark/theme-nord", "light/theme-nord", "light/theme-frappe", "light/theme-atc"];
        const n = names.length, bw = 1520 / n, skew = 60;
        return `<div class="win" style="left:60px;top:50px;width:1520px;height:800px">${names.map((t, i) => {
          const x0 = i * bw, x1 = (i + 1) * bw;
          const clip = `polygon(${i ? x0 + skew : 0}px 0, ${i === n - 1 ? 1520 : x1 + skew}px 0, ${i === n - 1 ? 1520 : x1 - skew}px 800px, ${i ? x0 - skew : 0}px 800px)`;
          return `<img src="${r.replace(/\/(dark|light)$/, "")}/${t}.png" style="position:absolute;left:0;top:0;width:1520px;height:800px;clip-path:${clip}">`;
        }).join("")}</div>`;
      },
    },
  };

  const done = [];
  for (const mode of modes) {
    for (const [name, l] of Object.entries(layouts)) {
      if (only && !only.includes(name)) continue;
      if (l.once && mode !== "dark") continue;
      const ctx = await browser.newContext({ viewport: { width: l.w, height: l.h }, deviceScaleFactor: 2 });
      const p = await ctx.newPage();
      await p.goto(`${raw.replace(/\/raw$/, "")}/demo/compose.html`).catch(() => {});
      await p.setContent(`<!doctype html><style>${css(mode)}</style><div id="stage" style="width:${l.w}px;height:${l.h}px">${l.body(`${raw}/${mode}`)}</div>`);
      await p.waitForLoadState("networkidle");
      await p.waitForFunction(() => [...document.images].every((i) => i.complete));
      const broken = await p.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src));
      await p.screenshot({ path: `${out}/${mode}/${name}.png`, omitBackground: true });
      await ctx.close();
      done.push(broken.length ? `${mode}/${name} MISSING ${broken.join(" ")}` : `${mode}/${name}`);
    }
  }
  return done;
}
