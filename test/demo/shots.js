// Takes the README's raw screens from a running test/demo/run.sh. Run through a browser MCP's
// browser_run_code_unsafe: read this file, eval it, call it with (page, {base, out, modes, only}).
// Each screen gets its own browser context, so it has its own size, pixel ratio and localStorage and
// touches nothing of a logged-in profile. compose.js then lays these out, and encode.sh writes docs/img.
// The Resources screen's live numbers come from the host, so this replaces them for the shot; its charts are seeded.
async (page, { base = "http://127.0.0.1:7399", out = "/tmp/atc-shots", modes = ["dark", "light"], only = null } = {}) => {
  const browser = page.context().browser();
  const MIC = () => {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(), d = c.createMediaStreamDestination();
      g.gain.value = .25; o.frequency.value = 170;
      o.connect(g).connect(d); o.start();
      await c.resume();
      return d.stream;
    };
  };
  const apiCtx = await browser.newContext(), api = apiCtx.request;
  const list = await api.get(`${base}/api/sessions`).then((r) => r.json());
  const setLook = (theme) => api.put(`${base}/api/look`, { data: { scheme: "auto", theme } });
  const by = (t) => list.find((s) => s.title?.startsWith(t));

  async function open(mode, { w = 1560, h = 940, phone = false, dpr = 2 } = {}) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: phone, hasTouch: phone, colorScheme: mode, reducedMotion: "no-preference" });
    const p = await ctx.newPage();
    await p.addInitScript(MIC);
    await p.goto(`${base}/#/`);
    await p.waitForTimeout(1400);
    const notNow = p.getByRole("button", { name: "Not now" });
    if (await notNow.count()) await notNow.click();
    await p.addStyleTag({ content: "::-webkit-scrollbar{display:none} *{scrollbar-width:none}" });
    return p;
  }
  const to = async (p, hash, wait = 1500) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(wait); };
  const say = (p) => p.evaluate(() => document.querySelector(".callp")?.innerText || "");
  const until = (p, re) => p.waitForFunction((s) => new RegExp(s).test(document.querySelector(".callp .st")?.innerText || ""), re.source, { timeout: 60000 });

  const shots = {
    // The hero's window: a session, the page it made, and a call docked beside them.
    async desk(mode) {
      const p = await open(mode, { w: 1760, h: 1000 });
      await p.getByRole("button", { name: /^Call/ }).first().click();
      await p.waitForTimeout(500);
      await to(p, `#/s/${by("Why checkout").id}/p/checkout-latency`, 800);
      await until(p, /hearing/);
      await until(p, /speaking/);
      await p.waitForTimeout(2600);
      return [[p, "desk"]];
    },
    async hold(mode) {
      const p = await open(mode, { w: 412, h: 860, phone: true });
      await to(p, "#/hold");
      return [[p, "hold"]];
    },
    // Three moments of one phone call: the orb changes with what the assistant is doing.
    async call(mode) {
      const p = await open(mode, { w: 412, h: 860, phone: true });
      await to(p, "#/hold", 800);
      await p.locator(".dial").click();
      await until(p, /hearing/);
      await p.waitForTimeout(2600);
      await p.screenshot({ path: `${out}/${mode}/call-hearing.png` });
      await until(p, /working|thinking/);
      await p.waitForTimeout(1400);
      await p.screenshot({ path: `${out}/${mode}/call-tool.png` });
      await until(p, /speaking/);
      await p.waitForTimeout(3200);
      await p.screenshot({ path: `${out}/${mode}/call-speaking.png` });
      return [[p, null]];
    },
    async assistant(mode) {
      const p = await open(mode);
      await to(p, "#/assist", 2200);
      for (const row of await p.locator(".turn.fold, .turnline, [data-folded]").all()) await row.click().catch(() => {});
      await p.waitForTimeout(600);
      return [[p, "assistant"]];
    },
    async board(mode) {
      const p = await open(mode, { h: 1040 });
      await to(p, "#/", 1800);
      return [[p, "board"]];
    },
    async transcript(mode) {
      const p = await open(mode, { h: 1040 });
      await to(p, `#/s/${by("Cart totals").id}`, 2200);
      await p.getByText("src/cart/total.ts").first().click().catch(() => {});
      await p.waitForTimeout(800);
      return [[p, "transcript"]];
    },
    async pages(mode) {
      const p = await open(mode);
      await to(p, "#/pages", 2600);
      return [[p, "pages"]];
    },
    async agents(mode) {
      const p = await open(mode);
      await to(p, "#/agents/reviewer", 2200);
      const q = await open(mode, { w: 900, h: 760 });
      await to(q, "#/p/@reviewer/queue", 2600);
      return [[p, "agents"], [q, "agent-page"]];
    },
    async usage(mode) {
      const p = await open(mode, { h: 1040 });
      await to(p, "#/usage", 2500);
      await p.getByText("30d", { exact: true }).click();
      await p.waitForTimeout(1800);
      return [[p, "usage"]];
    },
    async resources(mode) {
      const p = await open(mode, { h: 1040 });
      const gb = 2 ** 30;
      const row = (t, mem, cpu, name) => {
        const s = by(t);
        return { key: s.sessionId, sessionId: s.sessionId, kind: "session", title: s.title, cpu, mem: mem * gb, read: 0, write: 0, count: 4,
          procs: [{ pid: 4100, ppid: 1, name, cmd: name, cpu, mem: mem * gb, age: 3600 }] };
      };
      await p.route("**/api/resources", async (r) => {
        const res = await r.fetch(), j = await res.json();
        j.machine = { ...j.machine, cores: 12, memTotal: 64 * gb, memUsed: 34 * gb, swapTotal: 8 * gb, swapUsed: 0, load: 6.2, pressure: 0, cpu: 410 };
        j.sessions = [row("Move product images", 9.1, 196, "node"), row("Why checkout", 4.8, 42, "vite"), row("Nightly export", 3.2, 88, "go"),
          row("Try the coupon flow", 2.6, 61, "chromium"), row("Add --json", 2.1, 24, "go")];
        j.left = [{ key: "left", kind: "left", title: "Session unknown", detail: "dev stack", cpu: 12, mem: 5.9 * gb, read: 0, write: 0, count: 3, procs: [{ pid: 3900, ppid: 1, name: "postgres", cmd: "postgres", cpu: 12, mem: 5.9 * gb, age: 90000 }] }];
        j.outside = [];
        await r.fulfill({ response: res, json: j });
      });
      await to(p, "#/resources", 1200);
      await p.getByText("24h", { exact: true }).click();
      await p.waitForTimeout(2600);
      return [[p, "resources"]];
    },
    async browser(mode) {
      const p = await open(mode, { h: 900 });
      await to(p, `#/s/${by("Try the coupon").id}/p/browser`, 3500);
      return [[p, "browser"]];
    },
    async tui(mode) {
      const p = await open(mode, { w: 1240, h: 760 });
      await to(p, `#/s/${by("Broken links").id}`, 1500);
      await p.keyboard.press("`");
      await p.waitForTimeout(4000);
      return [[p, "tui"]];
    },
    async palette(mode) {
      const p = await open(mode, { h: 860 });
      await to(p, "#/", 1200);
      await p.keyboard.press("/");
      await p.waitForTimeout(500);
      await p.keyboard.type("coup");
      await p.waitForTimeout(800);
      return [[p, "palette"]];
    },
    async newsession(mode) {
      const p = await open(mode, { h: 860 });
      await to(p, "#/", 1000);
      await p.keyboard.press("+");
      await p.waitForTimeout(1200);
      return [[p, "new"]];
    },
    async backlog(mode) {
      const p = await open(mode, { h: 760 });
      await to(p, "#/backlog", 1600);
      return [[p, "backlog"]];
    },
    async settings(mode) {
      const p = await open(mode, { h: 680 });
      await to(p, "#/settings", 2000);
      await p.getByRole("heading", { name: "Core" }).first().evaluate((h) => h.scrollIntoView({ block: "start" }));
      await p.waitForTimeout(600);
      return [[p, "settings"]];
    },
    // The same board in every theme; the look is one setting on the server, so it goes back to auto after.
    async themes(mode) {
      const shoot = [];
      for (const theme of ["atc", "frappe", "nord"]) {
        await setLook(theme === "atc" ? "" : theme);
        const q = await open(mode, { w: 1520, h: 800, dpr: 1.5 });
        await to(q, "#/", 1800);
        shoot.push([q, `theme-${theme}`]);
        await q.screenshot({ path: `${out}/${mode}/theme-${theme}.png` });
      }
      await setLook("");
      return shoot.map(([q]) => [q, null]);
    },
    async phones(mode) {
      const p = await open(mode, { w: 412, h: 860, phone: true });
      await to(p, "#/", 1800);
      await p.screenshot({ path: `${out}/${mode}/phone-board.png` });
      await to(p, `#/s/${by("Cart totals").id}`, 2200);
      await p.screenshot({ path: `${out}/${mode}/phone-session.png` });
      await to(p, "#/usage", 2500);
      await p.screenshot({ path: `${out}/${mode}/phone-usage.png` });
      await to(p, "#/assist", 2200);
      await p.screenshot({ path: `${out}/${mode}/phone-assist.png` });
      return [[p, null]];
    },
  };

  const done = [];
  for (const mode of modes) {
    for (const [name, fn] of Object.entries(shots)) {
      if (only && !only.includes(name)) continue;
      try {
        for (const [p, file] of await fn(mode)) {
          if (file) await p.screenshot({ path: `${out}/${mode}/${file}.png` });
          await p.context().close();
        }
        done.push(`${mode}/${name}`);
      } catch (e) {
        done.push(`${mode}/${name} FAILED: ${String(e).slice(0, 300)}`);
      }
    }
  }
  await apiCtx.close();
  return done;
}
