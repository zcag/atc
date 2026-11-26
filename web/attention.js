export const TICK = 5, HOT = 30, KEEP = 14 * 60;

// Which 5-second slots to count for what is open: those up to HOT seconds after the last input.
export function attention() {
  let last = 0;
  const counted = new Map();
  const add = (on, slots) => {
    const e = counted.get(on.sessionId);
    counted.set(on.sessionId, { ...on, slots: [...(e?.slots || []), ...slots] });
  };
  return {
    tick(now, { on, here, input }) {
      if (!here || !on || (now - input) / 1000 > HOT) { last = 0; return; }
      const slot = Math.floor(now / 1000 / TICK);
      if (slot === last) return;
      add(on, slot - last === 2 ? [last + 1, slot] : [slot]);
      last = slot;
    },
    take(now) {
      const old = Math.floor((now / 1000 - KEEP) / TICK);
      const out = [...counted.values()].map((e) => ({ ...e, slots: e.slots.filter((s) => s > old) })).filter((e) => e.slots.length);
      counted.clear();
      return out;
    },
    back(list) { for (const { slots, ...on } of list) add(on, slots); },
  };
}
