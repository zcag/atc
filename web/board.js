// A project's board: pit (pit.js, copied from zcag/pit by make pit) on this page's atc state.
//
// The state has two writers that never touch each other's keys: agents append to `proposed` through
// atc (atc board add, under the server's lock), and this page owns `cards`, `log` and `seen`. A
// proposed card the page has not seen yet joins the queue the next time the state is read.
import { mountPit, memoryStore } from "/pit.js";

const css = document.createElement("style");
css.textContent = `:root{--pit-scheme:light dark;--pit-bg:var(--board);--pit-surface:var(--strip);--pit-sunk:var(--board);
  --pit-card:var(--strip);--pit-ink:var(--ink);--pit-muted:var(--dim);--pit-faint:var(--faint);--pit-rule:var(--line);
  --pit-hair:var(--line);--pit-spark:var(--needs);--pit-spark-ink:var(--needs-ink);--pit-cold:var(--dim);--pit-dead:var(--faint);
  --pit-font:var(--sans);--pit-mono:var(--mono);--pit-display:var(--mono)}
:root[data-scheme="light"]{--pit-scheme:light}:root[data-scheme="dark"]{--pit-scheme:dark}`;
document.head.append(css);

let seen = new Set();
const fold = (st) => {
  st = st || {};
  const cards = [...(st.cards || [])];
  seen = new Set([...(st.seen || []), ...cards.map((c) => c.id)]);
  for (const p of st.proposed || []) {
    if (seen.has(p.id)) continue;
    cards.push({ ...p, lane: "unsorted" });
    seen.add(p.id);
  }
  return { board: st.board, cards, log: st.log || [] };
};

const store = memoryStore(fold(await atc.state.get()), {
  save: (st) => {
    for (const c of st.cards) seen.add(c.id);
    atc.state.set({ cards: st.cards, log: st.log, seen: [...seen] });
  },
});
// Our own saves come back here too; take the state only when it holds something this page has not:
// an agent's new card, or decisions made on another device.
atc.state.onChange(async () => {
  const st = (await atc.state.get()) || {};
  const fresh = (st.proposed || []).some((p) => !seen.has(p.id)) || (st.log || []).length > store.state().log.length;
  if (fresh) store.replace(fold(st));
});

mountPit(document.querySelector("pit-board"), {
  store,
  who: { me: "you", agent: "an agent" },
  open: (url) => atc.open(url),
  copy: (text) => atc.copy(text),
});
