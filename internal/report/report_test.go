package report

import (
	"strings"
	"testing"
	"time"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/usage"
)

func TestNumbers(t *testing.T) {
	for in, want := range map[int64]string{0: "0", 999: "999", 1500: "1.5k", 15000: "15k", 2_400_000: "2.4M", 7_800_000_000: "7.8B"} {
		if got := Tokens(in); got != want {
			t.Errorf("Tokens(%d) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[float64]string{0: "$0.00", 0.004: "<$0.01", 1.825: "$1.82", 3149.6: "$3,150", 1234567: "$1,234,567"} {
		if got := Dollars(in); got != want {
			t.Errorf("Dollars(%v) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[time.Duration]string{30 * time.Second: "30s", 28 * time.Minute: "28m", 4*time.Hour + 41*time.Minute: "4h 41m", 64 * time.Hour: "2d 16h"} {
		if got := Span(in); got != want {
			t.Errorf("Span(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestModelName(t *testing.T) {
	for in, want := range map[string]string{"claude-opus-5-5": "Opus 5.5", "claude-sonnet-4-5-20250929": "Sonnet 4.5", "claude-fable-5": "Fable 5", "claude-opus-4-20250514": "Opus 4"} {
		if got := ModelName(in); got != want {
			t.Errorf("ModelName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLimits(t *testing.T) {
	now := time.Date(2026, 10, 23, 9, 0, 0, 0, time.Local)
	ws := []usage.Window{
		{Key: "session", Label: "Current session", Percent: 4.4, ResetsAt: now.Add(28 * time.Minute)},
		{Key: "weekly_all", Label: "This week, all models", Percent: 72.6, ResetsAt: now.Add(64 * time.Hour)},
		{Key: "weekly_scoped", Label: "This week, Fable", Percent: 0, ResetsAt: now.Add(64 * time.Hour)},
	}
	if got, want := LimitsShort(ws, now), "session 4% · week 73% · resets 28m"; got != want {
		t.Errorf("LimitsShort = %q, want %q", got, want)
	}
	if got := LimitsShort(nil, now); got != "" {
		t.Errorf("LimitsShort(nil) = %q", got)
	}
	lines := LimitLines(ws, now)
	if want := "Current session         4%  resets in 28m, 09:28"; lines[0] != want {
		t.Errorf("line 0 = %q, want %q", lines[0], want)
	}
	if want := "This week, all models  73%  resets in 2d 16h, Mon 01:00"; lines[1] != want {
		t.Errorf("line 1 = %q, want %q", lines[1], want)
	}
	if got := LimitsNote(usage.Limits{Error: "no sign-in"}, now); got != "Limits are not available here: no sign-in" {
		t.Errorf("note = %q", got)
	}
	if got := LimitsNote(usage.Limits{Windows: ws, Source: "cached", FetchedAt: now.Add(-3 * time.Hour)}, now); !strings.HasPrefix(got, "Not current") {
		t.Errorf("cached note = %q", got)
	}
}

func TestPlanTotals(t *testing.T) {
	now := time.Date(2026, 10, 23, 9, 0, 0, 0, time.Local)
	days := []usage.Day{{Day: "2026-10-22", Part: usage.Part{Total: 1_000_000, Cost: 1.5}, Sessions: 2}, {Day: "2026-10-23", Part: usage.Part{Total: 500_000, Cost: 0.5}, Sessions: 1}}
	out := strings.Join(Plan(usage.Limits{}, days, 0, now), "\n")
	for _, want := range []string{"Thu Oct 22", "Today", "1 session\n", "2 sessions", "Total", "1.5M tokens  ~$2.00", "Estimated"} {
		if !strings.Contains(out, want) {
			t.Errorf("plan lacks %q:\n%s", want, out)
		}
	}
}

func TestWeekUnits(t *testing.T) {
	for _, c := range []struct {
		cost, perPct float64
		want         string
	}{{1298, 29.7, "44% wk"}, {8288, 29.7, "279% wk"}, {60, 29.7, "2.0% wk"}, {0.01, 29.7, "<0.1% wk"}, {0, 29.7, ""}, {100, 0, ""}} {
		if got := Week(c.cost, c.perPct); got != c.want {
			t.Errorf("Week(%v, %v) = %q, want %q", c.cost, c.perPct, got, c.want)
		}
	}
	now := time.Date(2026, 10, 23, 9, 0, 0, 0, time.Local)
	out := strings.Join(Plan(usage.Limits{}, []usage.Day{{Day: "2026-10-23", Part: usage.Part{Total: 1, Cost: 297}, Sessions: 1}}, 29.7, now), "\n")
	for _, want := range []string{"~$297 (10% wk)", "100% wk is one week", "about $2,970"} {
		if !strings.Contains(out, want) {
			t.Errorf("plan lacks %q:\n%s", want, out)
		}
	}
}

func TestOutputs(t *testing.T) {
	now := time.Now()
	if got := Outputs(client.Outputs{}, "box", now); !strings.HasPrefix(got[0], "Nothing here yet") {
		t.Errorf("empty = %q", got)
	}
	o := client.Outputs{
		Servers: []client.Server{{URL: "http://box:5173/", LocalOnly: true}},
		Links:   []outputs.Link{{URL: "https://example.com/p", At: now.Add(-5 * time.Minute)}},
		Files: []client.File{
			{File: outputs.File{Path: "/srv/out/chart.png", Kind: "image", Op: "made", Size: 2048, At: now.Add(-2 * time.Hour)}, URL: "https://atc.example/o/chart.png"},
			{File: outputs.File{Path: "/srv/app/main.go", Kind: "text", Op: "edited", At: now}, URL: "https://atc.example/o/main.go"},
		},
	}
	out := strings.Join(Outputs(o, "box", now), "\n")
	want := `Running
  http://box:5173/  listens on localhost only, so it opens on box itself

Files
  chart.png  Image · 2 KB · made 2h ago
    /srv/out/chart.png
    https://atc.example/o/chart.png

Links
  https://example.com/p  5m ago

Code it touched
  main.go  edited just now
    /srv/app/main.go
    https://atc.example/o/main.go`
	if out != want {
		t.Errorf("got\n%s\nwant\n%s", out, want)
	}
}

func TestSession(t *testing.T) {
	st := usage.Stats{Part: usage.Part{Total: 2_400_000, Cost: 1.82}, Turns: 3, Active: 300, PricesAt: "October 2026",
		Models: []usage.ModelPart{{Model: "claude-opus-5-5", Part: usage.Part{Total: 2_400_000, Cost: 1.82, Messages: 1}}}}
	out := strings.Join(Session(st, 0), "\n")
	for _, want := range []string{"2.4M tokens · ~$1.82 at API prices (estimate) · 5m Claude working", "Turns         3", "Opus 5.5  2.4M tokens · ~$1.82 · 1 reply", "(October 2026)", "Wall time     n/a"} {
		if !strings.Contains(out, want) {
			t.Errorf("session lacks %q:\n%s", want, out)
		}
	}
}
