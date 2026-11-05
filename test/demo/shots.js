// Takes the README's raw screens from a running test/demo/run.sh. Run through a Playwright MCP's
// browser_run_code_unsafe: read this file, eval it, call it with (page, {base, out, modes, only}).
// Each screen gets its own browser context, so it has its own size, pixel ratio and localStorage and
// touches nothing of a logged-in profile. compose.js then lays these out, and encode.sh writes docs/img.
// The Resources screen's live numbers come from the host, so this replaces them for the shot; its charts are seeded.
async (page, { base = "http://127.0.0.1:7399", out = "/tmp/atc-shots", modes = ["dark", "light"], only = null } = {}) => {
  const browser = page.context().browser();
  const apiCtx = await browser.newContext(), api = apiCtx.request;
  const list = await api.get(`${base}/api/sessions`).then((r) => r.json());
  const setLook = (theme) => api.put(`${base}/api/look`, { data: { scheme: "auto", theme } });
  const by = (t) => list.find((s) => s.title?.startsWith(t));

  async function open(mode, { w = 1560, h = 940, phone = false, dpr = 2 } = {}) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: phone, hasTouch: phone, colorScheme: mode, reducedMotion: "no-preference" });
    const p = await ctx.newPage();
    await p.goto(`${base}/#/`);
    await p.waitForTimeout(1400);
    const notNow = p.getByRole("button", { name: "Not now" });
    if (await notNow.count()) await notNow.click();
    await p.addStyleTag({ content: "::-webkit-scrollbar{display:none} *{scrollbar-width:none}" });
    return p;
  }
  const to = async (p, hash, wait = 1500) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(wait); };

  const shots = {
    // The top image: sessions, a transcript and a page, at a size that stays readable at the README's width.
    async hero(mode) {
      const p = await open(mode, { w: 1280, h: 860 });
      await to(p, `#/s/${by("Fix the coupon crash").id}/p/coupon-crash`, 3200);
      await p.getByText("src/checkout/coupon.ts", { exact: true }).last().click();
      await p.waitForTimeout(900);
      await p.evaluate(() => {
        const prompt = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.startsWith("Checkout errors jumped to 8% with deploy 214"));
        let box = prompt;
        while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
        if (box) box.scrollTop += prompt.getBoundingClientRect().top - box.getBoundingClientRect().top - 44;
      });
      await p.waitForTimeout(500);
      return [[p, "hero"]];
    },
    // Working in one project with a peek at another: alt+shift+2 is bay 2's sessions, answerable where they are.
    async bays(mode) {
      const p = await open(mode, { w: 1280, h: 760 });
      await to(p, `#/s/${by("Fix the coupon crash").id}`, 2600);
      await p.keyboard.press("Alt+Shift+Digit2");
      await p.waitForTimeout(900);
      return [[p, "bays"]];
    },
    // The fleet image's front window: @ops's session on the checkout errors and its page.
    async desk(mode) {
      const p = await open(mode, { w: 1760, h: 1000 });
      await to(p, `#/s/${by("Checkout errors").id}/p/checkout-errors`, 3200);
      return [[p, "desk"]];
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
    // The team: the list on its own, each agent's page in its own window.
    async agents(mode) {
      const out = [];
      const l = await open(mode, { w: 620, h: 800, phone: true, dpr: 2 });
      await to(l, "#/agents", 2600);
      out.push([l, "team-list"]);
      for (const [name, pg] of [["shopping", "picks"], ["ops", "alerts"], ["email", "inbox"], ["tracker", "items"], ["invoice", "invoice"], ["reviewer", "queue"]]) {
        const p = await open(mode, { w: ["tracker", "invoice", "reviewer"].includes(name) ? 840 : 620, h: 800, phone: true, dpr: 2 });
        await to(p, `#/p/@${name}/${pg}`, 2400);
        out.push([p, `team-${name}`]);
      }
      return out;
    },
    // Everything at once, for the hero's back window.
    async fleet(mode) {
      const p = await open(mode, { w: 1900, h: 1240 });
      await to(p, "#/", 2400);
      return [[p, "fleet"]];
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
      await to(p, "#/settings/system", 2500);
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
