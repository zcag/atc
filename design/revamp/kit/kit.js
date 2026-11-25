const P = {
  back: '<path d="M10 3 5 8l5 5"/>',
  fwd: '<path d="m6 3 5 5-5 5"/>',
  down: '<path d="m3 6 5 5 5-5"/>',
  more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h0M2.5 8h0M2.5 12h0"/>',
  page: '<path d="M4 2h5.5L12 4.5V14H4z"/><path d="M6 7h4M6 9.5h4M6 12h2.5"/>',
  mic: '<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.8 8a4.2 4.2 0 0 0 8.4 0M8 12.2V14"/>',
  phone: '<path d="M4.5 2.5h2l1 3-1.5 1a7 7 0 0 0 3.5 3.5l1-1.5 3 1v2a1.5 1.5 0 0 1-1.5 1.5A10.5 10.5 0 0 1 3 4a1.5 1.5 0 0 1 1.5-1.5z"/>',
  pin: '<path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6zM8 8.5V14"/>',
  term: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m5 6.5 2 1.5-2 1.5M8.5 10h3"/>',
  attach: '<path d="M12.5 7.5 7.8 12.2a2.8 2.8 0 0 1-4-4l5-5a1.9 1.9 0 0 1 2.7 2.7L6.6 10.8a.9.9 0 0 1-1.3-1.3L9.8 5"/>',
  send: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>',
  zen: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  warn: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.3v0"/>',
  off: '<path d="M2 2l12 12M5.5 5.6A3.5 3.5 0 0 0 4.5 12H11M7 4.1A4 4 0 0 1 12 7.5a2.3 2.3 0 0 1 1.6 3.8"/>',
  link: '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.8.8M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.8-.8"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.3"/><path d="M10.5 3.5v-.3A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1a1.2 1.2 0 0 0 1.2 1.2h.3"/>',
  out: '<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  keys: '<rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M4 7h0M6.5 7h0M9 7h0M11.5 7h0M5 10h6"/>',
  undo: '<path d="M5.5 5H10a3.5 3.5 0 0 1 0 7H6M5.5 5l2.5-2.5M5.5 5 8 7.5"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7a4 4 0 0 1-4 4h-1.5"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/>',
  board: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12M6 6v7.5"/>',
  shell: '<path d="m3 5 3 3-3 3M8 11.5h5"/>',
  user: '<circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14a5.2 5.2 0 0 1 10.4 0"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  upload: '<path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>',
  file: '<path d="M4 2h5.5L12 4.5V14H4z"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  chart: '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V7"/>',
  inbox: '<path d="M2 9.5 4 3h8l2 6.5V13H2zM2 9.5h3.5L6.5 11h3l1-1.5H14"/>',
};
const params = new URLSearchParams(location.search);
if (params.has('dark')) document.documentElement.dataset.scheme = 'dark';
if (params.has('light')) document.documentElement.dataset.scheme = 'light';
const draw = () => document.querySelectorAll('i[data-i]').forEach((el) => {
  const svg = `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${P[el.dataset.i] || P.x}</svg>`;
  el.outerHTML = svg;
});
draw();
window.kitIcons = P;
window.kitDraw = draw;
