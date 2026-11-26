package when

import (
	"testing"
	"time"
)

var now = time.Date(2026, 11, 24, 15, 30, 0, 0, time.UTC)

func TestAge(t *testing.T) {
	for d, want := range map[time.Duration]string{
		12 * time.Second: "now", 50 * time.Second: "1m", 4*time.Minute + 20*time.Second: "4m",
		3*time.Hour + 50*time.Minute: "3h", 50 * time.Hour: "2d", 13 * day: "13d", 36 * day: "5w", -time.Minute: "now",
	} {
		if got := Age(now.Add(-d), now); got != want {
			t.Errorf("Age(%v) = %q, want %q", d, got, want)
		}
	}
	if Age(time.Time{}, now) != "" {
		t.Error("a zero time has no age")
	}
}

func TestStamp(t *testing.T) {
	for _, c := range []struct {
		at   time.Time
		want string
	}{
		{time.Date(2026, 11, 24, 9, 7, 0, 0, time.UTC), "Tue 09:07"},
		{time.Date(2026, 11, 18, 23, 58, 0, 0, time.UTC), "Wed 23:58"},
		{time.Date(2026, 11, 3, 14, 5, 0, 0, time.UTC), "3 Nov 14:05"},
		{time.Date(2025, 11, 3, 14, 5, 0, 0, time.UTC), "3 Nov 2025 14:05"},
		{time.Date(2026, 11, 27, 8, 0, 0, 0, time.UTC), "Fri 08:00"},
		{time.Time{}, ""},
	} {
		if got := Stamp(c.at, now); got != c.want {
			t.Errorf("Stamp(%v) = %q, want %q", c.at, got, c.want)
		}
	}
	if got := Today(time.Date(2026, 11, 24, 14, 5, 0, 0, time.UTC), now); got != "14:05" {
		t.Errorf("Today for today = %q", got)
	}
	if got := Today(time.Date(2026, 11, 23, 14, 5, 0, 0, time.UTC), now); got != "Mon 14:05" {
		t.Errorf("Today for yesterday = %q", got)
	}
}

func TestDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{
		45 * time.Second: "45s", 4*time.Minute + 5*time.Second: "4m 05s", 3*time.Hour + 5*time.Minute: "3h 05m",
		52 * time.Hour: "2d 4h", time.Hour: "1h 00m", -time.Second: "0s", 1499 * time.Millisecond: "1s",
	} {
		if got := Duration(d); got != want {
			t.Errorf("Duration(%v) = %q, want %q", d, got, want)
		}
	}
}
