const SPEED = 900, RISE = 0.06, FALL = 0.09, MIN_HOLD = 0.09, STILL_STEP = 100, REST = 8, MOVED_ELSEWHERE = 2, LONGEST_FRAME = 0.05;

export const GLIDE_KEYS = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };

export function glider(el, { frame = requestAnimationFrame, still = () => matchMedia("(prefers-reduced-motion: reduce)").matches } = {}) {
  let code = null, dir = 0, heldFor = 0, v = 0, pos = 0, last = null, running = false;

  const tick = (t) => {
    if (!running) return;
    const dt = last === null ? 0 : Math.min((t - last) / 1000, LONGEST_FRAME);
    last = t;
    heldFor += dt;
    const pushing = code !== null || heldFor < MIN_HOLD;
    v += ((pushing ? dir * SPEED : 0) - v) * (1 - Math.exp(-dt / (pushing ? RISE : FALL)));
    if (Math.abs(el.scrollTop - pos) > MOVED_ELSEWHERE) pos = el.scrollTop;
    const max = el.scrollHeight - el.clientHeight, to = pos + v * dt;
    pos = Math.max(0, Math.min(max, to));
    el.scrollTop = pos;
    if (!pushing && (Math.abs(v) < REST || pos !== to)) return stop();
    frame(tick);
  };
  const stop = () => { running = false; code = null; v = 0; last = null; };

  return {
    press(d, key, repeat) {
      if (still()) { el.scrollTop += d * STILL_STEP; return; }
      if (repeat && running) return;
      code = key; dir = d; heldFor = 0;
      if (running) return;
      running = true; pos = el.scrollTop;
      frame(tick);
    },
    release(key) { if (key === code) code = null; },
    stop,
  };
}
