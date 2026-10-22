package sessions

import "testing"

func TestTilde(t *testing.T) {
	for in, want := range map[string]string{
		"/home/u":           "~",
		"/home/u/proj/x":    "~/proj/x",
		"/Users/other/code": "~/code",
		"/Users/other":      "~",
		"/srv/app":          "/srv/app",
	} {
		if got := Tilde(in, "/home/u"); got != want {
			t.Errorf("Tilde(%q) = %q, want %q", in, got, want)
		}
	}
}
