// A person is a name, a character and a voice per language (internal/server/persons.go). The assistant is one person
// per language, so which one a call shows follows the language the call is in.

export const personOf = (doc, lang) => doc?.persons?.find((p) => p.id === doc.langs?.[lang]) || null;

/** Who can be picked for a language: a voice in another language would read this one's words wrong. */
export const speakers = (doc, lang) => (doc?.persons || []).filter((p) => p.voices?.[lang]);

/** How this device shows a call: whoever is on the line as their character, or only a mark that moves with the voices. */
export const VIEWS = [["character", "Character"], ["line", "Line"], ["bars", "Bars"]];

export const nextView = (v) => VIEWS[(VIEWS.findIndex(([k]) => k === v) + 1) % VIEWS.length][0];

/** Your language first as the call's is, then the rest, whether a language came from the voices or from the persons. */
export const personLangs = (voices, doc) => [...new Set([...Object.keys(voices || {}), ...Object.keys(doc?.langs || {}), ...(doc?.persons || []).flatMap((p) => Object.keys(p.voices || {}))])]
  .sort((a, b) => (a === "tr" ? -1 : b === "tr" ? 1 : a.localeCompare(b)));
