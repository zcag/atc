package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/claude"
)

const (
	tickSecs  = 5
	ticksBack = 15 * time.Minute
	runDays   = 92
	// timeRule is what the page counts by (RULE in web/attention.js). Ticks counted by another rule are refused, so a
	// tab left open from before a change can't mix its time in.
	timeRule   = 2
	timeScreen = "screen:"
)

type timeRow struct {
	Title   string         `json:"title"`
	Cwd     string         `json:"cwd"`
	Host    string         `json:"host,omitempty"`
	Profile string         `json:"profile,omitempty"`
	Days    map[string]int `json:"days"`
	Last    time.Time      `json:"last"`
}

type timeLog struct {
	Sessions map[string]*timeRow `json:"sessions"`
}

// timeRun is ticks in a row: one line of time/<day>.jsonl. time.json keeps only each day's total.
type timeRun struct {
	ID     string `json:"s"`
	Device string `json:"d,omitempty"`
	Slot   int64  `json:"t"`
	N      int64  `json:"n"`
	Rule   int    `json:"r,omitempty"`
}

type ticks struct {
	mu   sync.Mutex
	seen map[int64]bool
}

func (t *ticks) claim(slot int64, now time.Time, earlier func() []timeRun) bool {
	at := time.Unix(slot*tickSecs, 0)
	if now.Sub(at) > ticksBack || at.After(now.Add(10*time.Second)) {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen == nil {
		t.seen = map[int64]bool{}
		for _, r := range earlier() {
			for i := range r.N {
				t.seen[r.Slot+i] = true
			}
		}
	}
	maps.DeleteFunc(t.seen, func(s int64, _ bool) bool { return now.Sub(time.Unix(s*tickSecs, 0)) > ticksBack })
	if t.seen[slot] {
		return false
	}
	t.seen[slot] = true
	return true
}

type timeIn struct {
	Device   string `json:"device"`
	Rule     int    `json:"rule"`
	Sessions []struct {
		ID      string  `json:"sessionId"`
		Title   string  `json:"title"`
		Cwd     string  `json:"cwd"`
		Host    string  `json:"host"`
		Profile string  `json:"profile"`
		Slots   []int64 `json:"slots"`
	} `json:"sessions"`
}

func slotDay(slot int64) string { return time.Unix(slot*tickSecs, 0).Format(time.DateOnly) }

func runsOf(id, device string, slots []int64) []timeRun {
	slices.Sort(slots)
	var out []timeRun
	for _, s := range slots {
		if n := len(out); n > 0 && out[n-1].Slot+out[n-1].N == s && slotDay(s) == slotDay(out[n-1].Slot) {
			out[n-1].N++
		} else {
			out = append(out, timeRun{id, device, s, 1, timeRule})
		}
	}
	return out
}

func (s *Server) runsPath(day string) string { return filepath.Join(s.StateDir, "time", day+".jsonl") }

func (s *Server) saveRuns(runs []timeRun) error {
	if err := os.MkdirAll(filepath.Join(s.StateDir, "time"), 0o755); err != nil {
		return err
	}
	byDay := map[string][]byte{}
	for _, r := range runs {
		b, _ := json.Marshal(r)
		byDay[slotDay(r.Slot)] = append(append(byDay[slotDay(r.Slot)], b...), '\n')
	}
	for day, b := range byDay {
		f, err := os.OpenFile(s.runsPath(day), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		_, err = f.Write(b)
		if e := f.Close(); err == nil {
			err = e
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) dayRuns(day string) []timeRun {
	b, _ := os.ReadFile(s.runsPath(day))
	var out []timeRun
	for sc := bufio.NewScanner(bytes.NewReader(b)); sc.Scan(); {
		var r timeRun
		if json.Unmarshal(sc.Bytes(), &r) == nil && r.N > 0 {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	joined := out[:0]
	for _, r := range out {
		if n := len(joined); n > 0 && joined[n-1].ID == r.ID && joined[n-1].Device == r.Device && joined[n-1].Rule == r.Rule && joined[n-1].Slot+joined[n-1].N == r.Slot {
			joined[n-1].N += r.N
		} else {
			joined = append(joined, r)
		}
	}
	return joined
}

func (s *Server) runFiles() []string {
	es, _ := os.ReadDir(filepath.Join(s.StateDir, "time"))
	var out []string
	for _, e := range es {
		if day, ok := strings.CutSuffix(e.Name(), ".jsonl"); ok {
			out = append(out, day)
		}
	}
	return out
}

func (s *Server) timePost(w http.ResponseWriter, r *http.Request) {
	var in timeIn
	if !decodeOr400(w, r, &in, `{"sessions":[{"sessionId","slots":[unix/5]}]}`, func() bool { return len(in.Sessions) > 0 }) {
		return
	}
	if in.Rule != timeRule || s.agentsPage(r) {
		reply(w, map[string]int{"counted": 0})
		return
	}
	now := time.Now()
	device := s.deviceName(r, in.Device)
	earlier := func() []timeRun {
		runs := s.dayRuns(now.Format(time.DateOnly))
		if before := now.Add(-ticksBack).Format(time.DateOnly); before != now.Format(time.DateOnly) {
			runs = append(s.dayRuns(before), runs...)
		}
		return runs
	}
	got := map[int][]int64{}
	var runs []timeRun
	n := 0
	for i, x := range in.Sessions {
		if !prefKey(x.ID) {
			continue
		}
		for _, slot := range x.Slots {
			if s.ticks.claim(slot, now, earlier) {
				got[i] = append(got[i], slot)
				n += tickSecs
			}
		}
		runs = append(runs, runsOf(x.ID, device, got[i])...)
	}
	if n == 0 {
		reply(w, map[string]int{"counted": 0})
		return
	}
	var log timeLog
	var saved error
	err := s.editPref("time.json", &log, func() {
		saved = s.saveRuns(runs)
		if log.Sessions == nil {
			log.Sessions = map[string]*timeRow{}
		}
		for i, slots := range got {
			x := in.Sessions[i]
			row := log.Sessions[x.ID]
			if row == nil {
				row = &timeRow{Days: map[string]int{}}
				log.Sessions[x.ID] = row
			}
			row.Title, row.Cwd, row.Host, row.Last = x.Title, x.Cwd, x.Host, now
			if x.Profile != "" {
				row.Profile = x.Profile
			}
			for _, slot := range slots {
				row.Days[slotDay(slot)] += tickSecs
			}
		}
	})
	if err == nil {
		err = saved
	}
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]int{"counted": n})
}

type timeOut struct {
	Sessions []timeSession `json:"sessions"`
	Days     []string      `json:"days"`
	First    string        `json:"first,omitempty"`
	RunsFrom string        `json:"runsFrom,omitempty"`
	RuleFrom *time.Time    `json:"ruleFrom,omitempty"`
	Runs     []timeRun     `json:"runs"`
}

type timeSession struct {
	ID      string         `json:"sessionId"`
	Title   string         `json:"title"`
	Cwd     string         `json:"cwd"`
	Host    string         `json:"host,omitempty"`
	Profile string         `json:"profile,omitempty"`
	Screen  bool           `json:"screen,omitempty"`
	Days    map[string]int `json:"days"`
	Before  int            `json:"before,omitempty"`
	Last    time.Time      `json:"last"`
}

// timeSince is the last n days with their rows (every day for 0). A row's Before is its time in the n days before those.
func timeSince(log timeLog, now time.Time, n int, profile func(cwd string) string) timeOut {
	out := timeOut{Sessions: []timeSession{}, Days: []string{}, Runs: []timeRun{}}
	for _, row := range log.Sessions {
		for d := range row.Days {
			if out.First == "" || d < out.First {
				out.First = d
			}
		}
	}
	if out.First == "" {
		return out
	}
	day := func(back int) string { return now.AddDate(0, 0, -back).Format(time.DateOnly) }
	from, before := out.First, out.First
	if n > 0 {
		from, before = day(n-1), day(2*n-1)
	}
	for at, _ := time.Parse(time.DateOnly, from); at.Format(time.DateOnly) <= day(0); at = at.AddDate(0, 0, 1) {
		out.Days = append(out.Days, at.Format(time.DateOnly))
	}
	for id, row := range log.Sessions {
		x := timeSession{ID: id, Title: row.Title, Cwd: row.Cwd, Host: row.Host, Profile: row.Profile,
			Screen: strings.HasPrefix(id, timeScreen), Days: map[string]int{}, Last: row.Last}
		for d, secs := range row.Days {
			if d >= from {
				x.Days[d] = secs
			} else if d >= before {
				x.Before += secs
			}
		}
		if len(x.Days) == 0 && x.Before == 0 {
			continue
		}
		if x.Profile == "" && !x.Screen {
			x.Profile = profile(row.Cwd)
		}
		out.Sessions = append(out.Sessions, x)
	}
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].ID < out.Sessions[j].ID })
	return out
}

func (s *Server) timeGet(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("days"))
	var log timeLog
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	s.loadPref("time.json", &log)
	out := timeSince(log, time.Now(), max(0, n), func(cwd string) string { return claude.ProfileFor(cwd).Name })
	if files := s.runFiles(); len(files) > 0 && len(out.Days) > 0 {
		out.RunsFrom = files[0]
		for _, d := range files[max(0, len(files)-runDays):] {
			if d >= out.Days[0] {
				out.Runs = append(out.Runs, s.dayRuns(d)...)
			}
		}
		out.RuleFrom = s.ruleFrom(files)
	}
	reply(w, out)
}

// ruleFrom is when the first tick counted by today's rule came in.
func (s *Server) ruleFrom(days []string) *time.Time {
	for _, d := range days {
		for _, r := range s.dayRuns(d) {
			if r.Rule == timeRule {
				at := time.Unix(r.Slot*tickSecs, 0)
				return &at
			}
		}
	}
	return nil
}
