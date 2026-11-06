// Draws the panel beside the phone for film.py: the backdrop and phone frame (stage.png), then one transparent PNG per
// beat of beats.json, with the conversation so far and what to notice. Run like shots.js, with (page, {beats, out}).
async (page, { beats = "http://127.0.0.1:7440/film/beats.json", out = "/tmp/atc-stage/film" } = {}) => {
  const list = await (await page.context().request.get(beats)).json();
  const ctx = await page.context().browser().newContext({ viewport: { width: 1280, height: 780 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const PW = 323, PH = 700, X = 56, Y = 40;
  const base = `*{box-sizing:border-box}html,body{margin:0;background:transparent;font:18px/1.42 ui-sans-serif,'Inter','Noto Sans',system-ui,sans-serif;color:#eef0f6}
  #s{position:relative;width:1280px;height:780px;overflow:hidden}
  .bg{position:absolute;inset:0;background:radial-gradient(900px 700px at 90% 8%,#2d2262,transparent 62%),radial-gradient(800px 640px at 0% 100%,#0e4a50,transparent 60%),#090c14}
  .p{position:absolute;left:430px;right:44px;top:44px;bottom:30px;display:flex;flex-direction:column}
  .log{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:13px;min-height:0;overflow:hidden}
  .l{display:grid;grid-template-columns:62px 1fr;gap:12px;opacity:.5}
  .l.now{opacity:1}
  .w{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#a9afc4;padding-top:6px}
  .l.you .x{color:#fff;font-weight:600}
  .l.it .x{color:#d8d4ff}
  .l.canned .x{font-style:italic}
  .l.cut .x::after{content:" (cut off)";color:#ffb86b;font-style:italic}
  .l.tool{grid-template-columns:62px 1fr;font-size:15px}
  .l.tool .x{color:#ffc68a;font-family:ui-monospace,monospace;font-size:14px;padding-top:2px}
  .x{font-size:21px}
  .note{height:92px;margin-top:20px;padding:13px 16px;border-left:3px solid #8f7bff;background:#ffffff0d;border-radius:0 8px 8px 0;font-size:17px;color:#fff}
  .foot{margin-top:12px;font-size:12.5px;line-height:1.35;color:#9ca3b8}
  .ring{flex:1;display:flex;flex-direction:column;justify-content:center;gap:10px}
  .ring b{font-size:40px;font-weight:650}.ring span{font-size:22px;color:#d8d4ff}.ring em{font-style:normal;font-size:16px;color:#a9afc4;margin-top:8px}
  .endc{flex:1;display:flex;flex-direction:column;justify-content:center;gap:12px}.endc b{font-size:30px}.endc span{font-size:18px;color:#d8d4ff}`;
  const FOOT = "Demo call. The assistant's words are written for this demo, since no real Claude runs here. So are the pauses before it answers. The call line, the turn-taking, the interruption, the thinking phrases and the voice are atc's real call stack, on its default CPU voice. The caller is synthetic too.";
  const shot = async (html, file, transparent = true) => {
    await p.setContent(`<!doctype html><style>${base}</style><div id="s">${html}</div>`);
    await p.screenshot({ path: `${out}/${file}.png`, omitBackground: transparent });
  };
  await shot(`<div class="bg"></div>`, "stage", false);
  await shot(`<div style="position:absolute;left:${X}px;top:${Y}px;width:${PW}px;height:${PH}px;border-radius:28px;box-shadow:0 0 0 11px #050507,0 0 0 12.5px #ffffff2e,0 26px 70px 10px #000a"></div>`, "frame");
  const seen = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    let body;
    if (b.ring) body = `<div class="ring"><em>${b.answered ? "You answer" : "Your phone rings"}</em><b>Assistant</b><span>${b.ring}</span><em>@ops looked into an alert and decided this can't wait.</em></div>`;
    else if (b.end) body = `<div class="endc"><b>${b.end}</b><span>${b.sub || ""}</span></div>`;
    else {
      if (b.cut) [...seen].reverse().find((l) => l.it).cut = true;
      else seen.push(b);
      const last = seen.slice(-6);
      body = `<div class="log">${last.map((l, n) => `<div class="l ${l.tool ? "tool" : l.you ? "you" : "it"} ${l.canned ? "canned" : ""} ${l.cut ? "cut" : ""} ${n === last.length - 1 ? "now" : ""}"><span class="w">${l.tool ? "" : l.you ? "You" : "It"}</span><span class="x">${l.tool || l.you || l.it}</span></div>`).join("")}</div>`;
    }
    const note = [...list.slice(0, i + 1)].reverse().find((x) => x.note)?.note || "";
    await shot(`<div class="p">${body}<div class="note">${note}</div><div class="foot">${FOOT}</div></div>`, String(i).padStart(2, "0"));
  }
  await ctx.close();
  return list.length;
}
