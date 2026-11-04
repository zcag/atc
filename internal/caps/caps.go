// Package caps is the one list of what each atc feature needs. Settings, `atc doctor` and first run all read it. A check
// really probes the thing, with a short timeout, and says in plain words how it stands.
package caps

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

type Status string

const (
	OK      Status = "ok"
	Missing Status = "missing"
	Broken  Status = "broken"
)

type Result struct {
	Status Status
	Detail string
}

// Field is a setting a feature reads, which the user can fill in from Settings. Hub says the hub process reads it too.
type Field struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Hint   string `json:"hint,omitempty"`
	Secret bool   `json:"secret,omitempty"`
	URL    bool   `json:"url,omitempty"`
	Hub    bool   `json:"-"`
}

// Fix is how to get a feature working: a command to copy, plain words, and the README section with the rest.
type Fix struct {
	Command string `json:"command,omitempty"`
	Text    string `json:"text,omitempty"`
	Guide   string `json:"guide,omitempty"`
}

// Cap is one row. Without a Check it stands exactly as well as what it Needs.
type Cap struct {
	ID, Title, Group, Why string
	Optional              bool
	Needs                 []string
	Fields                []Field
	Fix                   Fix
	Cost                  string
	Check                 func(context.Context, Env) Result
}

// Env is what a check looks at, the same whether the server or a lone `atc doctor` runs it.
type Env struct {
	Get     func(key string) string
	Source  func(key string) string
	Bin     string
	Self    string
	Devices []string
	Peers   []Peer
	Engines []Engine
}

type Peer struct{ Name, URL, Token string }
type Engine struct{ Name, URL string }

type Need struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status Status `json:"status"`
}

type FieldState struct {
	Field
	Value  string `json:"value,omitempty"`
	Set    bool   `json:"set,omitempty"`
	Source string `json:"source,omitempty"`
}

// Row is a Cap with how it stands now. Warn is what deserves attention: something required that is not ok, or something
// set up that stopped working. Optional and never set up is quiet.
type Row struct {
	ID       string       `json:"id"`
	Title    string       `json:"title"`
	Group    string       `json:"group"`
	Why      string       `json:"why,omitempty"`
	Optional bool         `json:"optional,omitempty"`
	Status   Status       `json:"status"`
	Detail   string       `json:"detail"`
	Warn     bool         `json:"warn,omitempty"`
	Needs    []Need       `json:"needs,omitempty"`
	Fields   []FieldState `json:"fields,omitempty"`
	Fix      Fix          `json:"fix"`
	Cost     string       `json:"cost,omitempty"`
	Setup    string       `json:"setup,omitempty"`
}

// Timeout bounds one check, so the list never waits longer than this for anything.
const Timeout = 4 * time.Second

const ttl = 15 * time.Second

// Runner runs checks concurrently and keeps their results briefly; the zero value is ready.
type Runner struct {
	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	r  Result
	at time.Time
}

func (c Cap) run(ctx context.Context, env Env) (r Result) {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	done := make(chan Result, 1)
	go func() { done <- c.Check(ctx, env) }()
	select {
	case r = <-done:
	case <-ctx.Done():
		r = Result{Broken, "The check got no answer in time."}
	}
	return r
}

