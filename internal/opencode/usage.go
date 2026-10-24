package opencode

import (
	"slices"
	"time"

	"github.com/zcag/atc/internal/usage"
)

func Usage(msgs []Message) usage.Stats {
	st := usage.Stats{PricesAt: usage.PricesAsOf}
	models := map[string]*usage.ModelPart{}
	var active time.Duration
	for _, m := range msgs {
		start, end := at(m.Info.Time.Created), at(m.Info.Time.Completed)
		if st.Start.IsZero() || start.Before(st.Start) {
			st.Start = start
		}
		if end.After(st.End) {
			st.End = end
		}
		switch m.Info.Role {
		case "user":
			if m.prompt() != "" {
				st.Turns++
			}
		case "assistant":
			if !end.IsZero() {
				active += end.Sub(start)
			}
			t := m.Info.Tokens
			tok := usage.Tokens{Input: int64(t.Input), Output: int64(t.Output), CacheRead: int64(t.Cache.Read), CacheWrite: int64(t.Cache.Write)}
			name := m.model()
			if models[name] == nil {
				models[name] = &usage.ModelPart{Model: name}
			}
			for _, p := range []*usage.Part{&st.Part, &models[name].Part} {
				p.Input, p.Output, p.CacheRead, p.CacheWrite = p.Input+tok.Input, p.Output+tok.Output, p.CacheRead+tok.CacheRead, p.CacheWrite+tok.CacheWrite
				p.Total = p.Tokens.Total()
				p.Messages++
			}
			for _, p := range m.Parts {
				if p.Type == "tool" {
					st.ToolCalls++
				}
			}
		}
	}
	for name, m := range models {
		st.Models = append(st.Models, *m)
		st.Local = append(st.Local, name)
	}
	slices.Sort(st.Local)
	slices.SortFunc(st.Models, func(a, b usage.ModelPart) int { return int(b.Total - a.Total) })
	if !st.Start.IsZero() && st.End.After(st.Start) {
		st.Wall = int64(st.End.Sub(st.Start).Seconds())
	}
	st.Active = int64(active.Seconds())
	return st
}
