package tui

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/summary"
)

func sample() model {
	now := time.Now()
	live := []sessions.Session{
		{SessionID: "s1", ID: "a1", Title: "Rate limit retries", State: sessions.NeedsYou, Host: "devbox", Cwd: "/home/u/proj/api", Branch: "rate-limit", Attachable: true, Updated: now.Add(-4 * time.Minute),
			Asks: []opencode.Ask{{Permission: "Bash", Patterns: []string{"go test ./... -run Retry"}}}},
		{SessionID: "s2", ID: "a2", Title: "Invoice export as CSV", State: sessions.YourTurn, Host: "laptop", Cwd: "/home/u/proj/billing", Attachable: true, Updated: now.Add(-22 * time.Minute),
			Summary: &summary.Summary{Status: "Done: CSV export with a header row."}},
		{SessionID: "s3", ID: "a3", Title: "Fix flaky upload test", State: sessions.Working, Host: "devbox", Cwd: "/home/u/proj/web", Attachable: true, Updated: now, PromptAt: now.Add(-65 * time.Second), Activity: "Running the test 50 times"},
		{SessionID: "s4", ID: "a4", Title: "Bump Go", State: sessions.Working, Host: "laptop", Cwd: "/home/u/proj/infra", Attachable: true, Updated: now},
	}
	ti := textinput.New()
	ti.Prompt = ""
	return model{ti: ti, c: &client.Client{URL: "http://devbox:7272"}, w: 100, h: 30, live: live, online: true, hosts: []string{"devbox", "laptop"}, home: "/home/u"}
}

func view(m model) string { return ansi.Strip(m.View()) }

func press(m model, keys ...string) model {
	for _, k := range keys {
		var msg tea.KeyMsg
		switch k {
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		default:
			msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
		}
		next, _ := m.Update(msg)
		m = next.(model)
	}
	return m
}

func TestRowsAreTwoLinesInGroupsWithTheirHost(t *testing.T) {
	v := view(sample())
	if os.Getenv("TUI_SHOW") != "" {
		t.Log("\n" + v)
	}
	for _, want := range []string{"atc devbox + laptop", "Live 4", "1 needs you", "2 working", "Waiting on you 1", "Your turn 1", "Working 2",
		" N  Rate limit retries", "devbox  api · rate-limit   4m", "Wants to run go test ./... -run Retry", "Done: CSV export", "1m 05s",
		"enter attach  n new  / filter  x stop  ? keys"} {
		if !strings.Contains(v, want) {
			t.Errorf("view lacks %q:\n%s", want, v)
		}
	}
	m := sample()
	m.hosts = nil
	if strings.Contains(view(m), "laptop  billing") {
		t.Error("one machine shows no host")
	}
}

func TestNarrowKeepsTheFooterWhole(t *testing.T) {
	m := sample()
	m.w = 58
	v := view(m)
	if !strings.Contains(v, "? keys") || strings.Contains(v, "rate-limit") {
		t.Errorf("narrow:\n%s", v)
	}
	for _, l := range strings.Split(v, "\n") {
		if ansi.StringWidth(l) > m.w {
			t.Errorf("line wider than %d: %q", m.w, l)
		}
	}
}

func TestKeysListsEveryKey(t *testing.T) {
	m := press(sample(), "?")
	v := view(m)
	if os.Getenv("TUI_SHOW") != "" {
		t.Log("\n" + v)
	}
	for _, want := range []string{"U  plan usage", "tab  live, history", "pgup pgdn  page", "g G  top, bottom", "? or esc closes."} {
		if !strings.Contains(v, want) {
			t.Errorf("keys lack %q:\n%s", want, v)
		}
	}
	if m = press(m, "esc"); m.keys {
		t.Error("esc does not close the keys")
	}
}

func TestCancelledConfirmSaysSo(t *testing.T) {
	m := press(sample(), "x")
	if !strings.Contains(view(m), "Stop Rate limit retries? y/n") {
		t.Fatalf("confirm:\n%s", view(m))
	}
	if m = press(m, "n"); m.status != "Left Rate limit retries running." {
		t.Errorf("cancelled stop: %q", m.status)
	}
}

func TestRenameToNothing(t *testing.T) {
	if got := renamed("Old", ""); got != "Old has Claude's own title again." {
		t.Errorf("empty name: %q", got)
	}
	if got := renamed("Old", "New"); got != "Renamed Old to New." {
		t.Errorf("a name: %q", got)
	}
}

func TestWizardStepsBack(t *testing.T) {
	m := sample()
	m.hosts = nil
	m = press(m, "n")
	if !strings.Contains(view(m), "Loading folders…") {
		t.Errorf("no loading line:\n%s", view(m))
	}
	next, _ := m.Update(dirsMsg{list: []client.Dir{{Path: "/home/u/proj/api"}}})
	m = press(next.(model), "enter")
	if m.in != newName {
		t.Fatalf("enter on a folder: %v", m.in)
	}
	if m = press(m, "esc"); m.in != newDir {
		t.Fatalf("esc on the name goes back to the folder: %v", m.in)
	}
	if m = press(m, "esc"); m.in != noInput || m.status != "No new session." {
		t.Fatalf("esc on the first step cancels: %v %q", m.in, m.status)
	}
}

func TestOfflineReadsAsASentence(t *testing.T) {
	m := sample()
	next, _ := m.Update(downMsg{errors.New("cannot reach atc: " + syscall.ECONNREFUSED.Error())})
	m = next.(model)
	wrapped, _ := m.Update(downMsg{&os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}})
	m = wrapped.(model)
	v := view(m)
	if !strings.Contains(v, "offline") || !strings.Contains(v, "atc isn't answering at devbox:7272. Trying again…") {
		t.Errorf("offline:\n%s", v)
	}
}

func TestScrollKeepsTheSelectionInView(t *testing.T) {
	m := sample()
	for i := range 30 {
		m.live = append(m.live, sessions.Session{SessionID: fmt.Sprint("x", i), Title: fmt.Sprint("Stopped ", i), State: sessions.Stopped, Cwd: "/home/u/proj/web"})
	}
	m.h = 20
	for _, k := range []string{"G", "k", "k", "pgup", "g", "j", "j", "j", "j", "j", "j", "j"} {
		m = press(m, k)
		s, _ := m.selected()
		if v := view(m); !strings.Contains(v, s.Title+" ") {
			t.Fatalf("after %s the selected %q is out of view:\n%s", k, s.Title, v)
		}
	}
}
