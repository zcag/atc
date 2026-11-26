const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");
const ms = (t) => (t instanceof Date ? +t : typeof t === "number" ? t : Date.parse(t || "") || 0);
const dayNo = (d) => Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);

export const age = (t, now = Date.now()) => {
  const at = ms(t);
  if (!at) return "";
  const s = Math.max(0, (now - at) / 1000);
  return s < 45 ? "now" : s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h`
    : s < 14 * 86400 ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 604800)}w`;
};

export const clock = (t, seconds) => {
  const at = ms(t);
  if (!at) return "";
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
};

export const weekday = (t) => WD[new Date(ms(t)).getDay()];

export const date = (t, now = Date.now()) => {
  const d = new Date(ms(t));
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`}`;
};

export const day = (t, now = Date.now()) => (ms(t) ? `${weekday(t)} ${date(t, now)}` : "");

const near = (t, now) => Math.abs(dayNo(new Date(ms(t))) - dayNo(new Date(now))) < 7;

export const stamp = (t, now = Date.now()) => (ms(t) ? `${near(t, now) ? weekday(t) : date(t, now)} ${clock(t)}` : "");

export const today = (t, now = Date.now()) => ms(t) > 0 && dayNo(new Date(ms(t))) === dayNo(new Date(now));

export const at = (t, now = Date.now()) => (today(t, now) ? clock(t) : stamp(t, now));

export const duration = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};
