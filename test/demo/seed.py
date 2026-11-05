"""Fills $HOME with a fake Claude Code state: transcripts, its session list, atc's own files."""
import json
import math
import os
import random
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path(os.environ["HOME"])
CLAUDE = HOME / ".claude"
ATC = HOME / ".config" / "atc"
NOW = datetime.now(timezone.utc)
OPUS, SONNET = "claude-opus-5-5", "claude-sonnet-4-5"

SHOP, CLI, DOCS = "/home/you/code/shop", "/home/you/code/tally", "/home/you/code/docs"
ASSIST = str(HOME / ".local/share/atc/assistant")

agents, meta, summaries, pages, page_state = [], {}, {}, {}, {}
HUB = ""
ticking = []


def stamp(ago):
    return (NOW - timedelta(seconds=ago)).isoformat().replace("+00:00", "Z")


class Session:
    def __init__(self, title, cwd, branch="main", model=OPUS, ago=3600):
        self.sid = str(uuid.uuid4())
        self.id = self.sid[:8]
        self.title, self.cwd, self.branch, self.model = title, cwd, branch, model
        self.ago = ago
        self.ctx = 18000
        self.out, self.written = 380, 900
        self.reply = ""
        self.lines = []
        self.emit({"type": "permission-mode", "permissionMode": "default"})
        self.emit({"type": "ai-title", "aiTitle": title})

    def emit(self, e, step=0):
        self.ago = max(self.ago - step, 1)
        self.lines.append({"cwd": self.cwd, "gitBranch": self.branch, "sessionId": self.sid,
                           "uuid": str(uuid.uuid4()), "timestamp": stamp(self.ago), **e})
        return self.lines[-1]["uuid"]

    def user(self, text, wait=240):
        self.emit({"type": "last-prompt", "lastPrompt": text})
        return self.emit({"type": "user", "promptId": str(uuid.uuid4()),
                          "message": {"role": "user", "content": text}}, wait)

    def assistant(self, content, step):
        self.ctx += 1400
        return self.emit({"type": "assistant", "message": {
            "id": "msg_" + uuid.uuid4().hex[:20], "role": "assistant", "model": self.model, "content": content,
            "usage": {"input_tokens": 6, "output_tokens": self.out, "cache_read_input_tokens": self.ctx, "cache_creation_input_tokens": self.written},
        }}, step)

    def say(self, text, step=25):
        self.reply = self.assistant([{"type": "text", "text": text}], step)

    def call(self, name, args, step=12):
        tid = "toolu_" + uuid.uuid4().hex[:20]
        self.assistant([{"type": "tool_use", "id": tid, "name": name, "input": args}], step)
        return tid

    def tool(self, name, args, out, error=False, result=None, step=12):
        tid = self.call(name, args, step)
        self.emit({"type": "user", "toolUseResult": result or {},
                   "message": {"role": "user", "content": [
                       {"type": "tool_result", "tool_use_id": tid, "content": out, "is_error": error}]}}, 3)

    def read(self, path, body):
        n = body.count("\n") + 1
        self.tool("Read", {"file_path": f"{self.cwd}/{path}"}, body,
                  result={"file": {"numLines": n, "startLine": 1, "totalLines": n}})

    def grep(self, pattern, out):
        self.tool("Grep", {"pattern": pattern, "path": self.cwd}, out)

    def edit(self, path, old, new):
        self.tool("Edit", {"file_path": f"{self.cwd}/{path}", "old_string": old, "new_string": new},
                  f"The file {self.cwd}/{path} has been updated.")

    def bash(self, cmd, out, error=False, step=20):
        self.tool("Bash", {"command": cmd}, out, error, step=step)

    def done(self, ms=184000):
        self.emit({"type": "system", "subtype": "turn_duration", "durationMs": ms})

    def summary(self, status, gist=(), replies=()):
        summaries[self.sid] = {"reply": self.reply, "status": status, "gist": list(gist), "replies": list(replies),
                               "model": "haiku", "at": stamp(self.ago)}

    def write(self):
        d = CLAUDE / "projects" / self.cwd.replace("/", "-")
        d.mkdir(parents=True, exist_ok=True)
        self.path = d / f"{self.sid}.jsonl"
        self.path.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in self.lines))
        Path(self.cwd).mkdir(parents=True, exist_ok=True)

    def live(self, state, status=None, kind="background", job=None, pid=True, agent=None, parked=False, reports=None, engine=None, pinned=False):
        self.write()
        p = subprocess.Popen(["sleep", "86400"], start_new_session=True).pid if pid else 0
        agents.append({"id": self.id, "sessionId": self.sid, "pid": p, "cwd": self.cwd, "kind": kind,
                       "name": "", "state": state, "status": status or state,
                       "startedAt": int((NOW - timedelta(hours=2)).timestamp() * 1000)})
        if job:
            d = CLAUDE / "jobs" / self.id
            d.mkdir(parents=True, exist_ok=True)
            (d / "state.json").write_text(json.dumps(job))
        if reports and state == "working":
            ticking.append(str(self.path))
        if agent or parked or reports or engine or pinned:
            meta[self.sid] = {"agent": agent or "", "parked": parked, "reportsTo": reports or "", "engine": engine or "", "pinned": pinned}


