package report

import (
	"cmp"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/usage"
)

func Tokens(n int64) string {
	for _, u := range []struct {
		d float64
		s string
	}{{1e9, "B"}, {1e6, "M"}, {1e3, "k"}} {
		if f := float64(n); f >= u.d {
			prec := 1
			if f >= u.d*10 {
				prec = 0
			}
			return strconv.FormatFloat(f/u.d, 'f', prec, 64) + u.s
		}
	}
	return strconv.FormatInt(n, 10)
}

func Dollars(c float64) string {
	switch {
	case c > 0 && c < 0.01:
		return "<$0.01"
	case c >= 100:
		s := strconv.FormatInt(int64(math.Round(c)), 10)
		for i := len(s) - 3; i > 0; i -= 3 {
			s = s[:i] + "," + s[i:]
		}
		return "$" + s
	}
	return fmt.Sprintf("$%.2f", c)
}

func Span(d time.Duration) string {
	sec := d.Seconds()
	m := int(math.Round(sec / 60))
	h := m / 60
	switch {
	case sec < 60:
		return fmt.Sprintf("%ds", max(0, int(math.Round(sec))))
	case m < 60:
		return fmt.Sprintf("%dm", m)
	case h < 48:
		return fmt.Sprintf("%dh %dm", h, m%60)
	}
	return fmt.Sprintf("%dd %dh", h/24, h%24)
}

