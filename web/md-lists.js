const NUMBERED_LINE = /\n {0,3}\d{1,3}[.)][ \t]/;

export const numberedLists = {
  tokenizer: {
    paragraph(src) {
      const cap = this.rules.block.paragraph.exec(src);
      const cut = cap ? cap[1].search(NUMBERED_LINE) : -1;
      if (cut < 0) return false;
      const text = cap[1].slice(0, cut);
      return { type: "paragraph", raw: cap[1].slice(0, cut + 1), text, tokens: this.lexer.inline(text) };
    },
  },
  renderer: {
    list(body, ordered, start) {
      if (!ordered || start === 1) return false;
      return `<ol start="${start}" style="counter-reset:n ${start - 1}">\n${body}</ol>\n`;
    },
  },
};
