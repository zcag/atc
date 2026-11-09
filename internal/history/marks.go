package history

import (
	"regexp"
	"strings"
)

// Mark is what atc or the call line said about one of the user's turns, drawn beside it rather than as its words:
// a scheduled wake-up and how often it comes, a conversation that started over and the one before it, a reply the
// user cut off and what they had heard of it, a second transcriber's reading of what they said, a call the assistant
// placed and why.
type Mark struct {
	Every   string `json:"every,omitempty"`
	Prev    string `json:"prev,omitempty"`
	Heard   string `json:"heard,omitempty"`
	Alt     string `json:"alt,omitempty"`
	AltOnly bool   `json:"altOnly,omitempty"`
	Called  bool   `json:"called,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

var (
	wakeUp = regexp.MustCompile(`^\[wake-up from your schedule, every ([^\]\n]+)\]\n`)
	// startedOver is atc's or the hub's first message of a conversation that started over, in whatever words: a
	// bracket naming the previous conversation's id, a blank line, then its handover note.
	startedOver = regexp.MustCompile(`^\[(?:atc|hub): [^\]\n]*\(([0-9a-f-]{8,36})\)[^\]\n]*\]\n\n`)
	callLines   []callNotes
	callStart   *regexp.Regexp
)

var placeholder = regexp.MustCompile(`\\\{\w+\\\}`)

const readNotes = "Read notes.md, then answer in one line."

type callNotes struct{ cut, too, only, outbound *regexp.Regexp }

// UseCallLines teaches the transcript the notes the call line adds to what the user said, in each language it
// speaks: a voice language pack's CUT_OFF, SECOND_TOO and SECOND_ONLY, and OUTBOUND, what the assistant reads when
// it places a call.
func UseCallLines(packs ...map[string]string) {
	callLines = nil
	for _, p := range packs {
		callLines = append(callLines, callNotes{fromTemplate(p["CUT_OFF"]), fromTemplate(p["SECOND_TOO"]), fromTemplate(p["SECOND_ONLY"]), fromTemplate(p["OUTBOUND"])})
	}
}

// UseCallStart teaches the transcript the line the hub opens a call the assistant placed with (the call.you_called
// and call.reason lines), so the call shows who rang whom and why instead of that line.
func UseCallStart(youCalled, reason string) {
	callStart = nil
	if !strings.Contains(youCalled, "%s") {
		return
	}
	q := strings.ReplaceAll(regexp.QuoteMeta(youCalled), "%s", `[^\]\n]*?`)
	if reason != "" {
		q += `(?:` + regexp.QuoteMeta(reason) + `(?P<reason>[^\]\n]*))?`
	}
	callStart = regexp.MustCompile(`^` + q + `\]\n?`)
}

// opened takes the hub's line opening a call the assistant placed off a turn, and the voice line's instruction
// that follows it.
func opened(t string) (string, *Mark) {
	if callStart == nil {
		return t, nil
	}
	m := callStart.FindStringSubmatch(t)
	if m == nil {
		return t, nil
	}
	k := &Mark{Called: true}
	if i := callStart.SubexpIndex("reason"); i > 0 {
		k.Reason = strings.TrimSpace(m[i])
	}
	t = strings.TrimSpace(t[len(m[0]):])
	t, _ = news(t)
	for _, c := range callLines {
		if c.outbound != nil && c.outbound.MatchString(t) {
			t = ""
		}
	}
	return t, k
}

func fromTemplate(t string) *regexp.Regexp {
	if t == "" {
		return nil
	}
	q := regexp.QuoteMeta(t)
	q = strings.ReplaceAll(q, `\{text\} `, `(?:(?P<text>.*) )?`)
	q = strings.ReplaceAll(q, ` \{text\}`, `(?: (?P<text>.*))?`)
	for _, f := range []string{"text", "heard", "second"} {
		q = strings.ReplaceAll(q, `\{`+f+`\}`, `(?P<`+f+`>.*?)`)
	}
	q = placeholder.ReplaceAllString(q, `.*?`)
	return regexp.MustCompile(`(?s)^` + q + `$`)
}

func groups(re *regexp.Regexp, t string) (map[string]string, bool) {
	if re == nil {
		return nil, false
	}
	m := re.FindStringSubmatch(t)
	if m == nil {
		return nil, false
	}
	got := map[string]string{}
	for i, n := range re.SubexpNames() {
		if n != "" {
			got[n] = strings.TrimSpace(m[i])
		}
	}
	return got, true
}

// marked takes what atc and the call line said about a turn of the user's off its words.
func marked(t string) (string, *Mark, string) {
	if m := wakeUp.FindStringSubmatch(t); m != nil {
		return strings.TrimSpace(t[len(m[0]):]), &Mark{Every: m[1]}, "wake"
	}
	if m := startedOver.FindStringSubmatch(t); m != nil {
		return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(t[len(m[0]):]), readNotes)), &Mark{Prev: m[1]}, "restart"
	}
	var k Mark
	for _, c := range callLines {
		if g, ok := groups(c.cut, t); ok {
			k.Heard, t = g["heard"], g["text"]
		}
		if g, ok := groups(c.too, t); ok {
			k.Alt, t = g["second"], g["text"]
		} else if g, ok := groups(c.only, t); ok {
			k.AltOnly, t = true, g["second"]
		}
	}
	if k == (Mark{}) {
		return t, nil, ""
	}
	return t, &k, ""
}
