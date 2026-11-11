package history

import (
	"cmp"
	"regexp"
	"strconv"
	"strings"
)

// WA is a WhatsApp message atc typed into a session, taken apart: which group or guest it came from, who wrote it
// and what came with it, so the page can draw it as a message rather than as atc's bracketed header.
type WA struct {
	Group     string `json:"group,omitempty"`
	GroupID   string `json:"groupId,omitempty"`
	You       bool   `json:"you,omitempty"`
	Name      string `json:"name,omitempty"`
	Number    string `json:"number,omitempty"`
	Guest     string `json:"guest,omitempty"`
	Voice     string `json:"voice,omitempty"`
	Mention   bool   `json:"mention,omitempty"`
	Forwarded bool   `json:"forwarded,omitempty"`
	Quote     string `json:"quote,omitempty"`
	Media     string `json:"media,omitempty"`
	Path      string `json:"path,omitempty"`
	Location  string `json:"location,omitempty"`
	Added     *WA    `json:"added,omitempty"`
	Members   []WA   `json:"members,omitempty"`
}

var (
	waGroupHead = regexp.MustCompile(`^\[WhatsApp group ("(?:[^"\\]|\\.)*") \((\S+@g\.us)\) · (.*)\]$`)
	waGuestHead = regexp.MustCompile(`^\[guest ([\w-]+) on WhatsApp(, a voice note)?\]$`)
	waDMHead    = regexp.MustCompile(`^\[WhatsApp DM · guest ([\w-]+)(.*)\]$`)
	waMember    = regexp.MustCompile(`^member ("(?:[^"\\]|\\.)*")(?:, guest ([\w-]+))? \(([^)]*)\)`)
	waSpoken    = regexp.MustCompile(`^, a voice note(?: spoken in (\w+))?`)
	waMedia     = regexp.MustCompile(`^\[([\w ]+): (/[^\]\n]+)\]$`)
	waVoice     = regexp.MustCompile(`^\[(voice note|audio)(?:, spoken in (\w+))?\] ?`)
	waLocation  = regexp.MustCompile(`^\[location: ([^\]\n]+)\]$`)
)

// whatsApp takes atc's WhatsApp wrapping off a message: a group's header and end mark, or a guest's.
func whatsApp(t string) (string, *WA) {
	head, body, _ := strings.Cut(t, "\n")
	if m := waGroupHead.FindStringSubmatch(head); m != nil {
		w := &WA{GroupID: m[2]}
		w.Group, _ = strconv.Unquote(m[1])
		rest := m[3]
		if by, ok := strings.CutPrefix(rest, "you were added by "); ok {
			w.Added = &WA{}
			waWho(w.Added, by)
			body = strings.TrimSuffix(strings.TrimSpace(body), "[end of message]")
			var others []string
			if list, ok := strings.CutPrefix(strings.TrimSpace(body), "Members: "); ok {
				for _, x := range strings.Split(list, "; ") {
					var mem WA
					waWho(&mem, x)
					w.Members = append(w.Members, mem)
					if !mem.You {
						others = append(others, waName(&mem))
					}
				}
			}
			said := "Added to " + w.Group + " by " + waName(w.Added)
			if len(others) > 0 {
				said += ", with " + strings.Join(others, ", ")
			}
			return said, w
		}
		rest = waWho(w, rest)
		for rest != "" {
			if s := waSpoken.FindStringSubmatch(rest); s != nil {
				w.Voice, rest = strings.ToLower(cmp.Or(s[1], "yes")), rest[len(s[0]):]
			} else if r, ok := strings.CutPrefix(rest, ", mentioning you"); ok {
				w.Mention, rest = true, r
			} else {
				break
			}
		}
		body = strings.TrimSuffix(strings.TrimRight(body, "\n "), "[end of message]")
		return waBody(w, body), w
	}
	if m := waGuestHead.FindStringSubmatch(head); m != nil {
		w := &WA{Guest: m[1]}
		if m[2] != "" {
			w.Voice = "yes"
		}
		body = strings.TrimSuffix(strings.TrimRight(body, "\n "), "[end of what guest "+m[1]+" wrote]")
		return waBody(w, body), w
	}
	if m := waDMHead.FindStringSubmatch(head); m != nil {
		w := &WA{Guest: m[1]}
		if s := waSpoken.FindStringSubmatch(m[2]); s != nil {
			w.Voice = strings.ToLower(cmp.Or(s[1], "yes"))
		}
		body = strings.TrimSuffix(strings.TrimRight(body, "\n "), "[end of message]")
		return waBody(w, body), w
	}
	return t, nil
}

// waWho reads who wrote a message from atc's words for them, and gives back what follows.
func waWho(w *WA, s string) string {
	if r, ok := strings.CutPrefix(s, "the user, verified by atc"); ok {
		w.You = true
		return r
	}
	m := waMember.FindStringSubmatch(s)
	if m == nil {
		w.Name = s
		return ""
	}
	w.Name, _ = strconv.Unquote(m[1])
	w.Guest = m[2]
	if n, ok := strings.CutPrefix(m[3], "+"); ok {
		w.Number = n
	}
	return s[len(m[0]):]
}

// waBody takes apart what atc wrote of a message: forwarded, the message it replies to, a voice note's
// transcript, a file it saved, a location. The text left is what the person wrote.
func waBody(w *WA, t string) string {
	t = strings.TrimSpace(t)
	if r, ok := strings.CutPrefix(t, "[forwarded]\n"); ok {
		w.Forwarded, t = true, r
	}
	var quote []string
	for strings.HasPrefix(t, "> ") || strings.HasPrefix(t, ">\n") {
		line, rest, _ := strings.Cut(t, "\n")
		quote, t = append(quote, strings.TrimPrefix(strings.TrimPrefix(line, ">"), " ")), rest
	}
	w.Quote, t = strings.Join(quote, "\n"), strings.TrimLeft(t, "\n")
	line, rest, _ := strings.Cut(t, "\n")
	switch {
	case waLocation.MatchString(line):
		w.Location, t = waLocation.FindStringSubmatch(line)[1], rest
	case waMedia.MatchString(line):
		m := waMedia.FindStringSubmatch(line)
		w.Media, w.Path, t = m[1], m[2], rest
	default:
		if m := waVoice.FindStringSubmatch(t); m != nil {
			w.Media = m[1]
			if m[2] != "" {
				w.Voice = strings.ToLower(m[2])
			}
			t = t[len(m[0]):]
		}
	}
	return strings.TrimSpace(t)
}

func waName(w *WA) string {
	switch {
	case w.You:
		return "you"
	case w.Name != "":
		return w.Name
	case w.Guest != "":
		return w.Guest
	case w.Number != "":
		return "+" + w.Number
	}
	return "someone"
}

// waLabel is how a WhatsApp sender is called where there is room for one name.
func waLabel(w *WA) string {
	if w.Added != nil {
		return "added to " + w.Group
	}
	who := waName(w)
	if w.Group != "" {
		return who + " in " + w.Group
	}
	return who + " on WhatsApp"
}
