package usage

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestCost(t *testing.T) {
	tok := Tokens{Input: 1_000_000, Output: 1_000_000, CacheRead: 1_000_000, CacheWrite: 1_000_000}
	cases := []struct {
		model   string
		write1h int64
		fast    bool
		want    float64
	}{
		{"claude-opus-5-5", 0, false, 4 + 20 + 0.2 + 5},
		{"claude-opus-5-5", 1_000_000, false, 4 + 20 + 0.2 + 8},
		{"claude-opus-5-5", 0, true, 2 * (4 + 20 + 0.2 + 5)},
		{"claude-opus-4-8", 0, false, 5 + 25 + 0.5 + 6.25},
		{"claude-opus-4-1-20250805", 0, false, 15 + 75 + 1.5 + 18.75},
		{"claude-sonnet-4-5-20250929", 0, false, 3 + 15 + 0.3 + 3.75},
		{"claude-fable-5-1", 0, false, 10 + 50 + 0.25 + 12.5},
		{"claude-fable-5", 0, false, 10 + 50 + 1 + 12.5},
		{"claude-haiku-5-5", 0, false, 5 * (0.1 + 0.5 + 0.01 + 0.125)},
	}
	for _, c := range cases {
		got, ok := Cost(c.model, tok, c.write1h, c.fast)
		if !ok || !near(got, c.want) {
			t.Errorf("%s 1h=%d fast=%v: %v, want %v", c.model, c.write1h, c.fast, got, c.want)
		}
	}
	if got, _ := Cost("claude-haiku-5-5", Tokens{Input: 1000, Output: 1000}, 0, false); !near(got, (0.1*1000+0.5*1000)/1e6) {
		t.Errorf("short haiku prompt priced at the long rate: %v", got)
	}
	if _, ok := Cost("gpt-4", tok, 0, false); ok {
		t.Error("unknown model should be unpriced")
	}
}

const transcript = `{"type":"user","timestamp":"2026-10-01T10:00:00Z","origin":{"kind":"human"},"message":{"content":"fix it"}}
{"type":"assistant","timestamp":"2026-10-01T10:00:05Z","message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"thinking"}],"usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}}
{"type":"assistant","timestamp":"2026-10-01T10:00:06Z","message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"tool_use"}],"usage":{"input_tokens":10,"output_tokens":40,"cache_read_input_tokens":100,"cache_creation_input_tokens":50,"cache_creation":{"ephemeral_1h_input_tokens":50}}}}
{"type":"user","timestamp":"2026-10-01T10:00:07Z","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}
{"type":"assistant","timestamp":"2026-10-01T10:30:00Z","message":{"id":"m2","model":"claude-opus-5-5","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":1,"output_tokens":10,"cache_read_input_tokens":200,"cache_creation_input_tokens":0}}}
{"type":"user","timestamp":"2026-10-01T11:00:00Z","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>"}}
{"type":"user","timestamp":"2026-10-01T11:00:01Z","isMeta":true,"message":{"content":"meta"}}
{"type":"user","timestamp":"2026-10-01T12:00:00Z","message":{"content":"older format prompt"}}
{"type":"assistant","timestamp":"2026-10-01T12:00:30Z","isSidechain":true,"agentId":"x1","message":{"id":"s1","model":"claude-haiku-4-5","content":[{"type":"tool_use"}],"usage":{"input_tokens":5,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"assistant","timestamp":"2026-10-01T12:01:00Z","message":{"id":"m3","model":"<synthetic>","content":[{"type":"text","text":"limit"}],"usage":{"input_tokens":0,"output_tokens":0}}}
`

