// What the time page counts, end to end: each scenario starts a private atc, drives a browser on a fake clock and reads back what was recorded.
// node test/ui/build/timecount.mjs ./atc  (playwright-core on NODE_PATH, CHROME_BIN for the browser; uses ports 17311 and 19222)
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const BIN = path.resolve(process.argv[2] || "./atc");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atc-timecount-"));
const PORT = 17311, CDP = 19222, URL0 = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function server(name, browserOwner) {
  const home = `${TMP}/${name}`;
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(`${home}/.config/atc`, { recursive: true });
  fs.mkdirSync(`${home}/bin`, { recursive: true });
  fs.writeFileSync(`${home}/.config/atc/token`, "t\n");
  for (const b of ["systemctl", "claude", "tailscale", "journalctl"]) fs.writeFileSync(`${home}/bin/${b}`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  if (browserOwner) fs.writeFileSync(`${home}/.config/atc/browser.json`, JSON.stringify({ [browserOwner]: { session: "s1", at: new Date().toISOString() } }));
  const env = { HOME: home, PATH: `${home}/bin`, ATC_ADDR: `127.0.0.1:${PORT}`, ATC_SUMMARY: "off", TZ: "Europe/Istanbul" };
  if (browserOwner) env.ATC_BROWSER = `http://127.0.0.1:${CDP}`;
  const p = spawn(BIN, ["serve"], { env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(`${URL0}/api/me`); break; } catch { await sleep(100); } }
  return { home, stop: () => new Promise((r) => { p.on("exit", r); p.kill(); }) };
}

const counted = (home) => {
  const dir = `${home}/.config/atc/time`, by = {};
  if (!fs.existsSync(dir)) return by;
  for (const f of fs.readdirSync(dir)) for (const l of fs.readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    by[r.s] = (by[r.s] || 0) + r.n * 5;
  }
  return by;
};
const total = (by) => Object.values(by).reduce((a, b) => a + b, 0);

let browser;
async function page(ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ...ctxOpts });
  await ctx.addInitScript(() => sessionStorage.setItem("atc.setup.skip", "1"));
  const p = await ctx.newPage();
  await p.clock.install({ time: Date.now() - 12 * 60000 });
  await p.goto(`${URL0}/?token=t#/time`);
  await p.clock.runFor(3000);
  await p.waitForTimeout(500);
  await p.clock.runFor(2000);
  return p;
}
const flush = async (p) => { await p.clock.runFor(31000); await p.waitForTimeout(400); };
// steps of 5 s, calling act(i) before each; i counts 5-second steps
async function steps(p, n, act) { for (let i = 0; i < n; i++) { if (act) await act(i); await p.clock.runFor(5000); } }
const wiggle = (p) => { let k = 0; return () => p.mouse.move(200 + (k++ % 50) * 3, 300); };

