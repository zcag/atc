package server

import (
	"cmp"
	"context"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
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
	reply(w, s.usageOf(r, t.Path))
}

type usageReply struct {
	usage.Stats
	WeekCost      *float64       `json:"weekCost,omitempty"`
	FiveHourCost  *float64       `json:"fiveHourCost,omitempty"`
	Conversations []conversation `json:"conversations,omitempty"`
}

type conversation struct {
	ID      string    `json:"sessionId"`
	Title   string    `json:"title"`
	Cost    float64   `json:"cost"`
	Total   int64     `json:"total"`
	Turns   int       `json:"turns"`
	Start   time.Time `json:"start,omitzero"`
	End     time.Time `json:"end,omitzero"`
	Profile string    `json:"profile,omitempty"`
}

func accountOf(path string) string {
	if p := claude.ProfileOfFile(path); !p.Default() {
		return p.Name
	}
	return ""
}

// usageOf is the transcripts' usage. The week and 5-hour figures are against one account's limits (the profile
// parameter, else the default), so they count only the transcripts on that account.
func (s *Server) usageOf(r *http.Request, paths ...string) usageReply {
	acct, _ := claude.ProfileNamed(r.URL.Query().Get("profile"))
	on := slices.DeleteFunc(slices.Clone(paths), func(p string) bool { return claude.ProfileOfFile(p).Name != acct.Name })
	since := func(k string) *float64 {
		v, err := strconv.ParseInt(r.URL.Query().Get(k), 10, 64)
		if err != nil {
			return nil
		}
		c := s.stats.CostSince(time.Unix(v, 0), on...)
		return &c
	}
	return usageReply{Stats: s.stats.Session(paths...), WeekCost: since("week"), FiveHourCost: since("fiveHour")}
}

func (s *Server) agentUsage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ids := s.agentConversations(name)
	var paths []string
	var convs []conversation
	for _, id := range ids {
		t, ok := s.M.Index.Find(id)
		if !ok {
			continue
		}
		st := s.stats.Session(t.Path)
		paths = append(paths, t.Path)
		convs = append(convs, conversation{id, cmp.Or(s.M.Store.Get(id).Name, t.Title), st.Cost, st.Total, st.Turns, st.Start, st.End, accountOf(t.Path)})
	}
	if len(paths) == 0 {
		http.Error(w, "no conversations of "+name+" on "+s.Host, http.StatusNotFound)
		return
	}
	sort.Slice(convs, func(i, j int) bool { return convs[i].End.After(convs[j].End) })
	out := s.usageOf(r, paths...)
	out.Conversations = convs
	reply(w, out)
}

func (s *Server) agentConversations(name string) []string {
	if l := s.hubNamed(name); l != nil {
		ids := s.M.Store.Find(func(_ string, m store.Meta) bool {
			return m.Name == name || strings.HasPrefix(m.Name, name+" ") || name == hubName && sessions.RetiredHub(m.Name)
		})
		if sid := l.session(); sid != "" && !slices.Contains(ids, sid) {
			ids = append(ids, sid)
		}
		return ids
	}
	return s.M.Store.Find(func(_ string, m store.Meta) bool { return m.Agent == name })
}

