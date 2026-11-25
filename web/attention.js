export const TICK = 5, HOT = 60, BRIDGE = 180, KEEP = 14 * 60;

// Which 5-second slots to count for what is open. A pause of up to BRIDGE seconds counts once input returns;
// a longer one counts its first HOT seconds. `left` is a switch away from the page, which ends a pause like input does.
export function attention() {
  let last = 0, held = [];
  const counted = new Map();
  const add = (on, slots) => {
    const e = counted.get(on.sessionId);
    counted.set(on.sessionId, { ...on, slots: [...(e?.slots || []), ...slots] });
  };
  const release = () => { for (const [on, slot] of held) add(on, [slot]); held = []; };
  const stop = () => { held = []; last = 0; };
  return {
    tick(now, { on, here, input }) {
      if (!here || !on) return stop();
      const slot = Math.floor(now / 1000 / TICK), quiet = (now - input) / 1000;
      if (slot === last) return;
      const from = slot - last === 2 ? last + 1 : slot;
      last = slot;
      if (quiet > BRIDGE) { held = []; return; }
      if (quiet <= HOT) release();
      for (let s = from; s <= slot; s++) quiet <= HOT ? add(on, [s]) : held.push([on, s]);
    },
    left(now, input) {
      if ((now - input) / 1000 <= BRIDGE) release();
      stop();
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
