# Look and themes

Every color, size, radius, shadow and timing in the web UI is a token in `web/tokens.css`;
`style.css` (the app) and `atc.css` (the kit for `atc show` pages) only refer to them.

- **Colors** carry both modes in one line, `--strip: light-dark(oklch(97.6% ...), oklch(16.5% ...))`,
  so light and dark never drift apart. A number that differs by mode reads `--dark` (0 or 1).
  Surfaces: `--strip` (reading: transcript, pages, sheets), `--board` (panes), `--sunk` (wells, the
  segmented track), `--chrome` (the bay bar, console and phone tab bar: a step above the canvas in
  dark) with `--chrome-hi` for hover on it, `--strip-hi` (hover, selected), `--code`; rules `--line`,
  `--hair`, `--line-strong` (control
  borders, 3:1); text `--ink --dim --faint`, all AA.
- **Color means state, and is spent once**: `--needs` (amber) is the only fill, for "needs you", with
  `--needs-ink` (text on it), `--needs-text` (as text), `--needs-wash`, `--needs-edge`. Your turn is
  `--turn` (= ink), working is `--work` (steel, always with a bar or motion), plus `--fail`,
  `--add`/`--del` (with `-wash` and `-word`), `--live` (calls), `--stop`, `--focus`, `--end` (the end
  call button). `--hot` is an alias of `--needs`. State classes `.needs-you`, `.your-turn` and
  `.working` set `--st` (not inherited), and dots and edges read `var(--st, var(--stop))`.
- **Type** is Recursive (`--sans`, its mono cut `--mono`, its casual cut through
  `font-variation-settings: var(--v-you)` for your own words) and Literata (`--read`) for what an
  agent says. Eight sizes by role, nothing else: `--fs-micro` (11) `--fs-small` (12) `--fs-ui` (13)
  `--fs-body` (14) `--fs-title` (16) `--fs-read` (17.5) `--fs-h` (22) `--fs-display` (30).
- **Spacing** is `--s1` (4) to `--s7` (48) on a 4px grid. **Radii** `--r1` (4, tags), `--r2` (7,
  controls), `--r3` (10, sheets and popovers) and `--pill` (counts and answer chips only).
  **Shadows** `--pop` (menus, popovers, the palette) and `--pop-up` (bottom sheets). **Motion**
  `--t` (120ms) with `--ease`. Breakpoints are phone (below 900), narrow (below 1200) and wide;
  `BP` in `app.js` names them for script. `make check` fails on a use of a removed token name;
  `atc.css` keeps the old ones (`--fs-xs`, `--sp-*`, `--r-sm`, `--shadow-1`, ...) working for pages.
- **Identity hue**: bays, agents and chart series get one hue each from
  `light-dark(oklch(var(--id-light) h), oklch(var(--id-dark) h))`, the hue picked from the name
  (`hueOf` in `app.js`, skipping the amber, steel and red arcs). An element with `--ph` gets `--pc`
  (the hue), `--pb` (tint) and `--pcs` (soft); `--series-1..5` are five fixed hues from the same
  recipe. A theme tunes it with `--id-light` and `--id-dark`. Identity is a tick or a mark, never a
  fill.
- **Controls**: `.btn` (default), `.btn.primary` (one per view), `.btn.quiet` (toolbars),
  `.btn.icon` or `.icon` (one 16px icon), with `.danger` as a tone on default or primary; 28px on
  desk. `aria-busy="true"`, `.bad` and `.done` draw loading, error and success. Every segmented
  control is `.seg` (or `.nsseg` for a radiogroup): a sunk track with a raised selected cell. Links
  are ink with a quiet underline. Focus is one ring: 2px `--focus`, 2px out.
- **Icons** are one set, `ICON` in `app.js`: 16px grid, 1.5 stroke, round caps (`.i`). An agent's
  `icon` names one of them.
- **The terminal** palette is the `--ansi-*` tokens, read once per theme through the browser, in
  the scheme Claude Code itself uses (`claudeTheme` in `/api/me`).

## Picking a look

Light, dark or the system's setting, and the theme, are picked in the command palette
(Appearance). It is one setting for every device: atc keeps it in `look.json` in its config dir
(`PUT /api/look`, read in `/api/me`), tells open pages over `/api/events`, and passes it on to its
peers, so a change on one machine reaches the others. A page keeps the last one it saw to draw the
first frame before `/api/me` answers.

## Adding a theme

A theme is a file in `web/themes/<name>.css` that overrides tokens under
`:root[data-theme="<name>"]`, plus its name in `THEMES` in `app.js`; `frappe.css` (Catppuccin
Frappé dark, Rosé Pine Dawn light) is the example. Adding one needs no new APK: the page hands the
Android app every theme's colors, light and dark (`AtcApp.setLook`), and the app paints its window,
bars and home-screen widget from them, following the look that arrives with the widget feed
(Android 12 and later; older versions keep the built-in colors).