func Ago(t, now time.Time) string {
	switch d := now.Sub(t); {
	case t.IsZero():
		return ""
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func Reset(t, now time.Time) string {
	d := t.Sub(now)
	switch {
	case t.IsZero():
		return ""
	case d <= 0:
		return "resetting now"
	}
	layout := "Mon 15:04"
	if d < 20*time.Hour {
		layout = "15:04"
	}
	return "resets in " + Span(d) + ", " + t.Local().Format(layout)
}

func Pct(p float64) string { return fmt.Sprintf("%d%%", int(math.Round(p))) }

var short = map[string]string{"session": "session", "weekly_all": "week"}

func LimitsShort(ws []usage.Window, now time.Time) string {
	var parts []string
	reset := ""
	for _, w := range ws {
		if s, ok := short[w.Key]; ok {
			parts = append(parts, s+" "+Pct(w.Percent))
		}
		if w.Key == "session" && w.ResetsAt.After(now) {
			reset = "resets " + Span(w.ResetsAt.Sub(now))
		}
	}
	if len(parts) > 0 && reset != "" {
		parts = append(parts, reset)
	}
	return strings.Join(parts, " · ")
}

func LimitLines(ws []usage.Window, now time.Time) []string {
	n := 0
	for _, w := range ws {
		n = max(n, len(w.Label))
	}
	out := make([]string, len(ws))
	for i, w := range ws {
		out[i] = strings.TrimRight(fmt.Sprintf("%-*s %4s  %s", n, w.Label, Pct(w.Percent), Reset(w.ResetsAt, now)), " ")
	}
	return out
}

func LimitsNote(l usage.Limits, now time.Time) string {
	if len(l.Windows) == 0 {
		if l.Error != "" {
			return "Limits are not available here: " + l.Error
		}
		return "Limits are not available here."
	}
	var s string
	switch l.Source {
	case "live":
		s = "Checked " + Ago(l.FetchedAt, now) + " with your Claude account."
	case "cached":
		s = "Not current: from Claude Code's last check, " + Ago(l.FetchedAt, now) + "."
	}
	if l.Error != "" {
		s = strings.TrimSpace(s + " " + l.Error + ".")
	}
	return s
}

func Estimate(asOf string) string {
	if asOf != "" {
		asOf = " (" + asOf + ")"
	}
	return "Estimated from the transcripts at Claude API list prices" + asOf +
		". A Claude subscription is not billed per token; this shows what the same work would cost on the API."
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func dayLine(d usage.Day) string {
	if d.Total == 0 {
		return "no usage"
	}
	return fmt.Sprintf("%6s tokens  ~%-9s %s", Tokens(d.Total), Dollars(d.Cost), plural(d.Sessions, "session", "sessions"))
}

func Plan(l usage.Limits, days []usage.Day, now time.Time) []string {
	var out []string
	if l.Plan != "" {
		out = append(out, l.Plan+" plan", "")
	}
	out = append(out, "Plan limits")
	for _, s := range LimitLines(l.Windows, now) {
		out = append(out, "  "+s)
	}
	if n := LimitsNote(l, now); n != "" {
		out = append(out, "  "+n)
	}
	if len(days) == 0 {
		return out
	}
	out = append(out, "", fmt.Sprintf("Last %d days", len(days)))
	var sum usage.Day
	today := now.Format("2006-01-02")
	for _, d := range days {
		sum.Total += d.Total
		sum.Cost += d.Cost
		label := d.Day
		if t, err := time.ParseInLocation("2006-01-02", d.Day, time.Local); err == nil {
			label = t.Format("Mon Jan 02")
		}
		if d.Day == today {
			label = "Today     "
		}
		out = append(out, "  "+label+"  "+dayLine(d))
	}
	out = append(out, fmt.Sprintf("  Total       %6s tokens  ~%s", Tokens(sum.Total), Dollars(sum.Cost)), "", Estimate(""))
	return out
}

var (
	dated   = regexp.MustCompile(`-(\d+)-(\d{1,2})(-\d{8})?$`)
	version = regexp.MustCompile(`-(\d+)(-\d{8})?$`)
)

func ModelName(m string) string {
	n := strings.TrimPrefix(m, "claude-")
	if dated.MatchString(n) {
		n = dated.ReplaceAllString(n, " $1.$2")
	} else {
		n = version.ReplaceAllString(n, " $1")
	}
	if n == "" {
		return m
	}
	return strings.ToUpper(n[:1]) + n[1:]
}

func facts(rows [][2]string) []string {
	n := 0
	for _, r := range rows {
		n = max(n, len(r[0]))
	}
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = fmt.Sprintf("  %-*s  %s", n, r[0], r[1])
	}
	return out
}

func Session(st usage.Stats) []string {
	sub := "none"
	if st.Subagents.Count > 0 {
		sub = fmt.Sprintf("%d · %s tokens · ~%s", st.Subagents.Count, Tokens(st.Subagents.Total), Dollars(st.Subagents.Cost))
	}
	wall := "n/a"
	if !st.Start.IsZero() {
		wall = Span(time.Duration(st.Wall)*time.Second) + ", since " + st.Start.Local().Format("Jan 2 15:04")
	}
	out := []string{fmt.Sprintf("%s tokens · ~%s at API prices (estimate) · %s Claude working",
		Tokens(st.Total), Dollars(st.Cost), Span(time.Duration(st.Active)*time.Second)), ""}
	out = append(out, facts([][2]string{
		{"Input", Tokens(st.Input)}, {"Output", Tokens(st.Output)}, {"Cache reads", Tokens(st.CacheRead)},
		{"Cache writes", Tokens(st.CacheWrite)}, {"Turns", strconv.Itoa(st.Turns)}, {"Tool calls", strconv.Itoa(st.ToolCalls)},
		{"Subagents", sub}, {"Wall time", wall},
	})...)
	if len(st.Models) > 0 {
		out = append(out, "", "Models")
		rows := make([][2]string, len(st.Models))
		for i, m := range st.Models {
			rows[i] = [2]string{ModelName(m.Model), fmt.Sprintf("%s tokens · ~%s · %s", Tokens(m.Total), Dollars(m.Cost), plural(m.Messages, "reply", "replies"))}
		}
		out = append(out, facts(rows)...)
	}
	note := Estimate(st.PricesAt)
	if len(st.Unpriced) > 0 {
		note += " No price known for " + strings.Join(st.Unpriced, ", ") + ", so it counts as $0."
	}
	return append(out, "", note)
}

var kindLabel = map[string]string{"table": "Table", "image": "Image", "html": "Page", "markdown": "Notes",
	"pdf": "PDF", "video": "Video", "audio": "Audio", "text": "File"}

func Size(n int64) string {
	if n > 1<<20 {
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%d KB", max(1, int(math.Round(float64(n)/1024))))
}

func Outputs(o client.Outputs, host string, now time.Time) []string {
	if len(o.Servers)+len(o.Featured)+len(o.Links)+len(o.Files) == 0 {
		return []string{"Nothing here yet. Files this session writes, pages it publishes and servers it starts show up here."}
	}
	var out []string
	section := func(title string) {
		if len(out) > 0 {
			out = append(out, "")
		}
		out = append(out, title)
	}
	if len(o.Servers) > 0 {
		section("Running")
		for _, v := range o.Servers {
			note := "started by this session"
			if v.LocalOnly {
				note = "listens on localhost only, so it opens on " + cmp.Or(host, "that machine") + " itself"
			}
			out = append(out, "  "+v.URL+"  "+note)
		}
	}
	if len(o.Featured) > 0 {
		section("Published")
		for _, l := range o.Featured {
			out = append(out, strings.TrimRight("  "+cmp.Or(l.Title, l.URL)+"  "+Ago(l.At, now), " "))
			if l.Title != "" {
				out = append(out, "    "+l.URL)
			}
		}
	}
	var made, code []client.File
	for _, f := range o.Files {
		if f.Kind == "text" {
			code = append(code, f)
		} else {
			made = append(made, f)
		}
	}
	file := func(f client.File, meta string) {
		out = append(out, "  "+filepath.Base(f.Path)+"  "+meta, "    "+f.Path, "    "+f.URL)
	}
	if len(made) > 0 {
		section("Files")
		for _, f := range made {
			meta := kindLabel[f.Kind]
			if f.Size > 0 {
				meta += " · " + Size(f.Size)
			}
			file(f, strings.TrimSpace(meta+" · "+f.Op+" "+Ago(f.At, now)))
		}
	}
	if len(o.Links) > 0 {
		section("Links")
		for _, l := range o.Links {
			out = append(out, strings.TrimRight("  "+l.URL+"  "+Ago(l.At, now), " "))
		}
	}
	if len(code) > 0 {
		section("Code it touched")
		for _, f := range code {
			file(f, strings.TrimSpace(f.Op+" "+Ago(f.At, now)))
		}
	}
	return out
}
