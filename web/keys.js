const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const KEY_GROUPS = [
  ["Everywhere", "", [
    ["palette", "/", "Palette: go to a session, page, action, folder or agent", `${MAC ? "cmd" : "ctrl"} k`],
    ["keys", "?", "Keys: this list"],
    ["bay", "1 … 9", "That bay, as you left it; again: its next session"],
    ["all", "0", "Every bay"],
    ["peek", "shift alt 1 … 9", "Peek at that bay, or hover its tab: answer without going there"],
    ["next", "n", "Next session waiting on you, any bay"],
    ["session", "s", "Session: the bay's last open one"],
    ["board", "b", "Board"],
    ["pages", "g", "Pages"],
    ["assistant", ".", "Assistant; on a call, back to the call"],
    ["new", "+", "New session"],
    ["settings", ",", "Settings"],
    ["undo", "z", "Undo, while a toast shows it"],
    ["close", "esc", "Close what is open"],
  ]],
  ["Lists", "left list, Board, Pages, Backlog, Agents", [
    ["row", "q w e … p", "The 1st to 10th row in the list, at once"],
    ["move", "j k", "Next, previous row: session, page, task or agent"],
    ["altmove", "alt j k", "Next, previous session, even from a terminal"],
    ["open", "enter", "Open the selected row; on Pages: a note to its session"],
    ["expand", "space", "On the board: unfold the selected row"],
    ["delete", "delete", "Delete the selected session (asks first)"],
    ["rail", "[", "Show or hide the sessions beside the transcript"],
    ["pages.index", "[", "On Pages: the index"],
    ["index", "]", "On the board: the page index"],
    ["pages.scope", "0", "On Pages: this bay or every bay"],
    ["pages.beside", "\\", "On Pages: the page beside its session"],
    ["pages.diff", "d", "On Pages: what changed, on an updated page"],
    ["backlog.done", "d", "On Backlog: done"],
    ["backlog.block", "x", "On Backlog: blocked, or unblock"],
    ["backlog.add", "a", "On Backlog: the add box"],
  ]],
  ["Session", "", [
    ["write", "enter", "Write to it; on a stopped one, Resume"],
    ["term", "`", "Terminal, and back to the transcript"],
    ["state", "\\", "State: the summary, its outputs and the facts"],
    ["page", "]", "Its page beside the transcript"],
    ["menu", "x", "Session menu: park, stop, rename, delete"],
    ["session.delete", "delete", "Delete it (asks first); its conversation stays in history"],
    ["send", "enter", "In the composer: send; while it works, queue"],
    ["stop", "esc", "Empty composer while it works: stop it (asks first)"],
    ["slash", "/", "At the start of the composer: slash commands, ↑ ↓ to choose, tab to complete"],
  ]],
  ["Transcript", "", [
    ["turn", "shift j k", "Next, previous turn: your prompts and its replies"],
    ["screen", "space", "A screen down; with shift, up"],
    ["ends", "home end", "Top, end of the transcript"],
    ["unseen", "shift n", "Next thing you have not seen here: the divider, then the question"],
    ["contents", "c", "Contents: every turn and heading"],
    ["level", "l", "Outline, story, everything, in turn"],
    ["find", "f", "Find in the session"],
    ["zen", "z", "Zen: only the words; on a page you are in, only the page; z or esc to leave"],
    ["glide", "j k ↓ ↑", "In zen: scroll smoothly, tap for a few lines or hold to glide"],
    ["look", "a", "In zen: size, typeface, spacing, colours"],
    ["size", "- =", "In zen: smaller, larger"],
    ["viewer", "← →", "In a file or image viewer: previous, next"],
  ]],
  ["Call", "and the assistant", [
    ["call", ".", "On the assistant: call it; from anywhere: back to the call"],
    ["mute", "m", "Mute, unmute"],
    ["ptt", "t", "Push to talk on or off"],
    ["talk", "space", "With push to talk: hold to talk"],
    ["pickup", "shift a", "Answer a ringing call"],
    ["hangup", "shift e", "End the call, or decline it"],
    ["shrink", "esc", "Shrink the call to the console line; on the assistant, close it"],
    ["touched", "[", "On the assistant: touched today and the agents"],
  ]],
  ["Dialogs", "questions, menus, the palette", [
    ["answer", "1 … 9", "With a question focused (click it, tab into it, or shift n): that answer"],
    ["choose", "enter", "The highlighted choice"],
    ["pal.move", "↑ ↓", "In the palette: move (also ctrl j, ctrl k)"],
    ["pal.preview", "tab", "In the palette: preview it behind"],
    ["pal.bay", "1 … 9", "In the palette, alone: that bay"],
    ["dismiss", "esc", "Close without choosing"],
  ]],
];

const BY = Object.fromEntries(KEY_GROUPS.flatMap(([, , rows]) => rows.map(([id, k, what, alt]) => [id, { k, what, alt }])));

export const key = (id) => BY[id]?.k || "";

export const tip = (id, text) => (BY[id] ? `${text || BY[id].what} (${BY[id].k})` : text || "");

const ARIA = { esc: "Escape", enter: "Enter", space: "Space", tab: "Tab", shift: "Shift", alt: "Alt", ctrl: "Control", cmd: "Meta", "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown", home: "Home", end: "End", delete: "Delete", backspace: "Backspace" };
const chord = (k) => {
  const p = k.split(" ").filter((x) => x !== "…"), mods = p.filter((x) => ["shift", "alt", "ctrl", "cmd"].includes(x)), rest = p.filter((x) => !mods.includes(x));
  return rest.map((r) => [...mods, r].map((x) => ARIA[x] || (x.length === 1 && mods.length ? x.toUpperCase() : x)).join("+"));
};
export const aria = (id) => (BY[id] ? [BY[id].k, BY[id].alt].filter(Boolean).flatMap(chord).join(" ") : null);

export const matches = (q, [group, note], [id, k, what, alt]) => {
  const t = `${group} ${note} ${k} ${alt || ""} ${what}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w));
};