func (rn *Runner) results(ctx context.Context, env Env, list []Cap, fresh func(Cap) bool, keep bool) map[string]Result {
	out := map[string]Result{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range list {
		if c.Check == nil {
			continue
		}
		rn.mu.Lock()
		hit, ok := rn.cache[c.ID]
		rn.mu.Unlock()
		if ok && keep && !fresh(c) && time.Since(hit.at) < ttl {
			out[c.ID] = hit.r
			continue
		}
		wg.Go(func() {
			r := c.run(ctx, env)
			mu.Lock()
			out[c.ID] = r
			mu.Unlock()
			if keep {
				rn.mu.Lock()
				if rn.cache == nil {
					rn.cache = map[string]cached{}
				}
				rn.cache[c.ID] = cached{r, time.Now()}
				rn.mu.Unlock()
			}
		})
	}
	wg.Wait()
	for _, c := range list {
		if c.Check == nil {
			out[c.ID] = derived(c, out)
		}
	}
	return out
}

func derived(c Cap, got map[string]Result) Result {
	var missing, broken []string
	for _, id := range c.Needs {
		switch got[id].Status {
		case Broken:
			broken = append(broken, byID(id).Title)
		case Missing:
			missing = append(missing, byID(id).Title)
		}
	}
	switch {
	case len(broken) > 0:
		return Result{Broken, strings.Join(broken, ", ") + " stopped working."}
	case len(missing) > 0:
		return Result{Missing, "Still needs " + strings.Join(missing, ", ") + "."}
	}
	return Result{OK, "Everything it needs is working."}
}

// withNeeds adds what the picked caps need, so a row can show how its dependencies stand.
func withNeeds(picked []Cap) []Cap {
	out := slices.Clone(picked)
	for i := 0; i < len(out); i++ {
		for _, id := range out[i].Needs {
			if !slices.ContainsFunc(out, func(c Cap) bool { return c.ID == id }) {
				out = append(out, byID(id))
			}
		}
	}
	return out
}

// Rows runs the picked caps, all of them when pick is nil.
func (rn *Runner) Rows(ctx context.Context, env Env, pick func(Cap) bool) []Row {
	var picked []Cap
	for _, c := range All() {
		if pick == nil || pick(c) {
			picked = append(picked, c)
		}
	}
	got := rn.results(ctx, env, withNeeds(picked), func(Cap) bool { return false }, true)
	return rows(picked, got, env)
}

// Test runs one cap now, ignoring what is cached. With values it tries those in place of the settings and leaves no
// trace of them; without, its result replaces the cached one.
func (rn *Runner) Test(ctx context.Context, env Env, id string, values map[string]string) (Row, bool) {
	c := byID(id)
	if c.ID == "" {
		return Row{}, false
	}
	get := env.Get
	if len(values) > 0 {
		env.Get = func(k string) string {
			if v, ok := values[k]; ok {
				return v
			}
			return get(k)
		}
	}
	got := rn.results(ctx, env, withNeeds([]Cap{c}), func(x Cap) bool { return x.ID == id }, len(values) == 0)
	return rows([]Cap{c}, got, env)[0], true
}

func rows(list []Cap, got map[string]Result, env Env) []Row {
	out := make([]Row, 0, len(list))
	for _, c := range list {
		r := got[c.ID]
		row := Row{ID: c.ID, Title: c.Title, Group: c.Group, Why: c.Why, Optional: c.Optional, Status: r.Status, Detail: r.Detail,
			Warn: r.Status == Broken || (r.Status == Missing && !c.Optional), Fix: c.Fix, Cost: c.Cost}
		for _, id := range c.Needs {
			row.Needs = append(row.Needs, Need{id, byID(id).Title, got[id].Status})
		}
		for _, f := range c.Fields {
			st := FieldState{Field: f, Set: env.Get(f.Key) != ""}
			if env.Source != nil {
				st.Source = env.Source(f.Key)
			}
			if !f.Secret {
				st.Value = shown(f, env.Get(f.Key))
			}
			row.Fields = append(row.Fields, st)
		}
		if r.Status != OK {
			row.Setup = setupPrompt(row)
		}
		out = append(out, row)
	}
	return out
}

// Forget drops the cached results, after a setting changed.
func (rn *Runner) Forget() {
	rn.mu.Lock()
	rn.cache = nil
	rn.mu.Unlock()
}

// Failing is what makes `atc doctor` exit 1.
func Failing(rows []Row) []Row {
	var out []Row
	for _, r := range rows {
		if r.Warn {
			out = append(out, r)
		}
	}
	return out
}

// FieldOf finds a setting in the registry, which is also the list of what Settings may write.
func FieldOf(key string) (Field, bool) {
	for _, c := range All() {
		for _, f := range c.Fields {
			if f.Key == key {
				return f, true
			}
		}
	}
	return Field{}, false
}

// setupPrompt is the first message of a session started to set a feature up.
func setupPrompt(r Row) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Set up \"%s\" for atc on this machine.\n\n", r.Title)
	if r.Why != "" {
		fmt.Fprintf(&b, "What it is for: %s\n", r.Why)
	}
	fmt.Fprintf(&b, "How it stands now (%s): %s\n", r.Status, r.Detail)
	var needs []string
	for _, n := range r.Needs {
		needs = append(needs, fmt.Sprintf("%s (%s)", n.Title, n.Status))
	}
	if len(needs) > 0 {
		fmt.Fprintf(&b, "It depends on: %s\n", strings.Join(needs, ", "))
	}
	if r.Fix.Text != "" {
		fmt.Fprintf(&b, "The fix: %s\n", r.Fix.Text)
	}
	if r.Fix.Command != "" {
		fmt.Fprintf(&b, "Command: %s\n", r.Fix.Command)
	}
	if r.Fix.Guide != "" {
		fmt.Fprintf(&b, "Guide: the \"%s\" section of atc's README, %s\n", GuideName(r.Fix.Guide), GuideURL(r.Fix.Guide))
	}
	for _, f := range r.Fields {
		fmt.Fprintf(&b, "Setting: %s (%s)\n", f.Key, f.Label)
	}
	if r.Cost != "" {
		fmt.Fprintf(&b, "What it costs: %s\n", r.Cost)
	}
	b.WriteString("\nSettings go in the \"env\" object of settings.json in atc's config folder (a variable in atc's environment overrides it), and atc reads them when it restarts. " +
		"Do the setup, and ask me for anything only I can provide, such as keys and accounts, or before spending money. " +
		"When you are done, run `atc doctor` and tell me how this row stands.")
	return b.String()
}
