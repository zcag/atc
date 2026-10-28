package whatsapp

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Part is one piece of a reply as WhatsApp gets it: text, a table (sent as an image when
// atc can render one), or code too long for a chat bubble (sent as a file).
type Part struct {
	Text  string
	Table [][]string
	Code  string
	Lang  string
}

const (
	Limit     = 4000
	longCode  = 60
	longBytes = 3000
)

var (
	heading   = regexp.MustCompile(`^#{1,6}\s+(.*?)\s*#*$`)
	bullet    = regexp.MustCompile(`^(\s*)[*+]\s+`)
	rule      = regexp.MustCompile(`^\s*(-\s*){3,}$|^\s*(\*\s*){3,}$|^\s*(_\s*){3,}$`)
	tableSep  = regexp.MustCompile(`^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$`)
	codeSpan  = regexp.MustCompile("`[^`\n]+`")
	image     = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)\)`)
	link      = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)
	bold      = regexp.MustCompile(`\*\*(\S(?:.*?\S)?)\*\*|__(\S(?:.*?\S)?)__`)
	italic    = regexp.MustCompile(`(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*([^\w*]|$)`)
	strike    = regexp.MustCompile(`~~(\S(?:.*?\S)?)~~`)
	quoteLine = regexp.MustCompile(`^>\s?`)
)

// Format turns a Claude reply written in Markdown into WhatsApp's own markup, split into
// parts that each fit one message.
func Format(md string) []Part {
	var parts []Part
	var text []string
	flush := func() {
		if t := strings.TrimSpace(strings.Join(text, "\n")); t != "" {
			for _, c := range split(t, Limit) {
				parts = append(parts, Part{Text: c})
			}
		}
		text = nil
	}
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if fence, lang, ok := openFence(l); ok {
			var code []string
			for i++; i < len(lines) && strings.TrimSpace(lines[i]) != fence; i++ {
				code = append(code, lines[i])
			}
			body := strings.Join(code, "\n")
			if len(code) > longCode || len(body) > longBytes {
				flush()
				parts = append(parts, Part{Code: body, Lang: lang})
				continue
			}
			text = append(text, "```", body, "```")
			continue
		}
		if i+1 < len(lines) && strings.Contains(l, "|") && tableSep.MatchString(lines[i+1]) {
			rows := [][]string{cells(l)}
			for i += 2; i < len(lines) && strings.Contains(lines[i], "|") && strings.TrimSpace(lines[i]) != ""; i++ {
				rows = append(rows, cells(lines[i]))
			}
			i--
			flush()
			parts = append(parts, Part{Table: rows})
			continue
		}
		text = append(text, inline(l))
	}
	flush()
	return parts
}

func openFence(l string) (fence, lang string, ok bool) {
	t := strings.TrimSpace(l)
	for _, f := range []string{"```", "~~~"} {
		if strings.HasPrefix(t, f) {
			n := len(t) - len(strings.TrimLeft(t, f[:1]))
			return t[:n], strings.TrimSpace(t[n:]), true
		}
	}
	return "", "", false
}

func cells(l string) []string {
	l = strings.TrimSpace(l)
	l = strings.TrimSuffix(strings.TrimPrefix(l, "|"), "|")
	var out []string
	for _, c := range strings.Split(l, "|") {
		out = append(out, Plain(strings.TrimSpace(c)))
	}
	return out
}

func inline(l string) string {
	if m := heading.FindStringSubmatch(l); m != nil {
		return "*" + strings.Trim(Plain(m[1]), "*") + "*"
	}
	if rule.MatchString(l) {
		return "───"
	}
	l = bullet.ReplaceAllString(l, "$1- ")
	prefix := ""
	if q := quoteLine.FindString(l); q != "" {
		prefix, l = "> ", l[len(q):]
	}
	var spans []string
	l = codeSpan.ReplaceAllStringFunc(l, func(s string) string {
		spans = append(spans, s)
		return "\x00" + string(rune('a'+len(spans)-1)) + "\x00"
	})
	l = image.ReplaceAllString(l, "$1")
	l = link.ReplaceAllStringFunc(l, func(s string) string {
		m := link.FindStringSubmatch(s)
		if m[1] == m[2] || strings.TrimPrefix(m[2], "mailto:") == m[1] {
			return m[2]
		}
		return m[1] + " (" + m[2] + ")"
	})
	l = bold.ReplaceAllString(l, "\x01$1$2\x01")
	for range 2 {
		l = italic.ReplaceAllString(l, "${1}_${2}_$3")
	}
	l = strings.ReplaceAll(l, "\x01", "*")
	l = strike.ReplaceAllString(l, "~$1~")
	for i, s := range spans {
		l = strings.Replace(l, "\x00"+string(rune('a'+i))+"\x00", s, 1)
	}
	return prefix + l
}

// Plain drops Markdown emphasis and links, for text that is not shown as Markdown.
func Plain(s string) string {
	s = image.ReplaceAllString(s, "$1")
	s = link.ReplaceAllString(s, "$1")
	s = bold.ReplaceAllString(s, "$1$2")
	s = strike.ReplaceAllString(s, "$1")
	return strings.ReplaceAll(s, "`", "")
}

// split cuts text into chunks of at most n bytes, at a paragraph break once a chunk is
// mostly full, and closes and reopens a code block that has to be cut.
func split(t string, n int) []string {
	if len(t) <= n {
		return []string{t}
	}
	var out []string
	var cur strings.Builder
	code := false
	push := func() {
		s := strings.TrimSpace(cur.String())
		if code {
			s += "\n```"
		}
		if s != "```\n```" && s != "" {
			out = append(out, s)
		}
		cur.Reset()
		if code {
			cur.WriteString("```\n")
		}
	}
	for _, line := range strings.Split(t, "\n") {
		fence := strings.TrimSpace(line) == "```"
		for len(line) > n-16 {
			cut := n - 16
			for cut > 0 && !utf8.RuneStart(line[cut]) {
				cut--
			}
			push()
			cur.WriteString(line[:cut])
			line = line[cut:]
		}
		if !(fence && code) && (cur.Len()+len(line) > n-8 || cur.Len() > n*3/4 && line == "" && !code) {
			push()
		}
		cur.WriteString(line + "\n")
		if fence {
			code = !code
		}
	}
	code = false
	push()
	return out
}

// TableText lays a table out as monospace text, for when it cannot be sent as an image.
func TableText(rows [][]string) string {
	width := map[int]int{}
	for _, r := range rows {
		for i, c := range r {
			width[i] = max(width[i], utf8.RuneCountInString(c))
		}
	}
	var b strings.Builder
	b.WriteString("```\n")
	for k, r := range rows {
		for i, c := range r {
			if i > 0 {
				b.WriteString("  ")
			}
			b.WriteString(c + strings.Repeat(" ", width[i]-utf8.RuneCountInString(c)))
		}
		b.WriteString("\n")
		if k == 0 {
			total := 0
			for i := range len(width) {
				total += width[i] + 2
			}
			b.WriteString(strings.Repeat("─", max(0, total-2)) + "\n")
		}
	}
	b.WriteString("```")
	return b.String()
}
