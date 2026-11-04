# Look and themes

Every color, size, radius, shadow and timing in the web UI is a token in `web/tokens.css`;
`style.css` (the app) and `atc.css` (the kit for `atc show` pages) only refer to them.

- **Colors** carry both modes in one line, `--strip: light-dark(oklch(97.6% ...), oklch(16.5% ...))`,
  so light and dark never drift apart. A number that differs by mode reads `--dark` (0 or 1).
  Surfaces: `--strip` (reading: transcript, pages, sheets), `--board` (panes), `--sunk` (bars),
  `--strip-hi` (hover, selected), `--code`; rules `--line`, `--hair`, `--line-strong` (control
  borders, 3:1); text `--ink --dim --faint`, all AA.
- **Color means state, and is spent once**: `--needs` (amber) is the only fill, for "needs you", with
  `--needs-ink` (text on it), `--needs-text` (as text), `--needs-wash`, `--needs-edge`. Your turn is
  `--turn` (= ink), working is `--work` (steel, always with a bar or motion), plus `--fail`,
  `--add`/`--del` (with `-wash` and `-word`), `--live` (calls), `--stop`, `--focus`, `--end` (the end
  call button). `--hot` is an alias of `--needs`. State classes `.needs-you`, `.your-turn` and
  `.working` set `--st` (not inherited), and dots and edges read `var(--st, var(--stop))`.
- **Type** is Recursive (`--sans`, its mono cut `--mono`, its casual cut through
  `font-variation-settings: var(--v-you)` for your own words) and Literata (`--read`) for what an
  agent says. Roles `--fs-micro` (11) `--fs-small` (12) `--fs-ui` (13) `--fs-body` (14) `--fs-title`
  (16) `--fs-read` (17.5) `--fs-lead` (19) `--fs-h` (22) `--fs-display` (30), all multiplied by
  `--text-scale`; the older `--fs-3xs` to `--fs-hero` remain for pages that use them.
- **Spacing** is a 4px scale, `--s1` (4) to `--s7` (48), multiplied by `--density` (`--sp-1..12`
  remain as aliases). **Radii** `--r-sm` (3) and `--r-md` (5) (the older names point at these),
  **shadows** `--shadow-pop` and `--shadow-sheet`, **motion** `--t-fast/--t/--t-slow` with `--ease`.
  Chart series are `--series-1..5`.
- **Project hue**: an element with `--ph` (set from the project name) gets `--pc` (ink), `--pb`
  (tint) and `--pcs` (soft), from the `--proj-*` recipe tokens.
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