func TestSessionStats(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "abc.jsonl")
	os.WriteFile(path, []byte(transcript), 0o644)
	sub := filepath.Join(dir, "abc", "subagents")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "agent-a1.jsonl"), []byte(`{"type":"assistant","isSidechain":true,"agentId":"a1","timestamp":"2026-10-01T10:10:00Z","message":{"id":"a","model":"claude-sonnet-5-5","content":[{"type":"tool_use"},{"type":"tool_use"}],"usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
`), 0o644)

	var s Scanner
	st := s.Session(path)
	want := Tokens{Input: 10 + 1 + 5 + 1000, Output: 40 + 10 + 5 + 100, CacheRead: 300, CacheWrite: 50}
	if st.Tokens != want || st.Total != want.Total() || st.Messages != 4 {
		t.Fatalf("tokens %+v messages %d, want %+v", st.Tokens, st.Messages, want)
	}
	if st.Turns != 2 || st.ToolCalls != 4 || st.Subagents.Count != 2 || st.Subagents.Messages != 2 {
		t.Fatalf("turns %d tools %d subagents %+v", st.Turns, st.ToolCalls, st.Subagents)
	}
	if st.Wall != 2*3600+60 || st.Active != 6+10*60+60 {
		t.Fatalf("wall %d active %d", st.Wall, st.Active)
	}
	opus, _ := Cost("claude-opus-5-5", Tokens{10, 40, 100, 50}, 50, false)
	opus2, _ := Cost("claude-opus-5-5", Tokens{1, 10, 200, 0}, 0, false)
	haiku, _ := Cost("claude-haiku-4-5", Tokens{5, 5, 0, 0}, 0, false)
	sonnet, _ := Cost("claude-sonnet-5-5", Tokens{1000, 100, 0, 0}, 0, false)
	if !near(st.Cost, opus+opus2+haiku+sonnet) || !near(st.Subagents.Cost, haiku+sonnet) {
		t.Fatalf("cost %v sub %v", st.Cost, st.Subagents.Cost)
	}
	if !near(st.Costs.Sum(), st.Cost) || !near(st.Costs.Output, (40*20+10*20+5*5+100*10)/1e6) {
		t.Fatalf("split %+v", st.Costs)
	}
	if len(st.Models) != 3 || st.Models[1].Model != "claude-opus-5-5" || st.Models[1].Messages != 2 {
		t.Fatalf("models %+v", st.Models)
	}

	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"assistant","timestamp":"2026-10-01T12:02:00Z","message":{"id":"m4","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}` + "\n")
	f.Close()
	if st := s.Session(path); st.Input != want.Input+7 || st.Turns != 2 {
		t.Fatalf("incremental rescan: input %d turns %d", st.Input, st.Turns)
	}
}

func TestDays(t *testing.T) {
	root := t.TempDir()
	proj := filepath.Join(root, "-p")
	os.MkdirAll(filepath.Join(proj, "s1", "subagents"), 0o755)
	today := time.Now().UTC().Format(time.RFC3339)
	line := func(id string) string {
		return `{"type":"assistant","timestamp":"` + today + `","message":{"id":"` + id + `","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}` + "\n"
	}
	os.WriteFile(filepath.Join(proj, "s1.jsonl"), []byte(line("a")+line("b")), 0o644)
	os.WriteFile(filepath.Join(proj, "s1", "subagents", "agent-x.jsonl"), []byte(line("c")), 0o644)
	os.WriteFile(filepath.Join(proj, "s2.jsonl"), []byte(line("a")+line("d")), 0o644)
	os.WriteFile(filepath.Join(proj, "s3.jsonl"), []byte(strings.ReplaceAll(line("q"), "claude-opus-5-5", "qwen3:30b")), 0o644)
	var s Scanner
	if st := s.Session(filepath.Join(proj, "s3.jsonl")); len(st.Local) != 1 || len(st.Unpriced) != 0 || st.Total != 2 {
		t.Fatalf("local session %+v", st)
	}
	days := s.Days(root, 7)
	last := days[len(days)-1]
	if len(days) != 7 || last.Day != time.Now().Format(time.DateOnly) || last.Messages != 4 || last.Sessions != 2 || last.Total != 8 || !near(last.Hours[time.Now().Hour()], last.Cost) {
		t.Fatalf("days %+v", days)
	}
	merged := MergeDays(days, []Day{{Day: last.Day, Part: Part{Tokens: Tokens{Input: 5}, Cost: 1, Messages: 1}, Sessions: 1}})
	if m := merged[len(merged)-1]; m.Input != 9 || m.Total != 13 || m.Sessions != 3 || len(merged) != 7 || !near(m.Hours[time.Now().Hour()], last.Cost) {
		t.Fatalf("merged %+v", m)
	}
	sp := s.Spend(root, time.Now().Add(-time.Hour))
	if !near(sp.Cost, last.Cost) || len(sp.Sessions) != 2 || !near(sp.Sessions["s1"].Cost, 3*sp.Sessions["s2"].Cost) || sp.Sessions["s1"].Messages != 3 || len(sp.Models) != 1 {
		t.Fatalf("spend %+v", sp)
	}
}

