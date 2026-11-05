const KEEP = 200;

export const onLine = (f) => (f.line && f.line !== "assistant" ? f.title || f.line : "assistant");

/** The call so far as turns: what one side said in a row stays one turn, each sentence a part. */
export function extended(log, by, who, text) {
  const last = log.at(-1);
  const next = last?.by === by && last.who === who
    ? [...log.slice(0, -1), { ...last, parts: [...last.parts, text] }]
    : [...log, { by, who, parts: [text] }];
  return next.slice(-KEEP);
}

/** The talker sends each sentence once, as it starts being spoken, and only what you finished saying as "you". */
export function logged(log, o, who) {
  if (o.you) log = extended(log, "you", "you", o.you);
  if (o.said) log = extended(log, "it", who, o.said);
  return log;
}
