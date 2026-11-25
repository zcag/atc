// Every item on the revamp page: what it is, what is wrong today, what it should be.
// cur: screenshots in current/ (private, not in git), mock: files in mocks/, shots in shots/.
window.SECTIONS = [
  ['foundations', 'Foundations', 'The system every screen is drawn from. Fix these and most of the per-screen items get smaller.'],
  ['shell', 'Shell', 'What is on screen everywhere: the bars, the palette, toasts, offline.'],
  ['lists', 'Session lists', 'How you find the session that needs you. You work from the left list; the Board is second.'],
  ['session', 'A session', 'The transcript is the product. Everything here serves reading and answering.'],
  ['screens', 'Other screens', 'New session, Pages, the assistant and the rest.'],
  ['surfaces', 'Beyond the browser', 'The TUI, the CLI, and the Android shell around the page.'],
];

window.ITEMS = [
// ───────────── foundations
{ id: 'tokens', sec: 'foundations', title: 'Tokens and the type scale', effort: 'M',
  job: 'Not a screen: the vocabulary every screen is drawn with. Used by every change anyone makes.',
  today: [
    'Two size scales live side by side: the role scale (<code>--fs-micro</code> to <code>--fs-display</code>) and the older <code>--fs-3xs</code> to <code>--fs-hero</code> (17 steps, some 0.5px apart: 12, 12.5, 13, 13.5). <code>style.css</code> still uses the old one 269 times.',
    'Two spacing scales: <code>--s1..s7</code> and <code>--sp-1..12</code>; transcript.css mixes both.',
    'Radii collapse to two (3, 5) but seven names point at them; shadows likewise (six names, one value).',
    'Hex leftovers next to OKLCH: Tailwind 500s for agent colours (<code>--app-blue: #3b82f6</code> and eight more), hex chart series, hex highlight colours duplicated as <code>--hl-*</code> twice with different values.',
    'Five breakpoints (600, 899, 1099, 1199, 1279) with no names.',
  ],
  prop: [
    'One scale per axis, named by role: type <b>11 12 13 14 16 17.5 22 30</b> (micro, small, ui, body, title, read, h, display); spacing 4 to 48 on a 4pt grid; radii <b>4 / 7 / 10</b> (tag, control, sheet) plus pill for counts only.',
    'Delete the alias layers once callers move; <code>make check</code> fails on a new use of a removed name.',
    'Agent and chart colours come from one OKLCH recipe, <code>light-dark(oklch(58% .11 h), oklch(74% .10 h))</code> with the hue from the name and the amber, steel and red arcs skipped, so they sit in the palette in both modes instead of being Tailwind defaults.',
    'Three named breakpoints: <code>phone &lt; 900</code>, <code>narrow &lt; 1200</code>, <code>wide</code>.',
  ],
  why: 'Every inconsistency below (two button heights, three rounded looks, 12 vs 12.5px text) traces back to having two ways to say the same thing.',
  mock: 'tokens', shots: [['tokens-desk', 'The proposed scale, light and dark']],
  wisp: 'Wisp already uses 4 / 7 / 10 radii and the same <code>cubic-bezier(.2,.7,.2,1)</code>. Take its radius steps; keep atc\'s denser type.' },

{ id: 'color', sec: 'foundations', title: 'Colour in light and dark', effort: 'S',
  job: 'Colour says state and nothing else: amber needs you, steel is working, red failed.',
  deliberate: 'The state language (amber is the only fill, steel only with motion or a bar) is deliberate and good. Keep it.',
  today: [
    'Links and "made" counts are steel blue (<code>1 tab</code>, <code>2 tasks</code>, <code>browser · run code</code>), the same blue as Working. A finished session with a link reads as half working.',
    'Agent monograms are nine Tailwind hues at full saturation; on the Agents page they are the loudest thing on screen.',
    'Dark mode bars (<code>--sunk</code>) are darker than the canvas, so the bay bar and console read as holes, not as chrome.',
    'The Time chart\'s five series colours have no relation to bay identity; the same bay is orange on Time and has no colour anywhere else.',
  ],
  prop: [
    'Links become ink with a quiet underline. Steel blue is reserved for Working.',
    'One identity hue per bay and per agent from the same recipe, used as a 3px tick (never a fill): bay tabs, chart series, agent monograms, page cards.',
    'Dark: bars one step lighter than the canvas, so chrome sits on top.',
  ],
  why: 'You read state at a glance from colour. Every blue that is not Working is a false signal.',
  cur: ['home-1440-light', 'home-1440-dark'], mock: 'color', shots: [['color-desk', 'Light'], ['color-desk-dark', 'Dark']] },

{ id: 'controls', sec: 'foundations', title: 'Buttons, segmented controls and inputs', effort: 'M',
  job: 'Every action in the app. You click fewer than you press, but every screen has them.',
  today: [
    'About 18 button classes: <code>.btn .primary .prime .danger .kb .icon .x .pal-x .clr .link .vlink .chip .opt .pfab .bchip .lchip .htile</code>. <code>primary</code> and <code>prime</code> are two names for one role.',
    'Segmented controls are built five ways (Seg, <code>.seg.wide</code>, radio <code>.nsseg</code>, theme radiogroup, tab buttons), so they look three ways: black fill (Usage, Settings), outlined boxes (Backlog filters), underline tabs (phone session).',
    'Phone uses 999px pills and a floating rounded button; desk uses 3px corners. They look like two apps.',
    'Suggested-reply chips sit on the composer\'s top border and read as tabs.',
  ],
  prop: [
    'Four buttons: <b>primary</b> (one per view), <b>default</b>, <b>quiet</b> (text, for toolbars), <b>icon</b>. Danger is a tone on primary or default. All 28px on desk, 44px hit area on phone.',
    'One segmented control: a sunk track with a raised selected cell. No black-filled segments; black is for the one primary action.',
    'Pills only for counts and chips that are answers. Everything else 7px.',
    'Every control drawn in all eight states (see the sheet).',
  ],
  why: 'Black-filled segments compete with the primary button; on Usage there are four black things in the header and none is the action.',
  cur: ['usage-1440-light', 'backlog-1440-light', 'home-400-light'], mock: 'controls', shots: [['controls-desk', 'One kit, eight states']] },

{ id: 'icons', sec: 'foundations', title: 'Icons', effort: 'S',
  job: 'Recognition at a glance on phone, where labels do not fit.',
  today: [
    'Three icon sets: <code>ICON</code> (16px, stroke 1.2 to 2), <code>APP_ICONS</code> (24px, stroke 2), and a filled Material phone on the side-key screen.',
    'Unicode used as icons: ✕ (11 places), ✓, ■, ← → ⟳ ⌨ ‹ › ⇧. Text leads in the palette: <code>pg</code>, <code>$</code>, <code>dir</code>.',
    'The Menu default label is the text "•••" while the session header uses the SVG more icon.',
  ],
  prop: [
    'One set: 16px grid, 1.5 stroke, round caps, drawn to match Recursive\'s weight. About 40 glyphs cover the app (sheet below).',
    'Desk keeps text labels on primary actions; icons lead only where the word is obvious (back, close, more, attach, send). Phone uses icon plus label in the tab bar.',
  ],
  why: 'Mixed stroke weights read as clutter even when each icon is fine on its own.',
  mock: 'icons', shots: [['icons-desk', 'The set']] },

{ id: 'time', sec: 'foundations', title: 'Times, dates and durations', effort: 'S',
  job: '"How long ago" on every row, "when" in every transcript, "how long" on steps and calls.',
  today: [
    'Twenty separate formatters. Two identical pairs (<code>hhmm</code> = <code>hm</code>, <code>txDay</code> = <code>dayText</code>), two different duration styles (<code>3h 5m</code> vs <code>12m 05s</code>), dates as <code>3 Nov</code>, <code>Nov 17 19:02</code>, <code>Wed, Nov 18 01:06</code>, <code>Thu, Nov 26</code> and <code>Jan 2 15:04</code> (CLI).',
    'The CLI and TUI add <code>1h0m0s</code>, <code>Mon Jan 02</code> and <code>3m05s</code>.',
  ],
  prop: [
    'Four forms, one module shared by web, TUI and CLI: <b>age</b> <code>now 4m 3h 2d</code>; <b>clock</b> <code>14:05</code>; <b>stamp</b> <code>Tue 14:05</code> inside a week, <code>3 Nov 14:05</code> after, year only when not this year; <b>duration</b> <code>45s 4m 05s 3h 05m 2d 4h</code>.',
    'Day first, 24h, English month abbreviations, everywhere. Hover or long-press on an age shows its stamp.',
  ],
  why: 'You compare times across rows, transcript and pages; three formats for the same moment make that slow.',
  mock: 'time', shots: [['time-desk', 'The four forms']] },

{ id: 'copy', sec: 'foundations', title: 'Copy: empty, loading and error states', effort: 'M',
  job: 'What the app says when there is nothing, when it is waiting, and when something broke.',
  today: [
    'Fifteen empty-state classes and as many sentence shapes: "Nothing here yet." / "No pages." / "None yet" / "Empty" / "Nothing open".',
    '"Loading…" next to "Loading the voices" and "Resuming" next to "Resuming…"; ASCII "..." in two places.',
    '"Couldn\'t" and "Could not" both used; errors appear as a toast, <code>p.err</code>, <code>.nserr</code>, <code>.capmsg.bad</code>, <code>.evt.fail</code> and plain text.',
    'Backlog\'s empty state says "0 open in other stages." with a "Show open" button that shows nothing, in the serif face.',
    'Explanations run long on Usage (a 70-word paragraph under the chart).',
  ],
  prop: [
    '<b>Empty</b>: "No &lt;things&gt; in &lt;where&gt; yet." plus the one action that fills it, as a button. Never a button that leads to another empty state.',
    '<b>Loading</b>: a skeleton of the real layout for the first load, and "&lt;Verb&gt;ing…" with the ellipsis character after 400ms otherwise.',
    '<b>Error</b>: one inline component: what happened, why if known, one fixing action ("laptop didn\'t answer at 15:30. Sessions there show as last seen. <u>Retry</u>"). Toasts only for things off screen.',
    'One verb per action through the flow: "Park" makes the toast "Parked".',
  ],
  why: 'Principle 9 from the November redesign ("errors explain and fix") is followed in some places and not in others.',
  cur: ['backlog-1440-light', 'usage-1440-light'], mock: 'copy', shots: [['copy-desk', 'Empty, loading, error']] },

{ id: 'keys', sec: 'foundations', title: 'Key hints and focus', effort: 'S',
  job: 'You drive atc by keyboard on desk. Hints teach keys; focus shows where Enter will go.',
  deliberate: 'Visible key chips on every control were a November decision. This proposes moving most of them, so it is flagged for your call.',
  today: [
    'Hints that lie: the page button shows <kbd>p</kbd> but <kbd>]</kbd> opens it; Resume shows <kbd>r</kbd> but Enter resumes; the usage footer says <kbd>u</kbd> (no handler); the palette says Terminal <kbd>t</kbd> (it is <kbd>`</kbd>) and State <kbd>]</kbd> (it is <kbd>\\</kbd>); "alt 0" and "alt N" appear but Alt alone does nothing.',
    'The Keys overlay misses Ctrl K, the call keys, board Space, viewer arrows and the slash menu.',
    'Chips sit on nearly every button (the bay bar alone has nine), so the header reads as a key map.',
    'Focus rings: most use <code>--focus</code>, <code>.btn</code> uses <code>--work</code>.',
  ],
  prop: [
    'Fix every lying hint (list above), generated from one key table so the overlay, tooltips and palette cannot drift.',
    'Chips leave buttons and move to the tooltip and the palette row. They stay where the key <i>is</i> the label: row quick keys (q w e…), answer numbers, and the Keys overlay.',
    'One focus ring: 2px <code>--focus</code>, 2px offset, no animation.',
  ],
  alt: 'If you want to keep learning from the chips, keep them but only on the bay bar\'s view switches and the session header, drawn quieter (no box, faint letter).',
  why: 'Nine boxed letters in the top bar is noise after the keys are learned, and a hint that is wrong is worse than none.',
  cur: ['home-1440-light'], mock: 'keys', shots: [['keys-desk', 'Header without chips, tooltip with the key']] },

{ id: 'trunc', sec: 'foundations', title: 'Truncation, long titles, Turkish text', effort: 'S',
  job: 'Titles and statuses of every length, often Turkish, at every width.',
  today: [
    'Board rows clip the folder path mid-word with "…" (<code>worktree-checkout-ui-rev…</code>) while the useful part is the end.',
    'Truncation lengths are hand-set in JS in three places (28, 56, 200 chars) and done in CSS elsewhere; ASCII "..." in two.',
    'The pal strip at the top clips the date at 400px ("Thu 26 Nov 0").',
  ],
  prop: [
    'Titles wrap to two lines in lists, never clip mid-word; one line only in tabs and headers, with the full title on hover.',
    'Paths clip from the start (<code>…/worktrees/revamp</code>) since the end is the part that differs.',
    'Every text node gets <code>lang</code> from its content when it is Turkish, so hyphenation and <code>ı/İ</code> casing are right.',
  ],
  mock: 'trunc', shots: [['trunc-desk', 'Long English and Turkish titles at 1440, 620 and 400']] },

// ───────────── shell
{ id: 'baybar', sec: 'shell', title: 'Bay bar', effort: 'M',
  job: 'Switch project (1-9), see where things wait, switch view. Looked at constantly, clicked rarely.',
  deliberate: 'Bays as numbered tabs, amber counts as text on a faint wash, parked bays after a divider: all deliberate and kept.',
  today: [
    'Twelve things compete in 40px: bays, parked divider, three view buttons with chips, two contextual toggles with chips, the clock.',
    'The contextual toggles (All bays, Page index, Sessions, State) change per view, so the right side jumps when switching views.',
    'Counts are "2 ▌1" (amber number, then a bar glyph and a working number); the bar glyph reads as a cursor.',
    'The clock duplicates the pal strip\'s clock right above it.',
    'With ten bays at 1440 the bar overflows: the parked divider shrinks to "F" and the last bay is cut mid-name.',
  ],
  prop: [
    'Left: bays with their count. Right: the three views as one segmented control. Pane toggles (State, Index, Sessions) move to the pane they toggle, as an icon in that pane\'s header.',
    'Counts: amber number for waiting, a steel dot with the working count beside it. No bar glyph.',
    'No clock (the pal strip and the OS have one); the offline state takes its place when there is one.',
  ],
  why: 'The bar should answer "where does something wait" in one glance; today it also answers six other questions.',
  cur: ['home-1440-light', 'terminal-1440'], mock: 'baybar', shots: [['baybar-desk', 'Bay bar, session view']] },

{ id: 'console', sec: 'shell', title: 'Console line (bottom)', effort: 'S',
  job: 'The assistant\'s last line, a way to talk to it, agents, memory. Glanced at, used to start a call.',
  today: [
    'The input "talk to the as" is clipped to 90px, so it cannot be read or typed in comfortably.',
    'Four agent names plus "+10" are text links with no state; mem 68% sits beside them with no label of what machine.',
  ],
  prop: [
    'One line: <code>assistant</code> mark, its last line (clamped), age, then a real input that grows to 40% when focused, then Call.',
    'Agents become one "Agents 14" button with a count when one needs you, opening a list of what each keeps; memory moves to the bay bar\'s status slot, shown only when over 85%, as a neutral meter (amber means needs you).',
  ],
  cur: ['home-1440-light'], mock: 'console', shots: [['console-desk', 'Console']] },

{ id: 'phonehome', sec: 'shell', title: 'Phone home and tab bar', effort: 'M',
  job: 'The phone\'s first screen: what waits on you, in which bay. Opened many times a day for seconds.',
  deliberate: 'You asked for the phone to be the desk folded to one column (Nov 21). This keeps that and removes the parts that drifted from the desk.',
  today: [
    'Bay chips are rounded pills with filled counts; the desk has underline tabs. The selected chip is solid black.',
    'Two floating buttons (Shell, + New) cover the list\'s last row.',
    'The tab bar has a fifth tab labelled "pal", lowercase, with a generic icon.',
    'The search field and settings gear take a row before any session is visible.',
  ],
  prop: [
    'Bays as the desk\'s underline tabs in a scrolling strip, with the same counts.',
    'Tab bar: Sessions, Pages, Assistant, Search, New. New opens a sheet: session or shell. No floating buttons.',
    'Search moves to the tab bar (it already opens the palette); the gear moves into the palette and the Sessions header.',
    'pal\'s own entries go in the palette as a group.',
  ],
  cur: ['home-400-light', 'home-620-light'], mock: 'phonehome', shots: [['phonehome-phone', '400px'], ['phonehome-phone-dark', '400px dark'], ['phonehome-620', '620px, your phone']] },

{ id: 'offline', sec: 'shell', title: 'Offline, reconnecting, a machine down', effort: 'M',
  job: 'Tell you when what you see is stale, and how stale.',
  today: [
    'With the network cut for 8 seconds, nothing on the page changed: no "reconnecting", rows kept counting their ages as if live. Only the pal strip\'s icons broke.',
    'Reconnecting is a word in the bay bar\'s meta slot; on phone the whole bar reappears just for it.',
    'A down peer shows "laptop off" in the bar; its sessions stay drawn as if live (no age, no mark).',
    'The terminal has its own cover ("Connection lost") and the Android shell has a third ("Can\'t reach atc").',
  ],
  prop: [
    'One stale line under the bay bar (and at the top on phone): "Offline since 15:41. Showing what was there." with Retry. Same component in the terminal and the Android shell.',
    'Sessions on a down machine get a faint hatch on their state block and "as of 15:30" in place of their age.',
  ],
  why: 'Principle 3 ("what you see is true"): stale data has to look stale.',
  cur: ['offline-1440'], mock: 'offline', shots: [['offline-desk', 'Offline and a machine down'], ['offline-phone', 'Phone']] },

{ id: 'toast', sec: 'shell', title: 'Toasts and Undo', effort: 'S',
  job: 'Confirm an action that left the screen, offer Undo.',
  today: [
    'Toasts are used for on-screen events too ("Showing you X. It\'s on the page button up top.").',
    'Undo is the <kbd>z</kbd> key while a toast shows, which also means Zen otherwise.',
  ],
  prop: [
    'Toast = what happened + one action, bottom centre (above the console on desk, above the tab bar on phone), 6s, 8s with Undo. One at a time; a new one replaces. Same as Wisp.',
    'Undo stays on <kbd>z</kbd> (already learned), and the toast shows the key next to its Undo button.',
  ],
  mock: 'toast', shots: [['toast-desk', 'Toasts']] },

{ id: 'keysov', sec: 'shell', title: 'Keys overlay', effort: 'S',
  job: 'Look up a key. Opened rarely, needed exactly then.',
  cur: ['keys-1440'],
  today: ['Missing keys (see Key hints). One long list without grouping by where the key works.'],
  prop: ['Generated from the key table; grouped Everywhere / Lists / Session / Transcript / Call / Dialogs, three columns on desk. Searchable: typing filters.'],
  mock: 'keysov', shots: [['keysov-desk', 'Keys']] },

{ id: 'palette', sec: 'shell', title: 'Palette', effort: 'S',
  deliberate: 'The palette is one of the best parts: grouped, fast, Tab previews behind. Small changes only.',
  job: 'Go anywhere, run anything. Used constantly on desk.',
  today: [
    'Fuzzy match drops everything on a trailing typo ("wisp?" matches nothing although several titles start with wisp).',
    'Agent rows repeat "wakes when messaged" six times; Recent shows "Working…" as the status for every working session.',
    'Footer legend lists ctrl j / ctrl k, keys most people never use, while Tab preview is the useful one.',
  ],
  prop: [
    'Rank by best partial match so a trailing character degrades instead of emptying.',
    'Rows: state block, title, the one line that differs (last status), bay, age. Agents show what they keep, not their wake schedule.',
    'Footer: Enter opens, Tab previews, Esc closes.',
  ],
  cur: ['palette-1440', 'palette-typed-1440', 'search-400'], mock: 'palette', shots: [['palette-desk', 'Palette']] },

// ───────────── lists
{ id: 'board', sec: 'lists', title: 'Board', effort: 'M',
  job: 'A bay at a glance: every session, what it is doing, what it made. Second to the left list.',
  today: [
    'Six columns, but most rows fill two: Steps and "Running, made" are empty for idle sessions, so the table has holes.',
    'Header has five quiet buttons (Park all, Backlog, Shell, Search) of three different heights.',
    'Below the last group the screen is empty; Earlier is folded at 34.',
  ],
  prop: [
    'Three columns: Session (title, where), Status (what it said, what it made inline), Since. Context and steps move into the row\'s second line as small meters, only when non-zero.',
    'Header: bay name, counts, then New session as the one primary; Park all and Shell go to a More menu.',
    'Earlier unfolds by default to today, so the screen is not half empty.',
  ],
  cur: ['home-1440-light', 'home-1440-dark', 'rowexpanded-1440'], mock: 'board', shots: [['board-desk', 'Board'], ['board-desk-dark', 'Board dark']] },

{ id: 'rail', sec: 'lists', title: 'Left list (rail)', effort: 'M',
  job: 'His main way around: the list beside the session you are reading. Every switch goes through it.',
  today: [
    'Rows are tall (three lines of summary), so on a 900px screen only five fit.',
    'The selected row is grey with a 3px black left edge; the needs-you row has a 3px amber edge; the two can stack.',
    'The quick key sits in a box to the left of the age, the age jammed against it ("q 1h").',
    'Footer: Backlog line and a week meter, which are not about the list.',
  ],
  prop: [
    'Two lines per row by default (title, status), the third only for needs-you (the question, answerable inline).',
    'Selected = raised paper with a hairline, independent of the state edge.',
    'Quick key as a faint letter at the row\'s right edge, revealed while the list has focus.',
    'Footer goes; Backlog and usage are in the palette and the bay\'s More.',
  ],
  cur: ['session-1440-light'], mock: 'rail', shots: [['rail-desk', 'Left list beside a session']] },

{ id: 'earlier', sec: 'lists', title: 'Earlier, history and resume', effort: 'S',
  job: 'Find yesterday\'s session and pick it up again.',
  today: ['Unfolding "Earlier 34" shows the label "today and yesterday" with nothing under it, then "Show 34 older".', 'Earlier is folded behind a count with no hint of what is in it; "Show N older" then "Load more" are two different paging verbs.', 'History search lives only in the palette.'],
  prop: ['Earlier shows today\'s ended sessions unfolded, then one "Older" fold grouped by day, paged with one verb ("Show more"); Resume is a row action on hover and in the row menu.', 'A filter field at the top of Earlier searches history in place.', 'Drawn in the left list first, since that is where you work; the Board gets the same.'],
  cur: ['earlier-1440'], mock: 'earlier', shots: [['earlier-desk', 'Earlier unfolded']] },

{ id: 'peek', sec: 'lists', title: 'Bay peek', effort: 'S',
  job: 'See and answer another bay\'s waiting sessions without leaving this one.',
  today: ['Opened by clicking the count pips, which are 12px targets; nothing says they open anything.'],
  prop: ['Hover on a bay tab for 400ms (or Shift+Alt+N) opens the peek; it lists waiting sessions with inline answers, like the rail\'s needs-you rows.'],
  mock: 'peek', shots: [['peek-desk', 'Peek']] },

{ id: 'quick', sec: 'lists', title: 'Row menu (right-click, long-press)', effort: 'S',
  job: 'Act on a session without opening it: park, pin, rename, stop.',
  cur: ['quick-1440'],
  today: ['Right-click opens the same column of tall outlined buttons as the More menu, over the row it belongs to.', 'Swipe gestures (park right, reply left) are invisible; Delete and Stop sit next to Rename in one flat list.'],
  prop: ['Menu grouped: Open / Rename, Pin, Park / Resume, Stop / Delete (danger, last). Swipe reveals its action label as you drag.'],
  mock: 'quick', shots: [['quick-desk', 'Row menu'], ['quick-phone', 'Long-press sheet']] },

// ───────────── session
{ id: 'header', sec: 'session', title: 'Session header', effort: 'M',
  job: 'Which session, its state, and the switches: terminal, page, zen, more.',
  today: [
    'The More menu on desk is a column of fifteen full-width outlined buttons, 40px each, with Delete in the middle: a phone sheet drawn on a desk.',
    'Two lines: title and where, then the status headline with model, context meter and cost. Five buttons with chips on the right.',
    'Phone: title, then the status line, then four tabs: three rows before the transcript starts.',
  ],
  prop: [
    'Desk: one 44px line: state block, title, where (faint), then Page, Terminal, the State pane toggle, More. Zen moves into More (<kbd>z</kbd> still works). More is a list menu: grouped, real keys right-aligned and faint, Delete last in red. Status headline moves into the transcript as the "since you looked" line.',
    'Phone: back, title, more on one row; tabs below. Two rows.',
  ],
  cur: ['session-1440-light', 'more-1440', 'session-400-light', 'session-more-400'], mock: 'header', shots: [['header-desk', 'Desk'], ['header-phone', 'Phone']] },

{ id: 'transcript', sec: 'session', title: 'Transcript reading', effort: 'L',
  job: 'Read what the agent said and did. The most important screen in atc.',
  deliberate: 'Column width, the reading face choice, step folds and "since you last looked" were all designed and tuned in November. This keeps them and fixes the noise around them.',
  today: [
    'Repeated red "Background command bash /home/…/run.sh failed with exit code 143" cards between every reply. Exit 143 is a process you or the agent killed; it is not a failure.',
    'The "Since you last looked" divider is a 2px black rule, the heaviest line on the page.',
    'Step fold lines run to the edge with truncated tool names ("browser · evaluate, browser · emulate media, …").',
    'Timestamps sit only on some fold lines, right-aligned far from the text.',
  ],
  prop: [
    'Background commands join the step fold of the turn they ran in; killed (130, 143) reads "stopped", not failed. A real failure stays red, once, with Output.',
    'The since divider becomes a hairline with an amber label, and the catch-up line under it.',
    'Fold lines name tools once ("browser ×6"), counts not lists.',
    'Each reply gets its clock in the margin, aligned with the first line.',
  ],
  cur: ['session-1440-light', 'session-1440-dark', 'session-400-light'], mock: 'transcript', shots: [['transcript-desk', 'Desk'], ['transcript-desk-dark', 'Desk dark'], ['transcript-phone', 'Phone']] },

{ id: 'ask', sec: 'session', title: 'Questions and permissions', effort: 'S',
  deliberate: 'One Ask component in compact and full forms, answer states with Retry: deliberate, keep.',
  job: 'Answer the agent: pick an option, allow a command, type an answer.',
  today: ['Permission options are numbered 1 and 3 ("1 Allow once", "3 Deny") on the widget and notifications, which looks like a missing 2.', 'Same ask is phrased "Run cmd" on the widget and "Wants to run cmd" in pushes.'],
  prop: ['Numbers are positions in what is shown: 1 Allow once, 2 Deny. One phrasing: "Wants to run <code>cmd</code>" everywhere.'],
  mock: 'ask', shots: [['ask-desk', 'Ask, full and compact']] },

{ id: 'composer', sec: 'session', title: 'Composer, uploads, slash commands', effort: 'M',
  job: 'Reply, queue a reply, attach a file, run a slash command.',
  today: [
    'Suggested replies sit on the box\'s top border like tabs.',
    '"Attach" is a text button on desk and a + on phone; Send is a grey box that only darkens with text.',
    'Placeholder says "Reply to [the session title]; enter sends", restating the title.',
  ],
  prop: [
    'One box: suggestions as chips inside its top row, attachments as chips below them, the text, then a bottom row: attach icon, slash hint, Send (primary once there is text).',
    'Placeholder: "Reply" or "Queue a reply" while it works; the Enter hint lives in the Send tooltip.',
    'Dropping a file anywhere over the session outlines the box.',
  ],
  cur: ['session-1440-light', 'session-400-light'], mock: 'composer', shots: [['composer-desk', 'States'], ['composer-phone', 'Phone']] },

{ id: 'endbar', sec: 'session', title: 'Stopped session bar', effort: 'S',
  job: 'Say why a session stopped and offer Resume.',
  today: ['In narrow panes (the agents page) the reason is squeezed into a 130px column next to three buttons, one word per line.', 'Resume shows a <kbd>r</kbd> chip but Enter is the key.'],
  prop: ['Reason on top, full width, two lines max with "Why" to expand; buttons below on narrow panes, beside on wide ones.'],
  cur: ['agents-1440-light'], mock: 'endbar', shots: [['endbar-desk', 'Wide and narrow']] },

{ id: 'terminal', sec: 'session', title: 'Terminal', effort: 'S',
  job: 'The backup view: Claude Code\'s own TUI, for what the transcript cannot do.',
  today: ['The terminal is drawn dark inside a light app (it follows Claude Code\'s own theme), with the summary bar and its chips stacked above it.', 'Who owns the size shows as a notice only when someone else does; the phone key strip uses glyphs (⇧tab, ^C).'],
  prop: ['A thin line under the header always says the size and its owner ("182×48, this screen"), with Take size when it is another. Phone key strip with words (esc, tab, ctrl) and icons for arrows.'],
  cur: ['terminal-1440', 'terminal-400'], mock: 'terminal', shots: [['terminal-desk', 'Terminal'], ['terminal-phone', 'Phone key strip']] },

{ id: 'statepane', sec: 'session', title: 'State pane and summary', effort: 'S',
  job: 'What it did, what it needs, what it made, facts.',
  cur: ['statepane-1440', 'state-400'],
  today: ['On phone it is a tab; on desk a pane behind <kbd>\\</kbd> nobody sees unless they know the key.'],
  prop: ['Desk: an icon button in the session header toggles it; it opens with the summary first, then outputs, then facts as a two-column list.'],
  mock: 'statepane', shots: [['statepane-desk', 'State pane']] },

{ id: 'pagepane', sec: 'session', title: 'A page beside its session', effort: 'S',
  job: 'Read the page an agent showed while keeping the conversation.',
  today: ['The page pane header has six text buttons (Zen, Page only, In Pages, More, Close) plus a "page" tag box and a date.'],
  prop: ['Header: page title, updated age, then icons for Full, Open in Pages, More, Close.'],
  cur: ['agents-1440-light'], mock: 'pagepane', shots: [['pagepane-desk', 'Page beside the transcript']] },

{ id: 'browser', sec: 'session', title: 'Browser view', effort: 'S',
  job: 'Watch and take over an agent\'s browser tab (a login, a captcha).',
  today: ['Glyph buttons ← → ⟳ ⌨; no sign of whether input goes to the page.'],
  prop: ['Icon buttons from the set; a "You are driving" state when the tab has your input, with Release.'],
  mock: 'browser', shots: [['browser-desk', 'Browser view']] },

{ id: 'outputs', sec: 'session', title: 'Outputs, files and the viewer', effort: 'S',
  job: 'What the session produced: pages, servers, files, commits.',
  today: ['Three overlapping views: Results popover, Outputs pane and the State pane\'s outputs section.'],
  prop: ['One Outputs list (in the State pane); Results popover goes.', 'The viewer opens in place of the transcript, so the list it came from stays visible with the file selected. It keeps its keys; its close is the icon, its title the path clipped from the start.'],
  cur: ['results-1440'], mock: 'outputs', shots: [['outputs-desk', 'Outputs']] },

// ───────────── screens
{ id: 'newsession', sec: 'screens', title: 'New session', effort: 'M',
  job: 'Start work: a prompt, a folder, a machine. Several times a day.',
  today: ['Opens over the board with the prompt first, then folder, host, worktree, engine, name, account; the footer has four buttons (Clear, Cancel, Later, Start).'],
  prop: ['Prompt first and large; folder and machine on one line under it as two pickers; worktree, engine, name and account behind "Options" with their current values shown inline. Footer: Later (quiet), Start (primary).'],
  cur: ['new-1440', 'new-400'], mock: 'newsession', shots: [['newsession-desk', 'Desk'], ['newsession-phone', 'Phone sheet']] },

{ id: 'pages', sec: 'screens', title: 'Pages', effort: 'M',
  deliberate: 'The thumbnail gallery is good and stays.',
  job: 'Find a page an agent showed you; read it.',
  today: ['Card meta repeats "Page" on every card ("/p/ops-open · Page · updated 8h ago").', 'Unseen is a 6px blue dot, the Working colour.', 'Bay identity is missing from cards in the all-bays view.'],
  prop: ['Card: thumbnail, title, then "bay · 8h" with the bay\'s identity tick. Unseen = bold title and an amber-free dot in ink.', 'Reader keeps its index; index rows get the same tick.'],
  cur: ['pages-1440-light', 'pages-tab-400'], mock: 'pages', shots: [['pages-desk', 'Gallery'], ['pages-phone', 'Phone']] },

{ id: 'assistant', sec: 'screens', title: 'Assistant', effort: 'S',
  job: 'Talk to the one agent that drives the others. Often your entry point.',
  today: ['The assistant view, the agents view and a session view are three layouts for one thing (a conversation with a list beside it); each has its own header and close.'],
  prop: ['Assistant view = a session view with "Touched today" as its left list. Same header, same composer, Call as the primary.'],
  cur: ['assist2-1440', 'assist2-400'], mock: 'assistant', shots: [['assistant-desk', 'Assistant']] },

{ id: 'call', sec: 'screens', title: 'Call', effort: 'S',
  deliberate: 'The call screen, characters and the orb are their own designed world (cel). Out of scope except the controls.',
  job: 'Talk to the assistant by voice, hands free.',
  today: ['Controls are labelled by single letters (t, m, E) on desk.'],
  prop: ['Controls get the shared icon set and words: Talk, Mute, End (danger). Keys in tooltips.'],
  mock: 'call', shots: [['call-desk', 'Call controls']] },

{ id: 'hold', sec: 'screens', title: 'Side-key screen', effort: 'S',
  deliberate: 'Picked on Nov 9 (status tiles, tabs, a call button raised out of the dark band). Kept; small fixes only.',
  job: 'Hold the side key: see what waits, call the assistant.',
  today: ['The selected tab is a black filled block; the call button is a filled Material icon from a different set; the bottom quick keys are four equal boxes.'],
  prop: ['Tabs as the shared segmented control; the call glyph from the set; quick keys with icons.', 'The call button is ink, not green: green is not a state colour. The band stays dark in both modes.'],
  cur: ['hold-620-light', 'hold-400-light'], mock: 'hold', shots: [['hold-phone', 'Side-key screen']] },

{ id: 'agents', sec: 'screens', title: 'Agents', effort: 'M',
  job: 'See the standing agents: what each keeps, when it wakes, its pages.',
  today: ['Each row carries a boxed "parked" tag (every agent is parked), a coloured monogram, two lines of last words and a wake line.', 'Selecting one opens its conversation, a stopped bar and a page side by side: three columns at 1440.'],
  prop: ['Rows: monogram (identity tick), name, what it keeps, next wake. "Parked" is the normal state and is not tagged; awake ones get the steel mark.', 'Selected agent: its page first, the conversation behind a tab.'],
  cur: ['agents-1440-light', 'agents-400-light'], mock: 'agents', shots: [['agents-desk', 'Agents']] },

{ id: 'backlog', sec: 'screens', title: 'Backlog', effort: 'S',
  job: 'Put a task aside for later; start it later.',
  today: ['Seven boxed filters with zero counts; "No open tasks / 0 open in other stages / Show open" for an empty backlog.'],
  prop: ['Add field, then the list grouped by stage with counts in the group headings; stages with nothing are hidden. Empty: "Nothing on atc\'s backlog. Add a task above, or press + on any session."'],
  cur: ['backlog-1440-light'], mock: 'backlog', shots: [['backlog-desk', 'Backlog']] },

{ id: 'usage', sec: 'screens', title: 'Usage, Time and Resources', effort: 'M',
  deliberate: 'The limit gauge with its hatched projection and pace mark is a good instrument. Kept.',
  job: 'Am I on pace for the week; what did the time go to.',
  today: ['Four black segmented controls in the header; a long explanation paragraph; "Adding up the transcripts…" as the only loading sign; "Spend per hour of yours …" showing a bare ellipsis.'],
  prop: ['Header: one account switch, one Spend/Time switch, quiet. Explanations become the ⓘ on each number. Skeleton bars while adding up.'],
  cur: ['usage-1440-light', 'time-1440-light', 'resources-1440-light'], mock: 'usage', shots: [['usage-desk', 'Usage']] },

{ id: 'settings', sec: 'screens', title: 'Settings and set-up checks', effort: 'M',
  deliberate: 'The theme cards with live previews are good. Kept.',
  job: 'Change the look, reading prefs, set up calls and devices; see what is broken.',
  today: ['Settings leaves the shell (no bay bar, no console) and has its own ← header.', 'Reading options differ from zen\'s (sizes as words here, five A\'s there; zen has line spacing and paper, Settings does not).'],
  prop: ['Settings is a screen inside the shell like Usage. One Reading panel used by both Settings and zen.'],
  cur: ['settings-1440-light', 'settings-400-light'], mock: 'settings', shots: [['settings-desk', 'Settings']] },

{ id: 'login', sec: 'screens', title: 'Login', effort: 'S',
  job: 'Rare: a device without a token.',
  cur: ['login-1440'],
  today: ['A centred token field; Log in stays grey until something is typed; the hint runs the command into the sentence ("atc token on it prints one").'],
  prop: ['The app mark, one field, the two ways to get a token (atc token, Settings, Devices, pair by QR) as plain lines.'],
  mock: 'login', shots: [['login-desk', 'Login'], ['login-phone', 'Phone']] },

{ id: 'pit', sec: 'screens', title: 'Project board (decisions)', effort: 'S',
  job: 'Go through an agent\'s proposals one card at a time.',
  today: ['Drawn by pit in a shadow DOM with its own type and radii mapped onto atc tokens.'],
  prop: ['Map pit onto the revamp tokens (radii, focus, buttons); nothing else changes.'],
  mock: null, shots: [] },

// ───────────── surfaces
{ id: 'tui', sec: 'surfaces', title: 'TUI (bare atc)', effort: 'S',
  job: 'Sessions in a terminal, attach with Enter. Used over ssh.',
  today: ['Needs you are red here and amber everywhere else; no letter blocks.', 'Host never shown with several machines.', 'Four lines per row, so 9 sessions fit in 40 rows.', 'Footer lists 12 keys and truncates on narrow terminals; U, tab, pgup, g/G work but are not listed.'],
  prop: ['Same state language as the web: amber N block, steel W, outlined T (ANSI 256 approximations). Two lines per row with host. Footer: five keys and "? keys".'],
  cur: ['tui'], mock: 'tui', shots: [['tui-desk', 'TUI']] },

{ id: 'cli', sec: 'surfaces', title: 'CLI output and help', effort: 'M',
  job: 'Scripts and quick checks: atc ls, doctor, show, board.',
  today: ['Four help styles (Usage: lines, a one-liner plus prose, a bare table, Go\'s default "Usage of ls:"); <code>-h</code> prints the token on <code>atc token</code> and starts the MCP server on <code>atc mcp</code>.', 'Single and double dash flags mixed in the help text.', 'Silent success on stop, rm, rename, pin, park; lowercase "started …" next to sentences.', 'Doctor prints Markdown backticks literally.'],
  prop: ['One help template: <code>atc X: what it does.</code>, synopsis, flags table, examples. <code>-h</code> handled before anything else everywhere.', 'Every command says what it did in one sentence ("Parked fix-upload."). Tables: aligned, headers in sentence case, <code>--json</code> on each.'],
  cur: ['ls', 'doctor'], mock: 'cli', shots: [['cli-desk', 'ls, doctor and a help page']] },

{ id: 'android', sec: 'surfaces', title: 'Android: native screens', effort: 'M', curNote: 'Native Android screens, read from android/ (MainActivity.kt, Updater.kt, Checklist.kt); not captured here.',
  job: 'First run, pairing, certificates, updates, offline.',
  today: ['The server setup screen uses default Android widgets; the offline overlay and checklist use the palette.', 'Update dialog: "Update available (0.812)" with no body.', 'Hostname and chain mismatches cancel silently.'],
  prop: ['Draw the setup, trust and update screens with the same tokens as the offline overlay. Update dialog says size and what changed. Every TLS refusal says why.'],
  mock: 'android', shots: [['android-phone', 'Setup and update']] },

{ id: 'push', sec: 'surfaces', title: 'Notifications and widget', effort: 'S', curNote: 'Android notifications and the widget, read from android/ (Push.kt, Reply.kt, Widget.kt) and internal/server; not captured here.',
  job: 'Know something needs you and answer without opening the app.',
  today: ['Push titles: "Claude", "assistant" (lowercase), "atc", "laptop: 3 sessions back".', '"1 Allow once / 3 Deny".', 'The widget below Android 12 uses its own fixed colours.'],
  prop: ['Title is always the session title with its bay; system pushes are titled "atc". Numbers 1, 2. Widget older-Android colours generated from the default theme.'],
  mock: 'push', shots: [['push-phone', 'Notification and widget']] },
];
