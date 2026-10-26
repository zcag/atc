package server

import (
	"context"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/usage"
)

func (s *Server) sessionUsage(w http.ResponseWriter, r *http.Request) {
	if sid := r.PathValue("sid"); s.M.OpenCode(sid) {
		ms, err := s.M.OC.All(r.Context(), sid)
		if err != nil {
			fail(w, err)
			return
		}
		reply(w, opencode.Usage(ms))
		return
	}
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
	ID       string    `json:"sessionId"`
	Title    string    `json:"title"`
	Host     string    `json:"host,omitempty"`
	Cwd      string    `json:"cwd,omitempty"`
	Model    string    `json:"model,omitempty"`
	Cost     float64   `json:"cost"`
	Total    int64     `json:"total,omitempty"`
	Messages int       `json:"messages,omitempty"`
	Last     time.Time `json:"last,omitzero"`
}

type spend struct {
	Cost     float64            `json:"cost"`
	Models   map[string]float64 `json:"models"`
	Sessions []spentIn          `json:"sessions"`
}

const topSessions = 8

func byCost(xs []spentIn) {
	sort.Slice(xs, func(i, j int) bool { return xs[i].Cost > xs[j].Cost })
}

func (s *Server) spentSince(from time.Time) (usage.Spend, []spentIn) {
	sp := s.stats.Spend(s.M.Index.Root, from)
	want := map[string]bool{}
	for id := range sp.Sessions {
		want[id] = true
	}
	briefs := s.M.Briefs(want)
	out := make([]spentIn, 0, len(sp.Sessions))
	for id, x := range sp.Sessions {
		model := ""
		for m, c := range x.Models {
			if model == "" || c > x.Models[model] {
				model = m
			}
		}
		b := briefs[id]
		out = append(out, spentIn{id, b.Title, s.Host, b.Cwd, model, x.Cost, x.Total, x.Messages, x.Last})
	}
	byCost(out)
	return sp, out
}

func (s *Server) localSpend(from time.Time) spend {
	sp, list := s.spentSince(from)
	return spend{Cost: sp.Cost, Models: sp.Models, Sessions: list[:min(len(list), topSessions)]}
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
	byCost(out.Sessions)
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

type project struct {
	Cwd      string    `json:"cwd"`
	Hosts    []string  `json:"hosts"`
	Cost     float64   `json:"cost"`
	Total    int64     `json:"total"`
	Sessions int       `json:"sessions"`
	Last     time.Time `json:"last"`
}

type report struct {
	Days     []usage.Day `json:"days"`
	Sessions []spentIn   `json:"sessions"`
	Projects []project   `json:"projects,omitempty"`
}

const reportSessions = 60

func (s *Server) usageReport(w http.ResponseWriter, r *http.Request) {
	n := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil {
		n = min(max(v, 1), 90)
	}
	first := time.Now().AddDate(0, 0, -n+1)
	_, list := s.spentSince(time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, time.Local))
	local := report{Days: s.stats.Days(s.M.Index.Root, n), Sessions: list}
	if r.URL.Query().Get("local") != "" {
		reply(w, local)
		return
	}
	reps := make([]report, len(s.Peers)+1)
	reps[0] = local
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i, p := range s.Peers {
		wg.Go(func() { s.fleet.get(ctx, p, "/api/usage/report?local=1&days="+strconv.Itoa(n), &reps[i+1]) })
	}
	wg.Wait()
	var days [][]usage.Day
	out := report{Sessions: []spentIn{}, Projects: []project{}}
	for _, rep := range reps {
		days = append(days, rep.Days)
		out.Sessions = append(out.Sessions, rep.Sessions...)
	}
	out.Days = usage.MergeDays(days...)
	byCwd := map[string]*project{}
	for _, x := range out.Sessions {
		p := byCwd[x.Cwd]
		if p == nil {
			p = &project{Cwd: x.Cwd}
			byCwd[x.Cwd] = p
		}
		if !slices.Contains(p.Hosts, x.Host) {
			p.Hosts = append(p.Hosts, x.Host)
		}
		p.Cost += x.Cost
		p.Total += x.Total
		p.Sessions++
		if x.Last.After(p.Last) {
			p.Last = x.Last
		}
	}
	for _, p := range byCwd {
		out.Projects = append(out.Projects, *p)
	}
	sort.Slice(out.Projects, func(i, j int) bool { return out.Projects[i].Cost > out.Projects[j].Cost })
	byCost(out.Sessions)
	out.Sessions = out.Sessions[:min(len(out.Sessions), reportSessions)]
	reply(w, out)
}
