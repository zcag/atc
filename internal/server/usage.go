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
	reply(w, s.stats.Session(t.Path))
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
