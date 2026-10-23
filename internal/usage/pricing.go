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

func priceOf(model string) (price, bool) {
	for _, p := range prices {
		if strings.HasPrefix(model, p.prefix) {
			return p.p, true
		}
	}
	return price{}, false
}

func Cost(model string, t Tokens, write1h int64, fast bool) (float64, bool) {
	p, ok := priceOf(model)
	if !ok {
		return 0, false
	}
	if p.tiered && t.Input+t.CacheRead+t.CacheWrite > 100_000 {
		p.in, p.out, p.read = p.in*5, p.out*5, p.read*5
	}
	write1h = min(write1h, t.CacheWrite)
	c := float64(t.Input)*p.in + float64(t.Output)*p.out + float64(t.CacheRead)*p.read +
		float64(t.CacheWrite-write1h)*p.in*1.25 + float64(write1h)*p.in*2
	if fast {
		c *= 2
	}
	return c / 1e6, true
}
