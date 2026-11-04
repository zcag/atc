package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/sessions"
)

func question(text string, labels ...string) opencode.Question {
	q := opencode.Question{Question: text}
	for _, l := range labels {
		q.Options = append(q.Options, struct {
			Label       string `json:"label"`
			Description string `json:"description,omitempty"`
		}{l, ""})
	}
	return q
}

func TestPushAsk(t *testing.T) {
	perm := sessions.Session{SessionID: "p", Host: "laptop", Asks: []opencode.Ask{{ID: "claude", Permission: "Bash", Patterns: []string{"bundle exec rspec"}}}}
	a := pushAsk(perm)
	if a == nil || a.SID != "p" || a.Host != "laptop" || a.Tool != "Bash" || a.Cmd != "bundle exec rspec" || a.Options != nil || a.Key != perm.Asks[0].Fingerprint() {
		t.Fatalf("permission: %+v", a)
	}
	if askBody(a) != "Wants to run bundle exec rspec" {
		t.Errorf("permission body: %q", askBody(a))
	}
	one := sessions.Session{SessionID: "q", Asks: []opencode.Ask{{ID: "claude", Questions: []opencode.Question{question("Back closes?", "Close the dialog", "Go back")}}}}
	if a := pushAsk(one); a == nil || a.Text != "Back closes?" || strings.Join(a.Options, "|") != "Close the dialog|Go back" || askBody(a) != "Back closes?" {
		t.Errorf("one question answers in one tap: %+v", a)
	}
	two := sessions.Session{SessionID: "r", Asks: []opencode.Ask{{ID: "claude", Questions: []opencode.Question{question("A?", "x"), question("B?", "y")}}}}
	if a := pushAsk(two); a == nil || a.Text != "A?" || a.Options != nil {
		t.Errorf("two questions are answered in atc, not from a tap: %+v", a)
	}
	if pushAsk(sessions.Session{}) != nil {
		t.Error("no ask, no push ask")
	}
}

func TestFingerprintTellsAsksApart(t *testing.T) {
	a := opencode.Ask{Permission: "Bash", Patterns: []string{"rm -rf build"}}
	b := opencode.Ask{Permission: "Bash", Patterns: []string{"rm -rf /"}}
	if a.Fingerprint() == b.Fingerprint() || a.Fingerprint() != a.Fingerprint() {
		t.Fatal("two commands must not share a key, and one command must keep its key")
	}
	q := opencode.Ask{Questions: []opencode.Question{question("Which?", "a", "b")}}
	q2 := q
	q2.Questions = []opencode.Question{question("Which?", "a", "b")}
	q2.Questions[0].Multiple = true
	if q.Fingerprint() != q2.Fingerprint() {
		t.Error("multi-select is not part of what was asked")
	}
}

func TestNeedsYouPushCarriesTheAsk(t *testing.T) {
	home, _ := os.UserHomeDir()
	list := []sessions.Session{{SessionID: "q", Title: "Q", State: sessions.NeedsYou, Cwd: home + "/proj/Storefront",
		Asks: []opencode.Ask{{ID: "claude", Questions: []opencode.Question{question("Keep both date formats?", "Keep both", "Normalise to cents")}}}}}
	got, _ := alerts(map[string]string{"q": sessions.Working}, list, func(sessions.Session) bool { return false })
	if len(got) != 1 || got[0].Ask == nil || got[0].Body != "Keep both date formats?" || got[0].Bay != "Storefront" || len(got[0].Ask.Options) != 2 {
		t.Fatalf("a question pushes with its options and its bay: %+v", got)
	}
	feed := widgetList(list)
	if feed[0].Ask == nil || feed[0].Ask.Key == "" || feed[0].Bay != "Storefront" {
		t.Errorf("the widget gets the same ask: %+v", feed[0])
	}
}

func TestBayOf(t *testing.T) {
	home, _ := os.UserHomeDir()
	for cwd, want := range map[string]string{
		home + "/proj/atc":                         "atc",
		home + "/proj/atc/.claude/worktrees/x/web": "atc",
		"/Users/someone/proj/shop":                 "shop",
		home + "/notes/daily":                      "notes",
		home:                                       "~",
		"/srv/data":                                "data",
		"/Users/someone/proj/Storefront/app/models/thing": "Storefront",
	} {
		if got := bayOf(sessions.Session{Cwd: cwd}); got != want {
			t.Errorf("bayOf(%q) = %q, want %q", cwd, got, want)
		}
	}
	if bayOf(sessions.Session{Cwd: home + "/proj/atc", Kind: "hub"}) != "" {
		t.Error("the assistant has no bay")
	}
}

func TestAnswerWhat(t *testing.T) {
	for want, a := range map[string]opencode.Answer{
		"Deny":         {Reject: true},
		"Allow once":   {Reply: "once"},
		"Always allow": {Reply: "always"},
		"Keep both":    {Answers: [][]string{{"Keep both"}}},
		"a, b; c":      {Answers: [][]string{{"a", "b"}, {"c"}}},
	} {
		if got := answerWhat(a); got != want {
			t.Errorf("answerWhat(%+v) = %q, want %q", a, got, want)
		}
	}
}

func TestAnswersAttach(t *testing.T) {
	var a answers
	a.mark("s1", sessions.Answered{Ask: "claude", What: "Deny", Via: "push", Device: "pixel", At: time.Now()})
	a.mark("old", sessions.Answered{What: "x", At: time.Now().Add(-2 * answeredFor)})
	list := []sessions.Session{{SessionID: "s1"}, {SessionID: "s2"}, {SessionID: "old"}}
	a.attach(list)
	if x := list[0].Answered; x == nil || x.Via != "push" || x.Device != "pixel" || x.What != "Deny" {
		t.Errorf("the answer rides on its session: %+v", x)
	}
	if list[1].Answered != nil || list[2].Answered != nil {
		t.Error("only the session answered, and only lately")
	}
}

func TestAnswerRefusesAStaleAsk(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	os.MkdirAll(filepath.Join(dir, "jobs", "loc00001"), 0o755)
	os.WriteFile(filepath.Join(dir, "jobs", "loc00001", "state.json"), []byte(`{"tempo":"blocked","needs":"approve Bash: rm -rf build"}`), 0o644)
	ts := newTestServer(t, nil, Voice{})
	res, body := do(t, "POST", ts.URL+"/api/sessions/l1/asks/claude?via=push&key=0123456789ab", "tok", `{"reply":"once"}`)
	if res.StatusCode != 409 || !strings.Contains(body, "no longer asks that") {
		t.Fatalf("an answer meant for an earlier ask must not reach this one: %d %q", res.StatusCode, body)
	}
	key := opencode.Ask{Permission: "Bash", Patterns: []string{"rm -rf build"}}.Fingerprint()
	res, body = do(t, "POST", ts.URL+"/api/sessions/l1/asks/claude?via=push&key="+key, "tok", `{"reply":"once"}`)
	if res.StatusCode != 200 {
		t.Fatalf("the ask on screen is answered: %d %q", res.StatusCode, body)
	}
	if _, list := get(t, ts.URL+"/api/sessions", "tok"); !strings.Contains(list, `"what":"Allow once","via":"push"`) {
		t.Errorf("the list says where it was answered: %s", list)
	}
}
