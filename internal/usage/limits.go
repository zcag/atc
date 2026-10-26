package usage

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/claude"
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
	URL    string
	HTTP   *http.Client
	Creds  func() (Creds, error)
	Cached func() ([]byte, time.Time, error)
	Tapped func() ([]byte, time.Time, error)
	Saved  string

	mu      sync.Mutex
	loaded  bool
	last    Limits
	err     string
	until   time.Time
	backoff time.Duration
}

type Creds struct {
	AccessToken      string `json:"accessToken"`
	ExpiresAt        int64  `json:"expiresAt"`
	SubscriptionType string `json:"subscriptionType"`
	RateLimitTier    string `json:"rateLimitTier"`
}

var errExpired = errors.New("Claude Code's sign-in has expired; it renews the next time a session runs")

func (c *LimitsClient) Get(ctx context.Context) Limits {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.loaded {
		c.loaded = true
		if b, err := os.ReadFile(c.savedPath()); err == nil {
			json.Unmarshal(b, &c.last)
		}
	}
	if now := time.Now(); now.After(c.until) {
		l, wait, err := c.fetch(ctx)
		c.last.Plan = cmp.Or(l.Plan, c.last.Plan)
		if err == nil {
			c.last, c.err, c.backoff, c.until = l, "", 0, now.Add(10*time.Minute)
			if b, err := json.Marshal(l); err == nil && os.MkdirAll(filepath.Dir(c.savedPath()), 0o755) == nil {
				os.WriteFile(c.savedPath(), b, 0o600)
			}
		} else {
			c.err = err.Error()
			if wait > 0 {
				c.backoff = min(max(2*c.backoff, wait), time.Hour)
			}
			c.until = now.Add(cmp.Or(c.backoff, time.Minute))
		}
	}
	return c.merged(time.Now())
}

func (c *LimitsClient) merged(now time.Time) Limits {
	l := c.last
	l.Windows = []Window{}
	for _, w := range c.last.Windows {
		if w.ResetsAt.IsZero() || w.ResetsAt.After(now) {
			l.Windows = append(l.Windows, w)
		}
	}
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
	if l.Source != "statusline" || now.Sub(l.FetchedAt) > 10*time.Minute {
		l.Error = c.err
	}
	return l
}

func (c *LimitsClient) savedPath() string {
	if c.Saved != "" {
		return c.Saved
	}
	return cachePath("limits.json")
}

func cachePath(name string) string {
	dir, _ := os.UserCacheDir()
	return filepath.Join(dir, "atc", name)
}

func (c *LimitsClient) fetch(ctx context.Context) (Limits, time.Duration, error) {
	cr, err := c.creds()
	if err != nil {
		return Limits{}, 0, err
	}
	l := Limits{Plan: planName(cr), Source: "live"}
	if cr.AccessToken == "" {
		return l, 0, errors.New("Claude Code is not signed in with a Claude account here")
	}
	if cr.ExpiresAt > 0 && time.UnixMilli(cr.ExpiresAt).Before(time.Now()) {
		return l, 0, errExpired
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", cmp.Or(c.URL, "https://api.anthropic.com/api/oauth/usage"), nil)
	req.Header.Set("Authorization", "Bearer "+cr.AccessToken)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("User-Agent", "atc")
	res, err := cmp.Or(c.HTTP, http.DefaultClient).Do(req)
	if err != nil {
		return l, 0, fmt.Errorf("could not reach Anthropic: %w", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	switch {
	case res.StatusCode == http.StatusTooManyRequests:
		secs, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		return l, max(time.Duration(secs)*time.Second, 5*time.Minute), errors.New("Anthropic asked to check less often")
	case res.StatusCode == http.StatusUnauthorized:
		return l, 0, errExpired
	case res.StatusCode != http.StatusOK:
		return l, 0, fmt.Errorf("usage request failed: %s", res.Status)
	}
	l.Windows, l.FetchedAt = ParseWindows(b, time.Now()), time.Now()
	return l, 0, nil
}

func (c *LimitsClient) creds() (Creds, error) {
	if c.Creds != nil {
		return c.Creds()
	}
	return ReadCreds()
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

func ReadCreds() (Creds, error) {
	var b []byte
	var err error
	if runtime.GOOS == "darwin" {
		b, err = exec.Command("security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output()
	}
	if runtime.GOOS != "darwin" || err != nil {
		b, err = os.ReadFile(filepath.Join(claude.ConfigDir(), ".credentials.json"))
	}
	if err != nil {
		return Creds{}, errors.New("no Claude Code sign-in found on this machine")
	}
	var v struct {
		Claude Creds `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return Creds{}, errors.New("could not read Claude Code's sign-in")
	}
	return v.Claude, nil
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

var tierRe = regexp.MustCompile(`_(\d+x)$`)

func planName(c Creds) string {
	p := c.SubscriptionType
	if p == "" {
		return ""
	}
	p = strings.ToUpper(p[:1]) + p[1:]
	if m := tierRe.FindStringSubmatch(c.RateLimitTier); m != nil {
		p += " " + m[1]
	}
	return p
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
