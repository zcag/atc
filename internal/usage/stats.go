package usage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/history"
)

type Tokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

func (t Tokens) Total() int64 { return t.Input + t.Output + t.CacheRead + t.CacheWrite }

func (t *Tokens) add(o Tokens) {
	t.Input += o.Input
	t.Output += o.Output
	t.CacheRead += o.CacheRead
	t.CacheWrite += o.CacheWrite
}

type Part struct {
	Tokens
	Total    int64   `json:"total"`
	Cost     float64 `json:"cost"`
	Messages int     `json:"messages"`
}

func (p *Part) add(m msg) {
	p.Tokens.add(m.t)
	p.Total = p.Tokens.Total()
	p.Cost += m.cost
	p.Messages++
}

type ModelPart struct {
	Model string `json:"model"`
	Part
}

type Stats struct {
	Part
	Models    []ModelPart `json:"models"`
	Subagents struct {
		Part
		Count int `json:"count"`
	} `json:"subagents"`
	Turns     int       `json:"turns"`
	ToolCalls int       `json:"toolCalls"`
	Start     time.Time `json:"start,omitzero"`
	End       time.Time `json:"end,omitzero"`
	Wall      int64     `json:"wallSeconds"`
	Active    int64     `json:"activeSeconds"`
	Unpriced  []string  `json:"unpriced,omitempty"`
	Local     []string  `json:"local,omitempty"`
	PricesAt  string    `json:"pricesAsOf"`
}

type Day struct {
	Day string `json:"day"`
	Part
	Sessions int `json:"sessions"`
}

type msg struct {
	model     string
	day       string
	at        time.Time
	t         Tokens
	cost      float64
	priced    bool
	local     bool
	sidechain bool
}

type file struct {
	mu       sync.Mutex
	off      int64
	msgs     map[string]msg
	tools    int
	subTools int
	turns    int
	agents   map[string]bool
	start    time.Time
	end      time.Time
	active   time.Duration
	inTurn   bool
	lastAt   time.Time
}

type Scanner struct {
	mu    sync.Mutex
	files map[string]*file
}

const idleCap = 10 * time.Minute

