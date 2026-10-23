package server

import (
	"context"
	"maps"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/zcag/atc/internal/usage"
)

func (s *Server) sessionUsage(w http.ResponseWriter, r *http.Request) {
	t, ok := s.M.Index.Find(r.PathValue("sid"))
	if !ok {
		http.Error(w, "no transcript", http.StatusNotFound)
		return
	}
	since := func(k string) *float64 {
		v, err := strconv.ParseInt(r.URL.Query().Get(k), 10, 64)
		if err != nil {
			return nil
		}
		c := s.stats.SessionCostSince(t.Path, time.Unix(v, 0))
		return &c
	}
	reply(w, struct {
		usage.Stats
		WeekCost     *float64 `json:"weekCost,omitempty"`
		FiveHourCost *float64 `json:"fiveHourCost,omitempty"`
	}{s.stats.Session(t.Path), since("week"), since("fiveHour")})
}

type spentIn struct {
	ID    string  `json:"sessionId"`
	Title string  `json:"title"`
	Host  string  `json:"host,omitempty"`
	Cost  float64 `json:"cost"`
}

type spend struct {
	Cost     float64            `json:"cost"`
	Models   map[string]float64 `json:"models"`
	Sessions []spentIn          `json:"sessions"`
}

const topSessions = 8

func (s *Server) localSpend(from time.Time) spend {
	sp := s.stats.Spend(s.M.Index.Root, from)
	ids := slices.SortedFunc(maps.Keys(sp.Sessions), func(a, b string) int {
		if sp.Sessions[a] > sp.Sessions[b] {
			return -1
		}
		return 1
	})
	ids = ids[:min(len(ids), topSessions)]
	titles := s.M.Titles(ids)
	out := spend{Cost: sp.Cost, Models: sp.Models, Sessions: []spentIn{}}
	for _, id := range ids {
		out.Sessions = append(out.Sessions, spentIn{id, titles[id], s.Host, sp.Sessions[id]})
	}
	return out
}

func (s *Server) fleetSpend(ctx context.Context, from time.Time) spend {
	out := s.localSpend(from)
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, p := range s.Peers {
		wg.Go(func() {
			var ps spend
			if s.fleet.get(ctx, p, "/api/usage/spend?from="+strconv.FormatInt(from.Unix(), 10), &ps) != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			out.Cost += ps.Cost
			for m, c := range ps.Models {
				out.Models[m] += c
			}
			out.Sessions = append(out.Sessions, ps.Sessions...)
		})
	}
	wg.Wait()
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].Cost > out.Sessions[j].Cost })
	out.Sessions = out.Sessions[:min(len(out.Sessions), topSessions)]
	return out
}

func (s *Server) usageSpend(w http.ResponseWriter, r *http.Request) {
	v, err := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	if err != nil {
		http.Error(w, "from is required", http.StatusBadRequest)
		return
	}
	reply(w, s.localSpend(time.Unix(v, 0)))
}

type windowSpend struct {
	usage.Window
	From time.Time `json:"from"`
	Cost float64   `json:"cost"`
}

func (s *Server) usageWindows(w http.ResponseWriter, r *http.Request) {
	out := struct {
		Windows []windowSpend `json:"windows"`
		Week    *spend        `json:"week,omitempty"`
	}{Windows: []windowSpend{}}
	byFrom := map[time.Time]*spend{}
	for _, win := range s.limits.Get(r.Context()).Windows {
		from := win.From()
		sp := byFrom[from]
		if sp == nil {
			v := s.fleetSpend(r.Context(), from)
			sp, byFrom[from] = &v, &v
		}
		ws := windowSpend{Window: win, From: from}
		for m, c := range sp.Models {
			if win.Counts(m) {
				ws.Cost += c
			}
		}
		if win.Key == "weekly_all" {
			out.Week = sp
		}
		out.Windows = append(out.Windows, ws)
	}
	reply(w, out)
}

func (s *Server) usageLimits(w http.ResponseWriter, r *http.Request) {
	reply(w, s.limits.Get(r.Context()))
}

func (s *Server) usageDays(w http.ResponseWriter, r *http.Request) {
	n := 14
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil {
		n = min(max(v, 1), 60)
	}
	local := s.stats.Days(s.M.Index.Root, n)
	if r.URL.Query().Get("local") != "" || len(s.Peers) == 0 {
		reply(w, local)
		return
	}
	lists := make([][]usage.Day, len(s.Peers)+1)
	lists[0] = local
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i, p := range s.Peers {
		wg.Go(func() { s.fleet.get(ctx, p, "/api/usage/days?local=1&days="+strconv.Itoa(n), &lists[i+1]) })
	}
	wg.Wait()
	reply(w, usage.MergeDays(lists...))
}
