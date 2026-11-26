export const clipPath = (p, max = 40, sep = "/") => {
  if (!p || p.length <= max) return p || "";
  const parts = p.split(sep);
  for (let i = 1; i < parts.length - 1; i++) {
    const rest = "…" + sep + parts.slice(i).join(sep);
    if (rest.length <= max) return rest;
  }
  return "…" + sep + parts[parts.length - 1];
};

export const clipWords = (s, max) => {
  if (!s || s.length <= max) return s || "";
  const cut = s.slice(0, max - 1), sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "") + "…";
};

const STRONG = /[ğĞıİşŞ]/;
const SOFT = /[çÇöÖüÜ]/;
const WORDS = /(^|[\s(])(ve|bir|bu|için|ile|da|de|ne|mi|çok|daha|gibi|ama|olarak|değil|var|yok)(?=[\s,.;:!?)]|$)|\p{L}(lar|ler)(ı|i|da|de|dan|den)?(?![\p{L}])/iu;

export const langOf = (s) => (s && (STRONG.test(s) || (SOFT.test(s) && WORDS.test(s))) ? "tr" : null);
