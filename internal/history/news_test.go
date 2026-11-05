package history

import "testing"

func TestNewsGoesWhateverComesAhead(t *testing.T) {
	in := "[talk-mode: atc, until the next talk-mode line]\nbe short\n[message]\n[atc now, 20:15]\nYour turn: none\n\nhello"
	if got := unpaste(in); got != "hello" {
		t.Errorf("%q", got)
	}
}

func TestWithoutNews(t *testing.T) {
	for in, want := range map[string]string{
		"[atc now, 20:15]\nYour turn: none\n\nhello":        "hello",
		"[atc since your last turn, 20:15]\none\ntwo\n\nhi": "hi",
		"hello\n\nthere": "hello\n\nthere",
		"[atc now, 20:15]\nan older message with no blank line": "[atc now, 20:15]\nan older message with no blank line",
	} {
		if got := withoutNews(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}