const usageBody = `{"five_hour":{"utilization":2.0,"resets_at":"2026-10-23T06:49:59.908602+00:00"},
"seven_day":{"utilization":72.0,"resets_at":"2026-10-25T22:59:59.908620+00:00"},"seven_day_opus":null,
"limits":[{"kind":"session","group":"session","percent":2,"severity":"normal","resets_at":"2026-10-23T06:49:59.908602+00:00","scope":null},
{"kind":"weekly_all","group":"weekly","percent":72,"severity":"warning","resets_at":"2026-10-25T22:59:59.908620+00:00","scope":null},
{"kind":"weekly_scoped","group":"weekly","percent":0,"severity":"normal","resets_at":"2026-10-25T23:00:00+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null}}]}`

func TestParseWindows(t *testing.T) {
	now := time.Date(2026, 10, 23, 5, 0, 0, 0, time.UTC)
	ws := ParseWindows([]byte(usageBody), now)
	if len(ws) != 3 || ws[0].Label != "Current session" || ws[0].Percent != 2 || ws[1].Label != "This week, all models" ||
		ws[1].Severity != "warning" || ws[2].Label != "This week, Fable" || ws[1].ResetsAt.Day() != 25 {
		t.Fatalf("windows %+v", ws)
	}
	if ws := ParseWindows([]byte(usageBody), now.Add(3*time.Hour)); len(ws) != 2 || ws[0].Key == "session" {
		t.Fatalf("a window that already reset should be dropped: %+v", ws)
	}
	legacy := `{"five_hour":{"utilization":40.5,"resets_at":"2026-10-23T06:49:59Z"},"seven_day":null,"seven_day_opus":{"utilization":10,"resets_at":"2026-10-25T23:00:00Z"}}`
	if ws := ParseWindows([]byte(legacy), now); len(ws) != 2 || ws[0].Percent != 40.5 || ws[1].Label != "This week, Opus" {
		t.Fatalf("legacy %+v", ws)
	}
	if planName(Creds{SubscriptionType: "max", RateLimitTier: "default_claude_max_20x"}) != "Max 20x" || planName(Creds{SubscriptionType: "pro"}) != "Pro" {
		t.Fatal("plan name")
	}
}

func TestLimitsClient(t *testing.T) {
	status, calls := 200, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("anthropic-beta") == "" {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(status)
		w.Write([]byte(usageBody))
	}))
	defer srv.Close()
	creds := Creds{AccessToken: "tok", ExpiresAt: time.Now().Add(time.Hour).UnixMilli(), SubscriptionType: "max"}
	cached := func() ([]byte, time.Time, error) {
		return []byte(strings.ReplaceAll(usageBody, "2026-10-2", "2999-10-2")), time.Unix(1, 0), nil
	}
	c := &LimitsClient{URL: srv.URL, Creds: func() (Creds, error) { return creds, nil }, Cached: cached}
	l := c.Get(context.Background())
	if l.Source != "live" || l.Plan != "Max" || l.Error != "" || calls != 1 {
		t.Fatalf("live %+v (calls %d)", l, calls)
	}
	c.Get(context.Background())
	if calls != 1 {
		t.Fatal("second read within the cache window should not call out")
	}

	creds.ExpiresAt = time.Now().Add(-time.Minute).UnixMilli()
	c = &LimitsClient{URL: srv.URL, Creds: func() (Creds, error) { return creds, nil }, Cached: cached}
	if l := c.Get(context.Background()); l.Source != "cached" || len(l.Windows) != 3 || l.Error == "" || calls != 1 {
		t.Fatalf("expired sign-in should fall back to the cached copy without calling: %+v", l)
	}

	creds.ExpiresAt, status = 0, 429
	c = &LimitsClient{URL: srv.URL, Creds: func() (Creds, error) { return creds, nil }, Cached: cached}
	if l := c.Get(context.Background()); l.Source != "cached" || c.until.Before(time.Now().Add(4*time.Minute)) {
		t.Fatalf("rate limited: %+v until %v", l, c.until)
	}
}
