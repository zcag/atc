package server

import (
	"context"
	"net/http"
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
	st := s.stats.Session(t.Path)
	from, err := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	if err != nil {
		reply(w, st)
		return
	}
	reply(w, struct {
		usage.Stats
		WeekCost float64 `json:"weekCost"`
	}{st, s.stats.SessionCostSince(t.Path, time.Unix(from, 0))})
}

type weekUsage struct {
	From     time.Time `json:"from,omitzero"`
	ResetsAt time.Time `json:"resetsAt,omitzero"`
	Percent  float64   `json:"percent"`
	Total    float64   `json:"total"`
}

func (s *Server) usageWeek(w http.ResponseWriter, r *http.Request) {
	if v, err := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64); err == nil && r.URL.Query().Get("local") != "" {
		reply(w, weekUsage{Total: s.stats.CostSince(s.M.Index.Root, time.Unix(v, 0))})
		return
	}
	var out weekUsage
	for _, win := range s.limits.Get(r.Context()).Windows {
		if win.Key == "weekly_all" {
			out.ResetsAt, out.Percent, out.From = win.ResetsAt, win.Percent, win.ResetsAt.Add(-7*24*time.Hour)
		}
	}
	if out.From.IsZero() {
		reply(w, out)
		return
	}
	out.Total = s.stats.CostSince(s.M.Index.Root, out.From)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, p := range s.Peers {
		wg.Go(func() {
			var pw weekUsage
			if s.fleet.get(ctx, p, "/api/usage/week?local=1&from="+strconv.FormatInt(out.From.Unix(), 10), &pw) == nil {
				mu.Lock()
				out.Total += pw.Total
				mu.Unlock()
			}
		})
	}
	wg.Wait()
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
