// A person is a name, a character and a voice per language (internal/server/persons.go). The assistant is one person
// per language, so which one a call shows follows the language the call is in.

export const personOf = (doc, lang) => doc?.persons?.find((p) => p.id === doc.langs?.[lang]) || null;

/** Who can be picked for a language: a voice in another language would read this one's words wrong. */
export const speakers = (doc, lang) => (doc?.persons || []).filter((p) => p.voices?.[lang]);

/** The one after whoever a language has now, or null when there is nobody else. */
export function nextPerson(doc, lang) {
  const all = speakers(doc, lang);
  if (all.length === 0) return null;
  const n = all[(all.findIndex((p) => p.id === doc.langs?.[lang]) + 1) % all.length];
  return n.id === doc.langs?.[lang] ? null : n;
}

/** Your language first as the call's is, then the rest, whether a language came from the voices or from the persons. */
export const personLangs = (voices, doc) => [...new Set([...Object.keys(voices || {}), ...Object.keys(doc?.langs || {}), ...(doc?.persons || []).flatMap((p) => Object.keys(p.voices || {}))])]
  .sort((a, b) => (a === "tr" ? -1 : b === "tr" ? 1 : a.localeCompare(b)));