def checkout():
    s = Session("Cart totals one cent off", SHOP, "fix/cart-rounding", ago=1500)
    s.user("Carts in EUR are sometimes one cent off the sum of their lines. Customers noticed on the invoice. Find it, fix it, add a test.")
    s.say("I'll start with how the cart adds up its totals.", 20)
    s.grep("cartTotal", "src/cart/total.ts:12:export function cartTotal(lines: Line[], fx: Rate): Money {\nsrc/checkout/summary.tsx:8:import { cartTotal } from '../cart/total'\ntest/cart/total.test.ts:3:import { cartTotal } from '../../src/cart/total'")
    s.read("src/cart/total.ts", "import { Line, Money, Rate } from './types'\n\n// Totals are computed in the customer's currency.\nconst toCents = (n: number) => Math.round(n * 100)\n\nexport function lineTotal(line: Line, fx: Rate): number {\n  return line.unitPrice * line.qty * fx.rate\n}\n\nexport function cartTotal(lines: Line[], fx: Rate): Money {\n  const sum = lines.reduce((acc, l) => acc + lineTotal(l, fx), 0)\n  return { cents: toCents(sum), currency: fx.to }\n}")
    s.say("`cartTotal` adds unrounded line totals and rounds once at the end, while the invoice rounds every line. Two lines of 3.335 give 6.67 here and 6.68 on the invoice. I'll confirm with a failing test first.")
    s.edit("test/cart/total.test.ts", "describe('cartTotal', () => {\n", "describe('cartTotal', () => {\n  it('adds rounded lines, as the invoice does', () => {\n    const lines = [{ unitPrice: 3.335, qty: 1 }, { unitPrice: 3.335, qty: 1 }]\n    expect(cartTotal(lines, EUR).cents).toBe(668)\n  })\n\n")
    s.bash("npm test -- test/cart/total.test.ts", "FAIL test/cart/total.test.ts > cartTotal > adds rounded lines, as the invoice does\nAssertionError: expected 667 to be 668\n\nTest Files  1 failed (1)\nTests  1 failed | 11 passed (12)", error=True)
    s.say("That reproduces it. The fix is to round each line in the customer's currency before adding.")
    s.edit("src/cart/total.ts", "export function lineTotal(line: Line, fx: Rate): number {\n  return line.unitPrice * line.qty * fx.rate\n}\n\nexport function cartTotal(lines: Line[], fx: Rate): Money {\n  const sum = lines.reduce((acc, l) => acc + lineTotal(l, fx), 0)\n  return { cents: toCents(sum), currency: fx.to }\n}", "export function lineCents(line: Line, fx: Rate): number {\n  return toCents(line.unitPrice * line.qty * fx.rate)\n}\n\nexport function cartTotal(lines: Line[], fx: Rate): Money {\n  const cents = lines.reduce((acc, l) => acc + lineCents(l, fx), 0)\n  return { cents, currency: fx.to }\n}")
    s.edit("src/checkout/summary.tsx", "const shown = formatMoney(lineTotal(line, fx), fx.to)", "const shown = formatMoney(lineCents(line, fx) / 100, fx.to)")
    s.bash("npm test", "Test Files  38 passed (38)\nTests  412 passed (412)\nDuration  6.41s")
    s.bash("npm run build", "vite v6.0.7 building for production...\n412 modules transformed.\nbuilt in 3.22s")
    s.bash("node scripts/compare-invoices.mjs --last 30d > out/rounding.csv", "")
    s.bash('atc show out/rounding.html --note "Orders whose total changes"',
           'Showing "One cent off: what changes" (rounding) in atc, live from ~/code/shop/out/rounding.html.')
    s.bash('git add -A && git commit -qm "Round cart lines before adding, as the invoice does" -v',
           "[fix/cart-rounding 4e1c9ab] Round cart lines before adding, as the invoice does\n 3 files changed, 11 insertions(+), 5 deletions(-)")
    s.say("Fixed and committed on `fix/cart-rounding`.\n\nThe cart now rounds each line before adding, the same way the invoice does, so the two always agree. The new test failed before the change and passes now, and the full suite is green (412 tests).\n\nI ran the old and new totals against the last 30 days of orders: 41 of 18,204 change, each by one cent. The page beside this conversation lists them.\n\nNot pushed yet. Do you want a note for support about the 41 orders?")
    s.done(412000)
    s.summary("Totals now match the invoice; committed, not pushed.",
              ["41 of 18,204 recent orders change, each by one cent.", "Asks whether support needs a note about them."],
              ["Push it", "Draft the note for support"])
    s.live("idle")
    page = HOME / "code/shop/out/rounding.html"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(ROUNDING_PAGE)
    pages[s.sid] = [{"session": s.sid, "name": "rounding", "title": "One cent off: what changes",
                     "path": str(page), "note": "Orders whose total changes", "shown": stamp(s.ago + 40)}]
    return s


