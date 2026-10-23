package usage

import "strings"

const PricesAsOf = "October 2026"

type price struct {
	in, out, read float64
	tiered        bool
}

var prices = []struct {
	prefix string
	p      price
}{
	{"claude-fable-5-1", price{10, 50, 0.25, false}},
	{"claude-mythos-5-1", price{10, 50, 0.25, false}},
	{"claude-fable-5", price{10, 50, 1, false}},
	{"claude-mythos-5", price{10, 50, 1, false}},
	{"claude-opus-5-5", price{4, 20, 0.2, false}},
	{"claude-opus-5", price{5, 25, 0.5, false}},
	{"claude-opus-4-1", price{15, 75, 1.5, false}},
	{"claude-opus-4-2", price{15, 75, 1.5, false}},
	{"claude-opus-4", price{5, 25, 0.5, false}},
	{"claude-sonnet-5", price{2, 10, 0.2, false}},
	{"claude-sonnet-4", price{3, 15, 0.3, false}},
	{"claude-haiku-5-5", price{0.1, 0.5, 0.01, true}},
	{"claude-haiku-4", price{1, 5, 0.1, false}},
	{"claude-3-7-sonnet", price{3, 15, 0.3, false}},
	{"claude-3-5-sonnet", price{3, 15, 0.3, false}},
	{"claude-3-5-haiku", price{0.8, 4, 0.08, false}},
	{"claude-3-opus", price{15, 75, 1.5, false}},
	{"claude-3-haiku", price{0.25, 1.25, 0.03, false}},
}

func Local(model string) bool { return !strings.HasPrefix(model, "claude-") }

func priceOf(model string) (price, bool) {
	for _, p := range prices {
		if strings.HasPrefix(model, p.prefix) {
			return p.p, true
		}
	}
	return price{}, false
}

type Split struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

func (s Split) Sum() float64 { return s.Input + s.Output + s.CacheRead + s.CacheWrite }

func (s *Split) add(o Split) {
	s.Input += o.Input
	s.Output += o.Output
	s.CacheRead += o.CacheRead
	s.CacheWrite += o.CacheWrite
}

func Cost(model string, t Tokens, write1h int64, fast bool) (float64, bool) {
	s, ok := Costs(model, t, write1h, fast)
	return s.Sum(), ok
}

func Costs(model string, t Tokens, write1h int64, fast bool) (Split, bool) {
	p, ok := priceOf(model)
	if !ok {
		return Split{}, false
	}
	if p.tiered && t.Input+t.CacheRead+t.CacheWrite > 100_000 {
		p.in, p.out, p.read = p.in*5, p.out*5, p.read*5
	}
	write1h = min(write1h, t.CacheWrite)
	k := 1e-6
	if fast {
		k *= 2
	}
	return Split{
		Input:      float64(t.Input) * p.in * k,
		Output:     float64(t.Output) * p.out * k,
		CacheRead:  float64(t.CacheRead) * p.read * k,
		CacheWrite: (float64(t.CacheWrite-write1h)*1.25 + float64(write1h)*2) * p.in * k,
	}, true
}
