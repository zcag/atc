// A person is a name, a character and a voice per language (internal/server/persons.go). The assistant is one person
// per language, so which one a call shows follows the language the call is in.

export const personOf = (doc, lang) => doc?.persons?.find((p) => p.id === doc.langs?.[lang]) || null;

/** Who can be picked for a language: a voice in another language would read this one's words wrong. */
export const speakers = (doc, lang) => (doc?.persons || []).filter((p) => p.voices?.[lang]);

/** How this device shows a call: whoever is on the line as their character, or only a mark that moves with the voices. */
export const VIEWS = [["character", "Character"], ["line", "Line"], ["bars", "Bars"]];

export const nextView = (v) => VIEWS[(VIEWS.findIndex(([k]) => k === v) + 1) % VIEWS.length][0];

/** The languages the line speaks, first the one calls start in; with no voice service, the ones the persons have voices in. */
export const personLangs = (voices, doc) => {
  const offered = Object.keys(voices || {});
  if (offered.length) return offered;
  return [...new Set([...Object.keys(doc?.langs || {}), ...(doc?.persons || []).flatMap((p) => Object.keys(p.voices || {}))])].sort();
};

const LANGS = { tr: "Turkish", en: "English" };
export const langName = (l) => LANGS[l] || l;
export const voiceName = (v) => v.replace(/^en_/, "").replace(/_/g, " ");
export const roomName = (f) => f.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
