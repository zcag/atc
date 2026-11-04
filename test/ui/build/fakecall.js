let st = { phase: "idle", since: 0, muted: false, why: "" };
let face = { state: "listening", hearing: "", you: "", said: "", tool: "" };
const subs = new Set();
const emit = () => subs.forEach((f) => f());
const t0 = performance.now();
const wave = () => { const t = (performance.now() - t0) / 1000; return Math.abs(Math.sin(t * 9) * Math.sin(t * 2.3)) * 0.9 + 0.05; };

export const Call = {
  get: () => st,
  face: () => face,
  live: () => st.phase === "calling" || st.phase === "active",
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  levels: () => [face.state === "hearing" && !st.muted ? wave() : 0.02, face.state === "speaking" ? wave() : 0.02],
  speech: () => [0, 0, 0],
  supported: () => true,
  dial() {
    window.__dialed = (window.__dialed || 0) + 1;
    st = { ...st, phase: "active", since: Date.now() - 134000, why: "" };
    face = { state: "speaking", hearing: "", you: "Start the orders one on the laptop. And tell the dialogs session: Back closes the dialog first.", said: "Starting #102 on the laptop in a worktree now, then I'll pass your answer to the dialogs session", tool: "" };
    emit();
  },
  hangup() { window.__hungup = (window.__hungup || 0) + 1; st = { ...st, phase: "ended", why: "you hung up" }; emit(); },
  mute() { st = { ...st, muted: !st.muted }; emit(); },
  interrupt() {},
};
window.__call = { set(p, f) { st = { ...st, ...p }; if (f) face = { ...face, ...f }; emit(); } };
