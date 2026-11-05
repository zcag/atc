package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

type Window struct {
	Key      string    `json:"key"`
	Label    string    `json:"label"`
	Percent  float64   `json:"percent"`
	ResetsAt time.Time `json:"resetsAt,omitzero"`
	Severity string    `json:"severity,omitempty"`
	Scope    string    `json:"scope,omitempty"`
}

func (w Window) From() time.Time {
	if w.Key == "session" {
		return w.ResetsAt.Add(-5 * time.Hour)
	}
	return w.ResetsAt.Add(-7 * 24 * time.Hour)
}

func (w Window) Counts(model string) bool {
	return w.Scope == "" || strings.Contains(model, strings.ToLower(w.Scope))
}

type Limits struct {
	Plan      string    `json:"plan,omitempty"`
	Windows   []Window  `json:"windows"`
	FetchedAt time.Time `json:"fetchedAt,omitzero"`
	Source    string    `json:"source,omitempty"`
	Error     string    `json:"error,omitempty"`
}

type LimitsClient struct {
	Cached func() ([]byte, time.Time, error)
	Tapped func() ([]byte, time.Time, error)
}

// Get is the latest Claude Code itself reported: what it handed its status line, or the copy it keeps for /usage. atc
// never reads its sign-in or asks Anthropic on its own.
func (c *LimitsClient) Get(_ context.Context) Limits {
	return c.merged(time.Now())
}

func (c *LimitsClient) merged(now time.Time) Limits {
	l := Limits{Windows: []Window{}}
	for _, src := range []struct {
		name string
		read func() ([]byte, time.Time, error)
	}{{"cached", c.cached}, {"statusline", c.tapped}} {
		b, at, err := src.read()
		if err != nil || !at.After(l.FetchedAt) {
			continue
		}
		ws := ParseWindows(b, now)
		if len(ws) == 0 {
			continue
		}
		for _, w := range ws {
			if i := slices.IndexFunc(l.Windows, func(o Window) bool { return o.Key == w.Key }); i >= 0 {
				l.Windows[i] = w
			} else {
				l.Windows = append(l.Windows, w)
			}
		}
		l.FetchedAt, l.Source = at, src.name
	}
	sort.SliceStable(l.Windows, func(i, j int) bool { return l.Windows[i].Key == "session" && l.Windows[j].Key != "session" })
	if len(l.Windows) == 0 {
		l.Error = "no reading yet: atc setup points Claude Code's status line at atc, and a running session then reports them"
	}
	return l
}

func (c *LimitsClient) cached() ([]byte, time.Time, error) {
	if c.Cached != nil {
		return c.Cached()
	}
	return ReadCached()
}

func (c *LimitsClient) tapped() ([]byte, time.Time, error) {
	if c.Tapped != nil {
		return c.Tapped()
	}
	return ReadTapped()
}

func cachePath(name string) string {
	dir, _ := os.UserCacheDir()
	return filepath.Join(dir, "atc", name)
}

func ReadTapped() ([]byte, time.Time, error) {
	p := cachePath("statusline-limits.json")
	st, err := os.Stat(p)
	if err != nil {
		return nil, time.Time{}, err
	}
	b, err := os.ReadFile(p)
	return b, st.ModTime(), err
}

func Tap(r io.Reader) error {
	var in struct {
		RateLimits map[string]struct {
			UsedPercentage *float64 `json:"used_percentage"`
			ResetsAt       float64  `json:"resets_at"`
		} `json:"rate_limits"`
	}
	if err := json.NewDecoder(r).Decode(&in); err != nil {
		return err
	}
	out := map[string]window{}
	for k, v := range in.RateLimits {
		if k != "five_hour" && k != "seven_day" || v.UsedPercentage == nil {
			continue
		}
		secs := int64(v.ResetsAt)
		if secs > 1e12 {
			secs /= 1000
		}
		out[k] = window{v.UsedPercentage, time.Unix(secs, 0).UTC().Format(time.RFC3339)}
	}
	if len(out) == 0 {
		return nil
	}
	b, _ := json.Marshal(out)
	p := cachePath("statusline-limits.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d", p, os.Getpid())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func ReadCached() ([]byte, time.Time, error) {
	home, _ := os.UserHomeDir()
	b, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		return nil, time.Time{}, err
	}
	var v struct {
		C struct {
			FetchedAtMs int64           `json:"fetchedAtMs"`
			Utilization json.RawMessage `json:"utilization"`
		} `json:"cachedUsageUtilization"`
	}
	if err := json.Unmarshal(b, &v); err != nil || v.C.Utilization == nil {
		return nil, time.Time{}, errors.New("no cached usage")
	}
	return v.C.Utilization, time.UnixMilli(v.C.FetchedAtMs), nil
}

type window struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

func ParseWindows(b []byte, now time.Time) []Window {
	var v struct {
		Limits []struct {
			Kind     string   `json:"kind"`
			Percent  *float64 `json:"percent"`
			Severity string   `json:"severity"`
			ResetsAt string   `json:"resets_at"`
			Scope    *struct {
				Model *struct {
					DisplayName string `json:"display_name"`
				} `json:"model"`
			} `json:"scope"`
		} `json:"limits"`
		FiveHour   *window `json:"five_hour"`
		SevenDay   *window `json:"seven_day"`
		WeekOpus   *window `json:"seven_day_opus"`
		WeekSonnet *window `json:"seven_day_sonnet"`
	}
	if json.Unmarshal(b, &v) != nil {
		return nil
	}
	out := []Window{}
	add := func(key, label string, pct *float64, resets, severity, scope string) {
		at, _ := time.Parse(time.RFC3339Nano, resets)
		if pct == nil || !at.IsZero() && at.Before(now) {
			return
		}
		out = append(out, Window{key, label, *pct, at, severity, scope})
	}
	for _, l := range v.Limits {
		label, scope := strings.ReplaceAll(l.Kind, "_", " "), ""
		switch l.Kind {
		case "session":
			label = "Current session"
		case "weekly_all":
			label = "This week, all models"
		case "weekly_scoped":
			label = "This week"
			if l.Scope != nil && l.Scope.Model != nil && l.Scope.Model.DisplayName != "" {
				scope = l.Scope.Model.DisplayName
				label += ", " + scope
			}
		}
		add(l.Kind, label, l.Percent, l.ResetsAt, l.Severity, scope)
	}
	if len(v.Limits) == 0 {
		for _, w := range []struct {
			key, label, scope string
			w                 *window
		}{{"session", "Current session", "", v.FiveHour}, {"weekly_all", "This week, all models", "", v.SevenDay},
			{"weekly_opus", "This week, Opus", "Opus", v.WeekOpus}, {"weekly_sonnet", "This week, Sonnet", "Sonnet", v.WeekSonnet}} {
			if w.w != nil {
				add(w.key, w.label, w.w.Utilization, w.w.ResetsAt, "", w.scope)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Key == "session" && out[j].Key != "session" })
	return out
}