type line struct {
	Type        string    `json:"type"`
	IsSidechain bool      `json:"isSidechain"`
	IsMeta      bool      `json:"isMeta"`
	AgentID     string    `json:"agentId"`
	Timestamp   time.Time `json:"timestamp"`
	Origin      *struct {
		Kind string `json:"kind"`
	} `json:"origin"`
	Message struct {
		ID      string          `json:"id"`
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
		Usage   struct {
			Input         int64 `json:"input_tokens"`
			Output        int64 `json:"output_tokens"`
			CacheRead     int64 `json:"cache_read_input_tokens"`
			CacheWrite    int64 `json:"cache_creation_input_tokens"`
			CacheCreation struct {
				OneHour int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
			Speed string `json:"speed"`
		} `json:"usage"`
	} `json:"message"`
}

var (
	assistantKey  = []byte(`"type":"assistant"`)
	toolResultKey = []byte(`"type":"tool_result"`)
)

func (f *file) add(raw []byte) {
	if !bytes.Contains(raw, assistantKey) && bytes.Contains(raw, toolResultKey) {
		return
	}
	var l line
	if json.Unmarshal(raw, &l) != nil || l.Timestamp.IsZero() {
		return
	}
	switch l.Type {
	case "user":
		if !l.IsSidechain && !l.IsMeta && isPrompt(&l) {
			f.turns++
			f.inTurn, f.lastAt = true, l.Timestamp
		}
	case "assistant":
		var blocks []struct {
			Type string `json:"type"`
		}
		json.Unmarshal(l.Message.Content, &blocks)
		for _, b := range blocks {
			if b.Type == "tool_use" {
				if l.IsSidechain {
					f.subTools++
				} else {
					f.tools++
				}
			}
		}
		if l.IsSidechain && l.AgentID != "" {
			f.agents[l.AgentID] = true
		}
		if !l.IsSidechain && f.inTurn {
			f.active += min(max(l.Timestamp.Sub(f.lastAt), 0), idleCap)
			f.lastAt = l.Timestamp
		}
		u := l.Message.Usage
		t := Tokens{u.Input, u.Output, u.CacheRead, u.CacheWrite}
		if l.Message.ID == "" || t.Total() == 0 || l.Message.Model == "<synthetic>" {
			break
		}
		m := msg{model: l.Message.Model, day: l.Timestamp.Local().Format(time.DateOnly), at: l.Timestamp, t: t, sidechain: l.IsSidechain}
		if old, ok := f.msgs[l.Message.ID]; ok {
			m.day, m.at = old.day, old.at
		}
		m.cost, m.priced = Cost(m.model, t, u.CacheCreation.OneHour, u.Speed == "fast")
		m.local = Local(m.model)
		f.msgs[l.Message.ID] = m
	default:
		return
	}
	if f.start.IsZero() || l.Timestamp.Before(f.start) {
		f.start = l.Timestamp
	}
	if l.Timestamp.After(f.end) {
		f.end = l.Timestamp
	}
}

func isPrompt(l *line) bool {
	if l.Origin != nil {
		return l.Origin.Kind == "human"
	}
	var s string
	if json.Unmarshal(l.Message.Content, &s) == nil {
		return strings.TrimSpace(s) != "" && !history.IsNoise(s)
	}
	var blocks []struct{ Type, Text string }
	if json.Unmarshal(l.Message.Content, &blocks) != nil {
		return false
	}
	for _, b := range blocks {
		if b.Type == "tool_result" {
			return false
		}
		if b.Type == "text" && !history.IsNoise(b.Text) {
			return true
		}
	}
	return false
}

func (s *Scanner) get(path string) *file {
	s.mu.Lock()
	if s.files == nil {
		s.files = map[string]*file{}
	}
	f := s.files[path]
	if f == nil {
		f = &file{msgs: map[string]msg{}, agents: map[string]bool{}}
		s.files[path] = f
	}
	s.mu.Unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	fh, err := os.Open(path)
	if err != nil {
		return f
	}
	defer fh.Close()
	if st, _ := fh.Stat(); st != nil && st.Size() < f.off {
		*f = file{msgs: map[string]msg{}, agents: map[string]bool{}}
	}
	fh.Seek(f.off, io.SeekStart)
	r := bufio.NewReaderSize(fh, 1<<20)
	for {
		raw, err := r.ReadBytes('\n')
		if err != nil {
			break
		}
		f.off += int64(len(raw))
		f.add(raw)
	}
	return f
}

func subagentFiles(transcript string) []string {
	paths, _ := filepath.Glob(filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents", "*.jsonl"))
	return paths
}

func (s *Scanner) Session(transcript string) Stats {
	st := Stats{PricesAt: PricesAsOf}
	models := map[string]*ModelPart{}
	unpriced, local := map[string]bool{}, map[string]bool{}
	agents := map[string]bool{}
	take := func(f *file, sub bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, m := range f.msgs {
			st.add(m)
			if models[m.model] == nil {
				models[m.model] = &ModelPart{Model: m.model}
			}
			models[m.model].add(m)
			if sub || m.sidechain {
				st.Subagents.add(m)
			}
			if m.local {
				local[m.model] = true
			} else if !m.priced {
				unpriced[m.model] = true
			}
		}
		st.ToolCalls += f.tools + f.subTools
		if !sub {
			st.Turns, st.Start, st.End, st.Active = f.turns, f.start, f.end, int64(f.active.Seconds())
			for a := range f.agents {
				agents[a] = true
			}
		}
	}
	take(s.get(transcript), false)
	for _, p := range subagentFiles(transcript) {
		agents[strings.TrimPrefix(strings.TrimSuffix(filepath.Base(p), ".jsonl"), "agent-")] = true
		take(s.get(p), true)
	}
	st.Subagents.Count = len(agents)
	if !st.Start.IsZero() {
		st.Wall = int64(st.End.Sub(st.Start).Seconds())
	}
	for _, m := range models {
		st.Models = append(st.Models, *m)
	}
	sort.Slice(st.Models, func(i, j int) bool { return st.Models[i].Cost > st.Models[j].Cost })
	for m := range unpriced {
		st.Unpriced = append(st.Unpriced, m)
	}
	sort.Strings(st.Unpriced)
	st.Local = slices.Sorted(maps.Keys(local))
	return st
}

func (s *Scanner) recent(root string, since time.Time) ([]string, []*file) {
	mains, _ := filepath.Glob(filepath.Join(root, "*", "*.jsonl"))
	subs, _ := filepath.Glob(filepath.Join(root, "*", "*", "subagents", "*.jsonl"))
	var paths []string
	for _, p := range append(mains, subs...) {
		if st, err := os.Stat(p); err == nil && !st.ModTime().Before(since) {
			paths = append(paths, p)
		}
	}
	files := make([]*file, len(paths))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for range runtime.NumCPU() {
		wg.Go(func() {
			for i := range jobs {
				files[i] = s.get(paths[i])
			}
		})
	}
	for i := range paths {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return paths, files
}

func costSince(files []*file, from time.Time, seen map[string]bool) float64 {
	var c float64
	for _, f := range files {
		f.mu.Lock()
		for id, m := range f.msgs {
			if !m.at.Before(from) && !seen[id] {
				seen[id] = true
				c += m.cost
			}
		}
		f.mu.Unlock()
	}
	return c
}

func (s *Scanner) CostSince(root string, from time.Time) float64 {
	_, files := s.recent(root, from)
	return costSince(files, from, map[string]bool{})
}

func (s *Scanner) SessionCostSince(transcript string, from time.Time) float64 {
	files := []*file{s.get(transcript)}
	for _, p := range subagentFiles(transcript) {
		files = append(files, s.get(p))
	}
	return costSince(files, from, map[string]bool{})
}

func (s *Scanner) Days(root string, n int) []Day {
	since := time.Now().AddDate(0, 0, -n+1)
	first := since.Format(time.DateOnly)
	paths, files := s.recent(root, since.AddDate(0, 0, -1))

	days := map[string]*Day{}
	seen := map[string]bool{}
	for i, f := range files {
		sid := sessionOf(paths[i])
		f.mu.Lock()
		for id, m := range f.msgs {
			if m.day < first || m.local || seen[id] {
				continue
			}
			seen[id] = true
			d := days[m.day]
			if d == nil {
				d = &Day{Day: m.day}
				days[m.day] = d
			}
			d.add(m)
			if k := m.day + "|" + sid; !seen[k] {
				seen[k] = true
				d.Sessions++
			}
		}
		f.mu.Unlock()
	}
	out := []Day{}
	for t := since; !t.After(time.Now()); t = t.AddDate(0, 0, 1) {
		k := t.Format(time.DateOnly)
		if d := days[k]; d != nil {
			out = append(out, *d)
		} else {
			out = append(out, Day{Day: k})
		}
	}
	return out
}

func sessionOf(path string) string {
	if dir := filepath.Dir(path); filepath.Base(dir) == "subagents" {
		return filepath.Base(filepath.Dir(dir))
	}
	return strings.TrimSuffix(filepath.Base(path), ".jsonl")
}

func MergeDays(lists ...[]Day) []Day {
	byDay := map[string]*Day{}
	var keys []string
	for _, l := range lists {
		for _, d := range l {
			x := byDay[d.Day]
			if x == nil {
				x = &Day{Day: d.Day}
				byDay[d.Day] = x
				keys = append(keys, d.Day)
			}
			x.Tokens.add(d.Tokens)
			x.Total = x.Tokens.Total()
			x.Cost += d.Cost
			x.Messages += d.Messages
			x.Sessions += d.Sessions
		}
	}
	sort.Strings(keys)
	out := make([]Day, len(keys))
	for i, k := range keys {
		out[i] = *byDay[k]
	}
	return out
}