const results = [];
async function scenario(name, expect, run, owner) {
  const s = await server(name, owner);
  let got, note = "";
  try { ({ got, note = "" } = await run(s)); } catch (e) { got = "error"; note = e.message.split("\n")[0]; }
  await s.stop();
  const ok = typeof expect === "function" ? expect(got) : got === expect;
  results.push({ name, got, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)} ${note}`);
}

browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox", `--remote-debugging-port=${CDP}`] });
const near = (want, slack = 10) => (g) => typeof g === "number" && Math.abs(g - want) <= slack;

await scenario("input every 10 s for 2 min, then 2 min idle", near(150), async (s) => {
  const p = await page(); const w = wiggle(p);
  await steps(p, 24, (i) => i % 2 === 0 && w());
  await steps(p, 24); await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("one click, then 2 min idle", near(32, 6), async (s) => {
  const p = await page();
  await p.mouse.click(600, 120);
  await steps(p, 24); await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("mouse events at the same spot for 2 min", near(32, 6), async (s) => {
  const p = await page();
  await p.mouse.move(300, 300);
  await steps(p, 24, () => p.evaluate(() => window.dispatchEvent(new MouseEvent("mousemove", { screenX: 300, screenY: 300 }))));
  await steps(p, 24, () => p.mouse.move(300, 300)); await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("page streaming and scrolling by itself for 2 min", near(32, 6), async (s) => {
  const p = await page();
  await p.mouse.click(600, 120);
  await steps(p, 24, () => p.evaluate(() => { const d = document.createElement("div"); d.style.height = "200px"; d.textContent = "x"; document.querySelector(".scroll")?.append(d); document.querySelector(".scroll")?.scrollBy(0, 200); window.scrollBy(0, 50); }));
  await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("script-made keys and clicks for 2 min", near(32, 6), async (s) => {
  const p = await page();
  await p.mouse.click(600, 120);
  await steps(p, 24, () => p.evaluate(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })); window.dispatchEvent(new PointerEvent("pointerdown")); window.dispatchEvent(new WheelEvent("wheel")); }));
  await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("page left open, nobody touches it, for 2 min", near(0, 0), async (s) => {
  const p = await page();
  await steps(p, 24); await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("input while the page is hidden", near(0, 0), async (s) => {
  const p = await page();
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { get: () => "hidden" }); document.hasFocus = () => false; });
  const w = wiggle(p);
  await steps(p, 24, (i) => i % 2 === 0 && w()); await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("input only inside a shown page (iframe) for 2 min", near(150), async (s) => {
  const p = await page();
  await p.evaluate(() => { const f = document.createElement("iframe"); f.srcdoc = '<script src="/atc.js"></script><div style="height:3000px">page</div>'; f.style = "position:fixed;left:0;top:0;width:900px;height:700px;z-index:99999;background:white"; document.body.append(f); });
  await p.clock.runFor(1000); await p.waitForTimeout(500);
  let k = 0;
  await steps(p, 24, (i) => i % 2 === 0 && p.mouse.move(100 + (k++ % 40) * 5, 200));
  await steps(p, 24);
  const inFrame = await p.evaluate(() => document.activeElement?.tagName);
  await flush(p); await p.context().close();
  return { got: total(counted(s.home)), note: `(focus on ${inFrame})` };
});

await scenario("server unreachable for the first 90 s of 2 min of input", near(150), async (s) => {
  const p = await page();
  await p.route("**/api/time", (r) => r.abort());
  const w = wiggle(p);
  await steps(p, 18, (i) => i % 2 === 0 && w());
  await p.unroute("**/api/time");
  await steps(p, 6, (i) => i % 2 === 0 && w());
  await steps(p, 24); await flush(p); await p.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("two devices active at the same time for 2 min", near(150), async (s) => {
  const a = await page(), b = await page();
  const t0 = await a.evaluate(() => Date.now());
  await b.clock.setSystemTime(t0);
  const wa = wiggle(a), wb = wiggle(b);
  for (let i = 0; i < 48; i++) {
    if (i < 24 && i % 2 === 0) { await wa(); await wb(); }
    await a.clock.runFor(5000); await b.clock.runFor(5000);
  }
  await flush(a); await flush(b); await a.context().close(); await b.context().close();
  return { got: total(counted(s.home)) };
});

await scenario("1 min on the board, then 1 min on Time, input throughout", (g) => g && Math.abs(g["screen:board"] - 60) <= 10 && Math.abs(g["screen:time"] - 90) <= 10, async (s) => {
  const p = await page();
  await p.evaluate(() => { location.hash = "#/"; }); await p.clock.runFor(1000);
  const w = wiggle(p);
  await steps(p, 12, (i) => i % 2 === 0 && w());
  await p.evaluate(() => { location.hash = "#/time"; }); await p.clock.runFor(100);
  await steps(p, 12, (i) => i % 2 === 0 && w());
  await steps(p, 12); await flush(p); await p.context().close();
  return { got: counted(s.home) };
});

{
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem("atc.setup.skip", "1"));
  const q = await ctx.newPage();
  const id = (await (await ctx.newCDPSession(q)).send("Target.getTargetInfo")).targetInfo.targetId;
  await scenario("atc open in a session's browser tab, with input", near(0, 0), async (s) => {
    await q.clock.install({ time: Date.now() - 12 * 60000 });
    await q.goto(`${URL0}/?token=t#/time`);
    await q.clock.runFor(5000);
    const w = wiggle(q);
    await steps(q, 24, (i) => i % 2 === 0 && w()); await flush(q);
    const present = await (await fetch(`${URL0}/api/presence?local=1`, { headers: { Authorization: "Bearer t" } })).json();
    return { got: total(counted(s.home)), note: `(presence active: ${present.active})` };
  }, id);
  await ctx.close();
}

{
  await scenario("focus inside a shown page still counts as atc focused", near(150), async (s) => {
    const p = await page();
    await p.evaluate(() => { const f = document.createElement("iframe"); f.srcdoc = '<script src="/atc.js"></script><input id=i><div style="height:3000px">page</div>'; f.style = "position:fixed;left:0;top:0;width:900px;height:700px;z-index:99999;background:white"; document.body.append(f); });
    await p.clock.runFor(1000); await p.waitForTimeout(500);
    await p.mouse.click(50, 15);
    const where = await p.evaluate(() => [document.activeElement?.tagName, document.hasFocus()]);
    let k = 0;
    await steps(p, 24, (i) => i % 2 === 0 && p.keyboard.type("ab"));
    await steps(p, 24); await flush(p); await p.context().close();
    return { got: total(counted(s.home)), note: `(focus ${where})` };
  });
}

await browser.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
