// Package when writes times the one way atc shows them: an age ("4m"), a clock ("14:05"),
// a stamp ("Tue 14:05", "3 Nov 14:05", "3 Nov 2025 14:05") and a duration ("4m 05s").
package when

import (
	"fmt"
	"time"
)

const day = 24 * time.Hour

// Age is how long ago t was: now, 4m, 3h, 2d, 5w. Empty for a zero time.
func Age(t, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	switch d := now.Sub(t); {
	case d < 45*time.Second:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", max(1, int(d.Minutes())))
	case d < day:
		return fmt.Sprintf("%dh", int(d.Hours()))
	case d < 14*day:
		return fmt.Sprintf("%dd", int(d/day))
	default:
		return fmt.Sprintf("%dw", int(d/(7*day)))
	}
}

// Clock is the time of day, for a moment known to be today.
func Clock(t time.Time) string { return t.Format("15:04") }

// Day is the day a stamp writes: Tue within a week of now, 3 Nov this year, 3 Nov 2025 before.
func Day(t, now time.Time) string {
	t = t.In(now.Location())
	switch {
	case daysApart(t, now) < 7:
		return t.Format("Mon")
	case t.Year() == now.Year():
		return t.Format("2 Jan")
	}
	return t.Format("2 Jan 2006")
}

// Stamp is a moment on any day, its Day and its Clock. Empty for a zero time.
func Stamp(t, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	return Day(t, now) + " " + Clock(t.In(now.Location()))
}

// Today is the Clock when t is on now's day, else the Stamp.
func Today(t, now time.Time) string {
	if !t.IsZero() && daysApart(t.In(now.Location()), now) == 0 {
		return Clock(t.In(now.Location()))
	}
	return Stamp(t, now)
}

// Duration is how long something took: 45s, 4m 05s, 3h 05m, 2d 4h.
func Duration(d time.Duration) string {
	d = max(0, d.Round(time.Second))
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm %02ds", int(d.Minutes()), int(d.Seconds())%60)
	case d < day:
		return fmt.Sprintf("%dh %02dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dd %dh", int(d/day), int(d.Hours())%24)
}

func daysApart(a, b time.Time) int {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	d := time.Date(by, bm, bd, 0, 0, 0, 0, time.UTC).Sub(time.Date(ay, am, ad, 0, 0, 0, 0, time.UTC))
	return int((d / day).Abs())
}