ROUNDING_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>One cent off: what changes</title><link rel="stylesheet" href="/atc.css"></head>
<body><main class="pg">
<header class="head"><h1>41 orders change, each by one cent</h1>
<p class="lede">Rounding each line before adding makes the cart agree with the invoice.</p>
<p class="meta"><span>last 30 days</span><span>18,204 orders</span><span>fix/cart-rounding</span></p></header>
<div class="stats"><div><b>41</b><span>orders change</span></div><div><b>0.22<small>%</small></b><span>of all orders</span></div><div><b>0.01</b><span>largest change, EUR</span></div><div><b>0</b><span>invoices disagree now</span></div></div>
<section id="orders"><h2>Orders by currency <small>last 30 days</small></h2>
<table><thead><tr><th>Currency</th><th class="n">Orders</th><th class="n">Changed</th><th>Share</th></tr></thead><tbody>
<tr><td>EUR</td><td class="n">9,812</td><td class="n">27</td><td><span class="dbar" style="--v:66"></span></td></tr>
<tr><td>GBP</td><td class="n">3,377</td><td class="n">9</td><td><span class="dbar" style="--v:22"></span></td></tr>
<tr><td>SEK</td><td class="n">1,204</td><td class="n">5</td><td><span class="dbar" style="--v:12"></span></td></tr>
<tr><td>USD</td><td class="n">3,811</td><td class="n">0</td><td><span class="dbar" style="--v:0"></span></td></tr>
</tbody></table></section>
<section id="change"><h2>The change</h2>
<pre class="diff"><span class="h">src/cart/total.ts</span>
<del>  const sum = lines.reduce((acc, l) =&gt; acc + lineTotal(l, fx), 0)</del>
<del>  return { cents: toCents(sum), currency: fx.to }</del>
<ins>  const cents = lines.reduce((acc, l) =&gt; acc + lineCents(l, fx), 0)</ins>
<ins>  return { cents, currency: fx.to }</ins></pre></section>
<section id="checks"><h2>Checked</h2>
<ul class="checks"><li class="done">New test fails before, passes after</li><li class="done">Full suite: 412 tests</li><li class="done">Build</li><li class="now">Push, once you have read this</li></ul></section>
<p class="foot">From scripts/compare-invoices.mjs, run against the orders export.</p>
</main></body></html>
"""


def coupons():
    s = Session("Coupon codes at checkout", SHOP, "feat/coupons", ago=420)
    s.user("Add coupon codes to checkout: a code field in the summary, percent and fixed discounts, one code per order.")
    s.read("src/checkout/summary.tsx", "export function Summary({ cart, fx }: Props) {\n  const total = cartTotal(cart.lines, fx)\n  return <Totals lines={cart.lines} total={total} />\n}")
    s.edit("src/checkout/coupon.ts", "", "export type Coupon = { code: string; percent?: number; fixedCents?: number }\n\nexport function discount(c: Coupon, cents: number): number {\n  if (c.percent) return Math.round(cents * c.percent / 100)\n  return Math.min(c.fixedCents ?? 0, cents)\n}")
    q = "Should a percent coupon apply before or after shipping?"
    args = {"questions": [{"question": q, "header": "Discount base", "multiSelect": False, "options": [
        {"label": "Before shipping", "description": "Goods only. Shipping is always paid in full."},
        {"label": "After shipping", "description": "The whole order, shipping included."}]}]}
    s.call("AskUserQuestion", args)
    s.live("blocked", reports=HUB, job={"tempo": "blocked", "block": args})
    return s


def images():
    s = Session("Move product images to WebP", SHOP, "chore/webp", SONNET, ago=300)
    s.user("Convert the product images to WebP with a JPEG fallback and update the image component.")
    s.grep("<img", "src/product/gallery.tsx:21:  <img src={photo.url} alt={photo.alt} />\nsrc/product/card.tsx:14:  <img src={product.thumb} alt={product.name} />")
    s.edit("src/product/picture.tsx", "", "export const Picture = ({ src, alt }: Props) => (\n  <picture>\n    <source srcSet={webp(src)} type=\"image/webp\" />\n    <img src={src} alt={alt} loading=\"lazy\" />\n  </picture>\n)")
    s.edit("src/product/gallery.tsx", "<img src={photo.url} alt={photo.alt} />", "<Picture src={photo.url} alt={photo.alt} />")
    s.edit("src/product/card.tsx", "<img src={product.thumb} alt={product.name} />", "<Picture src={product.thumb} alt={product.name} />")
    s.call("Bash", {"command": "node scripts/convert-images.mjs --format webp public/products", "description": "Convert product images"}, 15)
    s.live("working", "busy", reports=HUB)
    return s


def jsonflag():
    s = Session("Add --json to tally report", CLI, "feat/report-json", ago=200)
    s.user("`tally report` should take --json and print the same rows as a stable array. Add it to the docs too.")
    s.read("cmd/report.go", "func runReport(ctx context.Context, opts reportOpts) error {\n\trows, err := store.Rows(ctx, opts.Since)\n\tif err != nil {\n\t\treturn err\n\t}\n\treturn printTable(os.Stdout, rows)\n}")
    s.edit("cmd/report.go", "\treturn printTable(os.Stdout, rows)", "\tif opts.JSON {\n\t\treturn json.NewEncoder(os.Stdout).Encode(rows)\n\t}\n\treturn printTable(os.Stdout, rows)")
    s.bash("go test ./cmd/...", "ok  \texample.dev/tally/cmd\t0.412s")
    s.call("Task", {"description": "Check other commands for the same flag", "prompt": "List the commands that print tables and lack --json.", "subagent_type": "Explore"}, 10)
    s.live("working", "busy", job={"tempo": "active", "fan": [
        {"id": "a1", "kind": "agent", "label": "Check other commands for the same flag", "startedAt": int((NOW - timedelta(seconds=90)).timestamp() * 1000)}]})
    return s


def release():
    s = Session("Release v0.9.0", CLI, ago=700)
    s.user("Cut v0.9.0: changelog from the commits since v0.8.2, tag it, push the tag.")
    s.bash("git log --oneline v0.8.2..HEAD", "c81d0f2 Report: group by week\n9be4471 Import: skip a BOM at the start of a file\n03fa7cd Faster startup with a large ledger")
    s.edit("CHANGELOG.md", "# Changelog\n", "# Changelog\n\n## 0.9.0\n\n- `report --by week`\n- `import` accepts files that start with a BOM\n- Starts faster with a large ledger\n")
    s.bash('git commit -am "Release v0.9.0" && git tag v0.9.0', "[main 7ad20e6] Release v0.9.0\n 1 file changed, 7 insertions(+)")
    s.call("Bash", {"command": "git push origin main v0.9.0", "description": "Push the release and its tag"})
    s.live("blocked", reports=HUB, job={"tempo": "blocked", "needs": "approve Bash: git push origin main v0.9.0"})
    return s


def guide():
    s = Session("Rewrite getting started", DOCS, "guide-rewrite", SONNET, ago=2700)
    s.user("The getting started page is too long and loses people at the config step. Rewrite it around one working example.")
    s.read("content/start.md", "# Getting started\n\nThere are several ways to install...")
    s.edit("content/start.md", "There are several ways to install...", "Install it, make one project, see it run. This takes five minutes.")
    s.bash("npm run build", "Built 214 pages in 4.8s")
    s.bash('git commit -qam "Getting started: one example, top to bottom"', "[guide-rewrite 2f0b6de] Getting started: one example, top to bottom\n 1 file changed, 38 insertions(+), 112 deletions(-)")
    s.say("Rewritten around one example, from 150 lines to 76. Install options and the config reference moved to their own pages, linked at the end. Built without warnings, on `guide-rewrite`.")
    s.done(260000)
    s.summary("Guide rewritten around one example, half the length.", replies=["Open a PR"])
    s.live("idle")
    return s


def links():
    s = Session("Broken links in the API reference", DOCS, "link-check", SONNET, ago=90000)
    s.user("Run a link check over the API reference and fix what is broken.")
    s.bash("npx lychee content/api --no-progress", "42 links checked, 6 errors\ncontent/api/auth.md: 404 /guides/tokens\ncontent/api/webhooks.md: 404 /guides/retries")
    s.say("Six links are broken, all to pages moved in the last restructure. I can redirect the old paths or fix the links; I'll wait until the restructure lands.")
    s.done(70000)
    s.summary("Six broken links found, waiting on the restructure.")
    s.live("idle", parked=True)
    return s


def page(key, name, title, note, ago=120, of=None):
    dst = Path(of or HOME / "code") / "out" / f"{name}.html"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text((HOME / ".demo-pages" / f"{name}.html").read_text())
    pages.setdefault(key, []).append({"session": key, "name": name, "title": title, "path": str(dst), "note": note, "shown": stamp(ago), "updated": stamp(ago)})


def assistant():
    s = Session("assistant", ASSIST, ago=5400)
    s.user("Morning. What's waiting on me, and is anything on fire?", wait=30)
    s.tool("mcp__atc__status", {}, "2 need you: Release v0.9.0 (push the tag), Coupon codes (discount base). 3 working. No machine offline.")
    s.say("Nothing on fire. Two sessions wait on you:\n\n- **Release v0.9.0** wants to push the tag.\n- **Coupon codes at checkout** asks whether discounts apply before or after shipping.\n\nCI on main is green, and @reviewer left one comment on #217 overnight.")
    s.done(14000)
    s.user("Checkout feels slow on phones. Have someone find out why, and get the iOS build green on the laptop while you're at it. Show me what they find.", wait=400)
    s.tool("mcp__atc__start", {"dir": "~/code/shop", "prompt": "Find out why checkout is slow on phones. Report back.", "report": True, "worktree": True}, "Started \"Why checkout is slow on phones\" (3fa81c02 on devbox) in its own worktree.")
    s.tool("mcp__atc__start", {"host": "laptop", "dir": "~/code/shop-ios", "prompt": "The iOS build is red on main. Fix it. Report back.", "report": True}, "Started \"iOS build red on main\" (a07d11e4 on laptop).")
    s.say("Both started. **Why checkout is slow on phones** runs here in its own worktree, **iOS build red on main** on the laptop. I'll tell you what they find.")
    s.done(9000)
    s.tool("mcp__atc__read", {"session": "Why checkout is slow on phones"}, "Found it: moment on the payment step, 1.8 s of the 2.9 s. Page is up. Fix ready on perf/checkout-mobile.", step=900)
    s.bash("atc show out/checkout-latency.html --as checkout-latency", 'Showing "Checkout on phones" (checkout-latency) in atc, live from ~/code/shop/out/checkout-latency.html.')
    s.say("Found it. A date library on the payment step costs **1.8 s of the 2.9 s** on a mid-range phone. Dropping it brings p95 down to **1.3 s**; the chart is beside this, and the fix waits on `perf/checkout-mobile`.\n\nThe iOS build is still running on the laptop. Merge the fix, or should @reviewer look first?")
    s.done(11000)
    s.summary("Checkout fix is ready: p95 on phones 2.9 s to 1.3 s.", replies=["Have @reviewer look first", "Merge it"])
    s.write()
    state = HOME / ".local/state/atc/hub"
    state.mkdir(parents=True, exist_ok=True)
    (state / "session").write_text(s.sid + "\n")
    (state / "home").write_text("atc\n")
    (ATC / "hub.json").write_text(json.dumps({"Session": s.sid}))
    page(s.sid, "checkout-latency", "Checkout on phones", "Where the 2.9 s goes", ago=1000, of=SHOP)
    return s.sid


def checkout_perf(hub):
    s = Session("Why checkout is slow on phones", SHOP, "perf/checkout-mobile", ago=1500)
    s.user("Find out why checkout is slow on phones. Report back.")
    s.bash("npx lighthouse http://localhost:5173/checkout --preset=perf --form-factor=mobile --output=json | jq .audits.bootup-time.displayValue", '"2.9 s"')
    s.grep("from 'moment'", "src/checkout/payment.tsx:4:import moment from 'moment'\nsrc/checkout/expiry.ts:1:import moment from 'moment'")
    s.edit("src/checkout/expiry.ts", "import moment from 'moment'\n\nexport const expired = (m: string, y: string) => moment(`${y}-${m}`).isBefore(moment(), 'month')", "export const expired = (m: string, y: string) => new Date(+y, +m) <= new Date()")
    s.bash("npm test -- test/checkout", "Test Files  9 passed (9)\nTests  87 passed (87)")
    s.bash('git commit -qam "Checkout: drop moment from the payment step" -v', "[perf/checkout-mobile 91c3e07] Checkout: drop moment from the payment step\n 2 files changed, 4 insertions(+), 9 deletions(-)")
    s.bash("atc show out/checkout-latency.html", 'Showing "Checkout on phones" in atc.')
    s.say("The payment step imported all of moment for one month comparison. Without it p95 on a mid-range phone goes from 2.9 s to 1.3 s. Committed on `perf/checkout-mobile`, tests pass, and the page has the numbers.")
    s.done(520000)
    s.summary("Checkout p95 on phones goes from 2.9 s to 1.3 s; fix on a branch.", ["moment cost 1.8 s on the payment step."], ["Open a PR"])
    s.live("idle", reports=hub)
    page(s.sid, "checkout-latency", "Checkout on phones", "Where the 2.9 s goes", ago=1000, of=SHOP)


def browser_tab():
    s = Session("Try the coupon flow in a browser", SHOP, "feat/coupons", ago=240)
    s.user("Walk through checkout with SPRING15 in a real browser and tell me if the totals look right.")
    s.tool("mcp__browser__browser_navigate", {"url": "http://shop.example/checkout"}, "Navigated to the checkout page.")
    s.tool("mcp__browser__browser_type", {"element": "Coupon code", "text": "SPRING15"}, "Typed SPRING15.")
    s.tool("mcp__browser__browser_click", {"element": "Apply"}, "Clicked. The summary now shows 15% off goods.")
    s.call("mcp__browser__browser_snapshot", {}, 8)
    s.live("working", "busy", reports=HUB)
    (ATC / "demo-browser-session").write_text(s.sid + "\n")


def local_model():
    s = Session("Summarize support tickets by theme", DOCS, ago=500, model="qwen3-coder-30b")
    s.user("Group last month's support tickets by theme and say which docs pages would have prevented them.")
    s.bash("python3 scripts/tickets.py --month last | wc -l", "1284")
    s.call("Bash", {"command": "python3 scripts/themes.py --month last", "description": "Cluster tickets by theme"}, 15)
    s.live("working", "busy", engine="qwen")


def scheduler():
    s = Session("Nightly export runs twice after DST", CLI, "fix/dst-export", ago=800)
    s.user("The nightly export ran twice the night clocks changed. Fix the scheduler and add a test that crosses the change.")
    s.read("internal/sched/next.go", "func next(t time.Time, every time.Duration) time.Time {\n\treturn t.Add(every)\n}")
    s.edit("internal/sched/next.go", "\treturn t.Add(every)", "\ty, m, d := t.Date()\n\treturn time.Date(y, m, d+int(every/(24*time.Hour)), t.Hour(), t.Minute(), 0, 0, t.Location())")
    s.call("Bash", {"command": "go test ./internal/sched/... -run DST -v", "description": "Run the DST tests"}, 12)
    s.live("working", "busy", pinned=True)


def reviewer():
    s = Session("Review open pull requests", SHOP, ago=2000)
    s.user("Review what opened since last time.")
    s.bash("gh pr list --state open --json number,title", '[{"number":214,"title":"Search: debounce the query"},{"number":217,"title":"Account: export my data"}]')
    s.say("Two look fine. #217 writes the export to a public bucket path, I left a comment asking for a signed link.")
    s.done(95000)
    s.summary("Two look fine; #217 needs a signed link for the export.")
    s.live("idle", agent="reviewer", parked=True)


def ci():
    s = Session("CI failures on main", CLI, ago=5400)
    s.user("Check the last failed run on main.")
    s.bash("gh run list --branch main --status failure --limit 1", "Flaky: TestImportLargeFile timed out on the macOS runner")
    s.say("One flaky timeout on the macOS runner, passed on retry. Nothing to do.")
    s.done(40000)
    s.summary("One flaky timeout, passed on retry.")
    s.live("idle", agent="ci-watch", parked=True)


def agent_folder(name, **cfg):
    brief = cfg.pop("brief")
    d = ATC / "agents.d" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "agent.json").write_text(json.dumps({"host": "devbox", **cfg}))
    (d / "brief.md").write_text(brief + "\n")


PAST = [("Stripe webhook retries", "Retries now back off and stop after a day."), ("Search index rebuild", "Rebuilt in 4 minutes, no downtime."),
        ("Dark mode on the account page", "Done, using the existing tokens."), ("Flaky upload test", "It raced the temp folder cleanup; fixed."),
        ("Move CI to arm runners", "Runs are 31% cheaper and no slower."), ("Tax rounding for SEK", "Rounds per line now, like the invoice."),
        ("Import: handle a BOM", "Files with a BOM import cleanly."), ("Report: group by week", "Added `--by week` with tests."),
        ("Docs: API auth page", "Rewritten around one curl example."), ("Refund flow copy", "Three screens reworded, support signed off."),
        ("Faster startup with a large ledger", "Startup went from 2.1 s to 240 ms."), ("Upgrade to Vite 6", "Upgraded, the build is 18% faster."),
        ("Session cookie rotation", "Rotates on login and on privilege change."), ("Email templates in MJML", "Six templates moved, all render in Outlook."),
        ("Add OpenTelemetry to the API", "Traces reach the collector; sampling at 5%."), ("Postgres 17 migration plan", "Plan written, one risky index called out."),
        ("Rate limit the public API", "100 per minute per key, with headers."), ("Sitemap generation", "Generated at build, 214 pages."),
        ("Cart page accessibility pass", "Fixed 11 issues, axe is clean."), ("Remove the old feature flags", "Nine flags and 640 lines gone.")]
BAYS = [SHOP, SHOP, SHOP, CLI, CLI, DOCS]


def past_sessions():
    """Ninety days of finished conversations: what Earlier searches and Usage counts."""
    rng = random.Random(7)
    titles = iter([x for _ in range(40) for x in rng.sample(PAST, len(PAST))])
    for day in range(90, 0, -1):
        weekend = (NOW - timedelta(days=day)).weekday() > 4
        for _ in range(rng.choice([1, 1, 2]) if weekend else rng.choice([2, 3, 4, 5])):
            hour = rng.choice([9, 10, 10, 11, 11, 14, 15, 15, 16, 17, 21, 22])
            ago = day * 86400 + (NOW.hour - hour) * 3600 + rng.randint(0, 3000)
            title, said = next(titles)
            s = Session(title, rng.choice(BAYS), ago=ago, model=rng.choice([OPUS, OPUS, OPUS, SONNET]))
            s.user(title + ".", wait=30)
            for _ in range(rng.randint(40, 180)):
                s.ctx, s.out, s.written = rng.randint(60000, 190000), rng.randint(300, 2400), rng.randint(600, 6000)
                s.assistant([{"type": "text", "text": "Working through it."}], 20)
            s.say(said)
            s.done(rng.randint(60000, 900000))
            s.write()


def resource_history():
    """A day of the points atc writes every minute, so the charts have a past."""
    d = ATC / "resources"
    d.mkdir(parents=True, exist_ok=True)
    gb = 1 << 30
    groups = [("session", "Why checkout is slow on phones", 5.2, 90, "vite"), ("session", "Move product images to WebP", 9.5, 520, "node"),
              ("session", "Add --json to tally report", 2.4, 60, "go"), ("session", "Nightly export runs twice after DST", 3.6, 220, "go"),
              ("session", "Try the coupon flow in a browser", 2.8, 110, "chromium"), ("left", "dev stack (outlived its session)", 6.1, 30, "postgres")]
    start = NOW - timedelta(hours=24)
    for m in range(0, 24 * 60, 5):
        t = start + timedelta(minutes=m)
        wave = math.sin(m / 70) * .5 + .5
        rows = []
        for i, (kind, title, mem, cpu, top) in enumerate(groups):
            k = max(0, math.sin(m / (55 + i * 30) + i * 1.3)) ** .6
            mb, c = int(mem * (.5 + .6 * k) * gb), round(cpu * k * (.4 + wave), 1)
            rows.append({"k": str(i), "o": kind, "l": title, "c": c, "m": mb, "p": [{"n": top, "m": mb, "c": c}]})
        row = {"t": int(t.timestamp()), "cpu": round(sum(r["c"] for r in rows) + 12, 1), "mem": sum(r["m"] for r in rows) + 9 * gb,
               "total": 64 * gb, "ram": 64 * gb, "cores": 12, "g": rows}
        with open(d / (t.strftime("%Y-%m-%d") + ".jsonl"), "a") as f:
            f.write(json.dumps(row) + "\n")


def backlog():
    def item(title, by="", why="", ago=3600, dir=SHOP, status="ready"):
        return {"id": uuid.uuid4().hex[:8], "dir": dir, "title": title, "prompt": title, "status": status, "why": why, "by": by,
                "created": stamp(ago), "updated": stamp(ago), "host": "devbox"}
    (ATC / "backlog.json").write_text(json.dumps([
        item("Support note for the 41 orders that changed", "Cart totals one cent off", ago=1400),
        item("Signed links for the data export", "Review open pull requests", ago=9000),
        item("Remove moment from the rest of the app", "Why checkout is slow on phones", ago=1100),
        item("Ship the WebP images behind a flag", ago=40000),
        item("Retry the macOS runner once before failing", "CI failures on main", dir=CLI, ago=86000),
        item("tally report --by month", dir=CLI, ago=190000),
        item("Fix the six broken links", dir=DOCS, status="blocked", why="the restructure", ago=90000),
        item("Getting started video", dir=DOCS, ago=400000)]))


def main_box():
    global HUB
    ATC.mkdir(parents=True, exist_ok=True)
    HUB = assistant()
    checkout_perf(HUB)
    browser_tab()
    checkout()
    coupons()
    images()
    jsonflag()
    release()
    guide()
    (CLAUDE / "demo-tui").parent.mkdir(parents=True, exist_ok=True)
    (CLAUDE / "demo-tui").write_text(links().id + "\n")
    local_model()
    scheduler()
    reviewer()
    ci()
    past_sessions()
    resource_history()
    backlog()
    for key, name, title, note, ago, state in (
            ("reviewer", "queue", "Review queue", "What is open and what I think", 1800, {"headline": "#217 needs a signed link; 2 fine", "badge": 3}),
            ("ci-watch", "health", "CI health", "Last 14 days on main", 3000, {"headline": "Main is green, one flaky test", "badge": "green"}),
            ("standup", "today", "Today", "Written at 09:00", 5000, {"headline": "4 merged yesterday, 2 wait on you", "badge": 2})):
        page("@" + key, name, title, note, ago, ATC / "agents.d" / key)
        page_state[f"@{key}/{name}"] = state
    agent_folder("reviewer", title="Reviewer", icon="pr", color="violet", dir=SHOP, every="30m", check="gh pr list --search review:none --json number", prompt="Review what opened since last time.", brief="Review new pull requests and comment on what you find.")
    agent_folder("ci-watch", title="CI watch", icon="pulse", color="amber", dir=CLI, every="5m", check="./failed-runs.sh", prompt="A run on main failed. Say what it means.", brief="Look at failed CI runs on main and say what they mean.")
    agent_folder("standup", title="Standup", icon="calendar", color="teal", every="1d", **{"from": "2026-01-05T09:00"}, prompt="Write today's page.", brief="Each morning, write what merged, what is stuck and what waits on the user.")
    agent_folder("deps", title="Dependencies", icon="target", color="green", dir=SHOP, every="1w", prompt="Check for updates worth taking.", brief="Open a session for any dependency update worth taking.")
    (ATC / "presets.json").write_text(json.dumps([{"name": "reviewer", "dir": SHOP, "brief": "REVIEWER.md"}, {"name": "docs writer", "dir": DOCS, "worktree": True}]))
    (ATC / "engines.json").write_text(json.dumps([{"name": "qwen", "model": "qwen3-coder-30b", "url": "http://127.0.0.1:1"}]))
    (ATC / "peers.json").write_text(json.dumps([{"name": "laptop", "url": os.environ["DEMO_PEER"], "token": "demo"}]))
    subprocess.run(["/home/you/.local/bin/atc", "limits", "-tap"], check=True, input=json.dumps({"rate_limits": {
        "five_hour": {"used_percentage": 38, "resets_at": (NOW + timedelta(hours=2, minutes=12)).timestamp()},
        "seven_day": {"used_percentage": 61, "resets_at": (NOW + timedelta(days=3)).timestamp()}}}).encode())


def main_laptop():
    s = Session("iOS build red on main", "/home/laptop/code/shop-ios", "fix/ios-build", ago=900)
    s.user("The iOS build is red on main. Fix it. Report back.")
    s.bash("xcodebuild -scheme Shop -sdk iphonesimulator build 2>&1 | tail -3", "Shop/Checkout/CartView.swift:41:23: error: value of type 'Money' has no member 'cents'\n** BUILD FAILED **", error=True)
    s.edit("Shop/Checkout/CartView.swift", "total.cents", "total.minorUnits")
    s.call("Bash", {"command": "xcodebuild -scheme Shop -sdk iphonesimulator test", "description": "Build and run the iOS tests"}, 8)
    s.live("working", "busy")
    s = Session("Android release notes", "/home/laptop/code/shop-android", ago=4000, model=SONNET)
    s.user("Write the Play Store notes for 3.2 from the merged PRs.")
    s.say("Done, in `fastlane/metadata/en-US/changelogs/320.txt`: faster checkout, coupon codes, and a fix for the blank order screen.")
    s.done(61000)
    s.summary("Play Store notes for 3.2 are written.", replies=["Commit it"])
    s.live("idle")


(main_laptop if sys.argv[1:] == ["laptop"] else main_box)()
(CLAUDE / "jobs").mkdir(parents=True, exist_ok=True)
(CLAUDE / "demo-tick.json").write_text(json.dumps(ticking))
(CLAUDE / "demo-agents.json").write_text(json.dumps(agents))
ATC.mkdir(parents=True, exist_ok=True)
(ATC / "meta.json").write_text(json.dumps(meta))
(ATC / "summaries.json").write_text(json.dumps(summaries))
(ATC / "pages.json").write_text(json.dumps({"pages": pages, "state": page_state}))


