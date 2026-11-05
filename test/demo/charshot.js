// Shoots the assistant with a character on a call in the browser: run.sh with DEMO_LINE=real and DEMO_PERSONAS, voice-stack.sh.
// Set the person in persons.json first. The microphone plays a made-up caller's clip so the character hears, thinks and speaks. Run like shots.js, with
// (page, {base, hub, clips, out, mode, who}).
async (page, { base = "http://127.0.0.1:7431", hub = "http://127.0.0.1:7432", clips = "http://127.0.0.1:7440/clips", out = "/tmp/atc-shots", mode = "dark", who = "june", w = 1400, h = 900 } = {}) => {
  const browser = page.context().browser();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: mode });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = new AudioContext(), d = c.createMediaStreamDestination();
      await c.resume();
      window.__say = async (url) => {
        const s = c.createBufferSource();
        s.buffer = await c.decodeAudioData(await (await fetch(url)).arrayBuffer());
        s.connect(d);
        s.start();
      };
      return d.stream;
    };
  });
  const status = () => p.evaluate(() => document.querySelector(".callp .st")?.innerText || "");
  const until = async (re, ms = 40000) => { for (const end = Date.now() + ms; Date.now() < end; await p.waitForTimeout(150)) if (re.test(await status())) return true; return false; };
  const shots = [];
  const snap = async (name) => { await p.screenshot({ path: `${out}/${mode}/${name}.png` }); shots.push(name); };
  await p.goto(`${base}/#/assist`);
  await p.waitForTimeout(2500);
  const notNow = p.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.click();
  await ctx.request.post(`${hub}/message`, { data: { channel: "phone", text: "(next: slow)" } }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.getByRole("button", { name: /^Call/ }).first().click();
  await until(/speaking|listening/);
  await p.waitForTimeout(2500);
  await until(/listening/, 12000);
  await p.waitForTimeout(1200);
  await snap(`assist-${who}-listening`);
  const blob = await (await ctx.request.get(`${clips}/3.wav`)).body();
  await p.route("**/__clip.wav", (r) => r.fulfill({ body: blob, contentType: "audio/wav" }));
  await p.evaluate(() => window.__say("/__clip.wav"));
  await until(/hearing/, 8000);
  await p.waitForTimeout(800);
  await snap(`assist-${who}-hearing`);
  await until(/thinking/, 8000);
  await p.waitForTimeout(900);
  await snap(`assist-${who}-thinking`);
  await p.waitForTimeout(700);
  await snap(`assist-${who}-thinking2`);
  await until(/speaking/, 8000);
  await until(/thinking|working/, 6000);
  await until(/speaking/, 8000);
  await p.waitForTimeout(1500);
  await snap(`assist-${who}-speaking`);
  await ctx.close();
  return shots;
}