type spentIn struct {
	ID       string                             `json:"sessionId"`
	Title    string                             `json:"title"`
	Host     string                             `json:"host,omitempty"`
	Cwd      string                             `json:"cwd,omitempty"`
	Model    string                             `json:"model,omitempty"`
	Cost     float64                            `json:"cost"`
	Total    int64                              `json:"total,omitempty"`
	Messages int                                `json:"messages,omitempty"`
	Last     time.Time                          `json:"last,omitzero"`
	Slices   map[string]map[string]*usage.Slice `json:"slices,omitempty"`
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

// profileOf is the Claude account a usage request asks about: its profile parameter, else the default.
func profileOf(w http.ResponseWriter, r *http.Request) (claude.Profile, bool) {
	p, ok := claude.ProfileNamed(r.URL.Query().Get("profile"))
	if !ok {
		http.Error(w, "no Claude profile called "+r.URL.Query().Get("profile"), http.StatusNotFound)
	}
	return p, ok
}

func (s *Server) limitsOf(ctx context.Context, p claude.Profile) usage.Limits {
	if p.Default() {
		return s.limits.Get(ctx)
	}
	return (&usage.LimitsClient{Home: p.Home(), State: p.State()}).Get(ctx)
}

func (s *Server) spentSince(p claude.Profile, from time.Time) (usage.Spend, []spentIn) {
	sp := s.stats.Spend(p.Projects(), from)
	return sp, s.spentIn(sp.Sessions)
}

func (s *Server) spentIn(sessions map[string]*usage.SessionSpend) []spentIn {
	want := map[string]bool{}
	for id := range sessions {
		want[id] = true
	}
	briefs := s.M.Briefs(want)
	out := make([]spentIn, 0, len(sessions))
	for id, x := range sessions {
		model := ""
		for m, c := range x.Models {
			if model == "" || c > x.Models[model] {
				model = m
			}
		}
		b := briefs[id]
		out = append(out, spentIn{id, b.Title, s.Host, b.Cwd, model, x.Cost, x.Total, x.Messages, x.Last, x.Slices})
	}
	byCost(out)
	return out
}

func (s *Server) localSpend(p claude.Profile, from time.Time) spend {
	sp, list := s.spentSince(p, from)
	return spend{Cost: sp.Cost, Models: sp.Models, Sessions: list[:min(len(list), topSessions)]}
}

func (s *Server) fleetSpend(ctx context.Context, p claude.Profile, from time.Time) spend {
	out := s.localSpend(p, from)
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, peer := range s.Peers {
		wg.Go(func() {
			var ps spend
			q := url.Values{"from": {strconv.FormatInt(from.Unix(), 10)}, "profile": {p.Name}}
			if s.fleet.get(ctx, peer, "/api/usage/spend?"+q.Encode(), &ps) != nil {
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
	if p, ok := profileOf(w, r); ok {
		reply(w, s.localSpend(p, time.Unix(v, 0)))
	}
}

type windowSpend struct {
	usage.Window
	From time.Time `json:"from"`
	Cost float64   `json:"cost"`
}

func (s *Server) usageWindows(w http.ResponseWriter, r *http.Request) {
	p, ok := profileOf(w, r)
	if !ok {
		return
	}
	out := struct {
		Windows []windowSpend `json:"windows"`
		Week    *spend        `json:"week,omitempty"`
	}{Windows: []windowSpend{}}
	byFrom := map[time.Time]*spend{}
	for _, win := range s.limitsOf(r.Context(), p).Windows {
		from := win.From()
		sp := byFrom[from]
		if sp == nil {
			v := s.fleetSpend(r.Context(), p, from)
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
	if p, ok := profileOf(w, r); ok {
		reply(w, s.limitsOf(r.Context(), p))
	}
}

type report struct {
	Days     []usage.Day `json:"days"`
	Sessions []spentIn   `json:"sessions"`
	Previous float64     `json:"previous"`
	First    string      `json:"first,omitempty"`
}

func reportSpan(q url.Values) (time.Time, bool) {
	if q.Get("hours") != "" {
		return time.Now().Truncate(time.Hour).Add(-23 * time.Hour), true
	}
	if q.Get("days") == "all" {
		return time.Time{}, false
	}
	if v, err := strconv.ParseInt(q.Get("since"), 10, 64); err == nil {
		return time.Unix(v, 0), false
	}
	n := 30
	if v, err := strconv.Atoi(q.Get("days")); err == nil {
		n = min(max(v, 1), 90)
	}
	first := time.Now().AddDate(0, 0, -n+1)
	return time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, time.Local), false
}

func (s *Server) usageReport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, hourly := reportSpan(q)
	p, ok := profileOf(w, r)
	if !ok {
		return
	}
	rep := s.stats.Report(p.Projects(), from, hourly)
	local := report{rep.Days, s.spentIn(rep.Sessions), rep.Previous, rep.First}
	if q.Get("local") != "" {
		reply(w, local)
		return
	}
	q.Set("local", "1")
	reps := make([]report, len(s.Peers)+1)
	reps[0] = local
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i, p := range s.Peers {
		wg.Go(func() { s.fleet.get(ctx, p, "/api/usage/report?"+q.Encode(), &reps[i+1]) })
	}
	wg.Wait()
	var days [][]usage.Day
	out := report{Sessions: []spentIn{}}
	for _, rep := range reps {
		days = append(days, rep.Days)
		out.Sessions = append(out.Sessions, rep.Sessions...)
		out.Previous += rep.Previous
		if rep.First != "" && (out.First == "" || rep.First < out.First) {
			out.First = rep.First
		}
	}
	out.Days = usage.MergeDays(days...)
	byCost(out.Sessions)
	reply(w, out)
}
