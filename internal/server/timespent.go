package server

import (
	"maps"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	tickSecs  = 5
	ticksBack = 15 * time.Minute
)

type timeRow struct {
	Title string         `json:"title"`
	Cwd   string         `json:"cwd"`
	Host  string         `json:"host,omitempty"`
	Days  map[string]int `json:"days"`
	Last  time.Time      `json:"last"`
}

type timeLog struct {
	Sessions map[string]*timeRow `json:"sessions"`
}

type ticks struct {
	mu   sync.Mutex
	seen map[int64]bool
}

func (t *ticks) claim(slot int64, now time.Time) bool {
	at := time.Unix(slot*tickSecs, 0)
	if now.Sub(at) > ticksBack || at.After(now.Add(10*time.Second)) {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen == nil {
		t.seen = map[int64]bool{}
	}
	maps.DeleteFunc(t.seen, func(s int64, _ bool) bool { return now.Sub(time.Unix(s*tickSecs, 0)) > ticksBack })
	if t.seen[slot] {
		return false
	}
	t.seen[slot] = true
	return true
}

type timeIn struct {
	Sessions []struct {
		ID    string  `json:"sessionId"`
		Title string  `json:"title"`
		Cwd   string  `json:"cwd"`
		Host  string  `json:"host"`
		Slots []int64 `json:"slots"`
	} `json:"sessions"`
}

func (s *Server) timePost(w http.ResponseWriter, r *http.Request) {
	var in timeIn
	if !decodeOr400(w, r, &in, `{"sessions":[{"sessionId","slots":[unix/5]}]}`, func() bool { return len(in.Sessions) > 0 }) {
		return
	}
	now := time.Now()
	got := map[int]map[string]int{}
	for i, x := range in.Sessions {
		if !prefKey(x.ID) {
			continue
		}
		for _, slot := range x.Slots {
			if s.ticks.claim(slot, now) {
				if got[i] == nil {
					got[i] = map[string]int{}
				}
				got[i][time.Unix(slot*tickSecs, 0).Format(time.DateOnly)] += tickSecs
			}
		}
	}
	if len(got) == 0 {
		reply(w, map[string]int{"counted": 0})
		return
	}
	var log timeLog
	n := 0
	err := s.editPref("time.json", &log, func() {
		if log.Sessions == nil {
			log.Sessions = map[string]*timeRow{}
		}
		for i, days := range got {
			x := in.Sessions[i]
			row := log.Sessions[x.ID]
			if row == nil {
				row = &timeRow{Days: map[string]int{}}
				log.Sessions[x.ID] = row
			}
			row.Title, row.Cwd, row.Host, row.Last = x.Title, x.Cwd, x.Host, now
			for d, secs := range days {
				row.Days[d] += secs
				n += secs
			}
		}
	})
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]int{"counted": n})
}

type timeOut struct {
	Sessions []timeSession  `json:"sessions"`
	Days     map[string]int `json:"days"`
}

type timeSession struct {
	ID    string    `json:"sessionId"`
	Title string    `json:"title"`
	Cwd   string    `json:"cwd"`
	Host  string    `json:"host,omitempty"`
	Secs  int       `json:"secs"`
	Last  time.Time `json:"last"`
}

func timeSince(log timeLog, from string) timeOut {
	out := timeOut{Sessions: []timeSession{}, Days: map[string]int{}}
	for id, row := range log.Sessions {
		secs := 0
		for d, n := range row.Days {
			if d >= from {
				secs += n
				out.Days[d] += n
			}
		}
		if secs > 0 {
			out.Sessions = append(out.Sessions, timeSession{id, row.Title, row.Cwd, row.Host, secs, row.Last})
		}
	}
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].Secs > out.Sessions[j].Secs })
	return out
}

func (s *Server) timeGet(w http.ResponseWriter, r *http.Request) {
	from := ""
	if d, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && d > 0 {
		from = time.Now().AddDate(0, 0, 1-d).Format(time.DateOnly)
	}
	var log timeLog
	s.prefMu.Lock()
	s.loadPref("time.json", &log)
	s.prefMu.Unlock()
	reply(w, timeSince(log, from))
}
