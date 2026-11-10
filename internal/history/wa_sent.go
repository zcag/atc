package history

import (
	"regexp"
	"strings"
)

// WASent is what a session sent with atc wa: to whom, the text, and what went with it.
type WASent struct {
	Group string   `json:"group,omitempty"`
	To    string   `json:"to,omitempty"`
	Text  string   `json:"text,omitempty"`
	Files []string `json:"files,omitempty"`
	Voice string   `json:"voice,omitempty"`
	Poll  string   `json:"poll,omitempty"`
}

var (
	waCmd     = regexp.MustCompile(`(?:^|[\s;&|(])atc wa(?:\s|$)`)
	heredoc   = regexp.MustCompile(`(?s)<<-?\s*(['"]?)(\w+)['"]?[^\n]*\n(.*?)\n\s*(\w+)\s*(?:\n|$)`)
	waSentOut = regexp.MustCompile(`(?m)^Sent on WhatsApp`)
)

// waSent reads an atc wa command: its flags and text, the text from a heredoc when it is piped one.
func waSent(cmd string) *WASent {
	loc := waCmd.FindStringIndex(cmd)
	if loc == nil {
		return nil
	}
	line := cmd[loc[1]:]
	var stdin string
	if m := heredoc.FindStringSubmatch(cmd); m != nil && m[2] == m[4] {
		stdin = m[3]
		if i := strings.Index(line, "<<"); i >= 0 {
			line = line[:i]
		}
	}
	words := shellWords(line)
	s := &WASent{}
	var text []string
	for i := 0; i < len(words); i++ {
		w := words[i]
		flag, val, inline := strings.Cut(strings.TrimLeft(w, "-"), "=")
		next := func() string {
			if inline {
				return val
			}
			if i+1 < len(words) {
				i++
				return words[i]
			}
			return ""
		}
		switch {
		case !strings.HasPrefix(w, "-"):
			text = append(text, w)
		case flag == "group":
			s.Group = next()
		case flag == "to":
			s.To = next()
		case flag == "file" || flag == "f" || flag == "render":
			s.Files = append(s.Files, next())
		case flag == "voice":
			s.Voice = next()
		case flag == "poll":
			s.Poll = next()
		case flag == "caption", flag == "option", flag == "o":
			next()
		}
	}
	s.Text = strings.TrimSpace(strings.Join(text, " "))
	if s.Text == "" {
		s.Text = strings.TrimSpace(stdin)
	}
	return s
}

// shellWords splits a command line the way a shell would for plain quoting: '...', "..." with backslash escapes,
// and $'...'. It stops at the end of the command (;, &&, ||, |, a newline outside quotes).
func shellWords(s string) []string {
	var out []string
	var b strings.Builder
	started := false
	flush := func() {
		if started {
			out = append(out, b.String())
		}
		b.Reset()
		started = false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\'' || c == '$' && i+1 < len(s) && s[i+1] == '\'':
			ansi := c == '$'
			if ansi {
				i++
			}
			started = true
			for i++; i < len(s) && s[i] != '\''; i++ {
				if ansi && s[i] == '\\' && i+1 < len(s) {
					i++
					switch s[i] {
					case 'n':
						b.WriteByte('\n')
					case 't':
						b.WriteByte('\t')
					default:
						b.WriteByte(s[i])
					}
					continue
				}
				b.WriteByte(s[i])
			}
		case c == '"':
			started = true
			for i++; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("\"\\$`\n", s[i+1]) >= 0 {
					i++
				}
				b.WriteByte(s[i])
			}
		case c == '\\' && i+1 < len(s):
			i++
			started = true
			b.WriteByte(s[i])
		case c == ' ' || c == '\t':
			flush()
		case c == '\n' || c == ';' || c == '|' || c == '&' || c == '>' || c == '<':
			if (c == '>' || c == '<') && strings.Trim(b.String(), "0123456789") == "" {
				started = false
			}
			flush()
			return out
		default:
			started = true
			b.WriteByte(c)
		}
	}
	flush()
	return out
}
