import test from "node:test";
import assert from "node:assert/strict";
import { partsOf, prettyName } from "./res-parts.js";

const shop = [
  { pid: 1353510, ppid: 1353397, name: "bundle", cmd: "puma: cluster worker 1: 1353397 [wt-42-feature]", mem: 800, cpu: 1, age: 100 },
  { pid: 1353508, ppid: 1353397, name: "bundle", cmd: "puma: cluster worker 0: 1353397 [wt-42-feature]", mem: 790, cpu: 0, age: 100 },
  { pid: 2133677, ppid: 2133631, name: "claude", cmd: "/home/u/.local/share/claude/versions/2.1.317 --resume x", mem: 355, cpu: 1, age: 900 },
  { pid: 1405391, ppid: 1404833, name: "node-MainThread", cmd: "node /home/u/.npm/_npx/x/node_modules/.bin/playwright-mcp --cdp-endpoint ws://x", mem: 75, cpu: 0, age: 50 },
  { pid: 1404833, ppid: 2133937, name: "npm exec @playw", cmd: "npm exec @playwright/mcp@latest", mem: 52, cpu: 0, age: 50 },
  { pid: 2133631, ppid: 3360067, name: "claude", cmd: "claude bg-pty-host --bg-pty-host /tmp/x", mem: 39, cpu: 0, age: 900 },
  { pid: 1353397, ppid: 1353395, name: "bundle", cmd: "puma 6.4.3 (tcp://0.0.0.0:3020) [wt-42-feature]", mem: 22, cpu: 0, age: 100 },
  { pid: 2133936, ppid: 2133677, name: "atc", cmd: "atc mcp", mem: 10, cpu: 0, age: 900 },
  { pid: 2133937, ppid: 2133677, name: "atc", cmd: "/home/u/.local/bin/atc browser mcp", mem: 9, cpu: 0, age: 900 },
  { pid: 1353395, ppid: 2133677, name: "zsh", cmd: "/usr/bin/zsh -c source /home/u/snapshot.sh", mem: 1, cpu: 0, age: 100 },
];

test("a real session reads by what it runs", () => {
  const parts = partsOf(shop);
  assert.deepEqual(parts.map((p) => [p.name, p.mem, p.procs.length]), [
    ["puma", 1613, 4],
    ["Claude", 394, 2],
    ["Browser tool", 136, 3],
    ["atc tools", 10, 1],
  ]);
  assert.equal(parts[0].port, "3020");
  assert.equal(parts[0].folder, "wt-42-feature");
  assert.equal(parts[0].age, 100);
});

test("every process lands in exactly one part", () => {
  const n = partsOf(shop).reduce((a, p) => a + p.procs.length, 0);
  assert.equal(n, shop.length);
  assert.equal(partsOf(shop).reduce((a, p) => a + p.mem, 0), shop.reduce((a, p) => a + p.mem, 0));
});

test("a parent past the process limit does not lose its child", () => {
  const parts = partsOf([{ pid: 5, ppid: 4, name: "ruby", cmd: "ruby bin/rspec", mem: 10, cpu: 0 }]);
  assert.deepEqual(parts.map((p) => p.name), ["rspec"]);
});

test("a shell with nothing under it says so", () => {
  assert.deepEqual(partsOf([{ pid: 5, ppid: 1, name: "zsh", cmd: "zsh -c sleep", mem: 1, cpu: 0 }]).map((p) => p.name), ["Shell"]);
});

test("names skip the runner", () => {
  const name = (cmd) => prettyName({ name: "x", cmd });
  assert.equal(name("bundle exec rspec spec/a_spec.rb"), "rspec");
  assert.equal(name("/home/u/.venv/bin/python app.py hub"), "app.py");
  assert.equal(name("python -m pytest"), "pytest");
  assert.equal(name("uv run app.py"), "app.py");
  assert.equal(name("/opt/mongodb/bin/mongod --dbpath=/x"), "mongod");
  assert.equal(name("puma: cluster worker 1: 9 [wt]"), "puma");
  assert.equal(name("node --max-old-space-size=4096 /x/server.js"), "server.js");
  assert.equal(prettyName({ name: "fallback", cmd: "" }), "fallback");
});
