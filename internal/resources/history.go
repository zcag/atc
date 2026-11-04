package resources

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

const (
	keepDays  = 7
	maxPoints = 360
	worthMem  = 500 << 20
	worthCPU  = 10
)

type Top struct {
	Name string  `json:"n"`
	Mem  int64   `json:"m"`
	CPU  float64 `json:"c,omitempty"`
}

type RowGroup struct {
	Key   string  `json:"k"`
	Kind  string  `json:"o"`
	Title string  `json:"l,omitempty"`
	CPU   float64 `json:"c"`
	Mem   int64   `json:"m"`
	Read  float64 `json:"r,omitempty"`
	Write float64 `json:"w,omitempty"`
	Top   []Top   `json:"p,omitempty"`
}

type Row struct {
	T      int64      `json:"t"`
	CPU    float64    `json:"cpu"`
	Mem    int64      `json:"mem"`
	Total  int64      `json:"total"`
	RAM    int64      `json:"ram,omitempty"`
	Cores  int        `json:"cores"`
	Groups []RowGroup `json:"g"`
}

type minute struct {
	n      int
	row    Row
	groups map[string]*RowGroup
}

func (m *minute) add(mach Machine, groups []Group) {
	m.n++
	m.row.CPU += mach.CPU
	m.row.Mem = max(m.row.Mem, mach.MemUsed)
	m.row.RAM = max(m.row.RAM, mach.RAMDisk)
	m.row.Total, m.row.Cores = mach.MemTotal, mach.Cores
	if m.groups == nil {
		m.groups = map[string]*RowGroup{}
	}
	for _, g := range groups {
		id := g.Kind + "/" + g.Key
		r := m.groups[id]
		if r == nil {
			r = &RowGroup{Key: g.Key, Kind: g.Kind}
			m.groups[id] = r
		}
		r.Title = g.Title
		r.CPU += g.CPU
		r.Read += g.Read
		r.Write += g.Write
		if g.Mem >= r.Mem {
			r.Mem, r.Top = g.Mem, topNames(g.Procs)
		}
	}
}

func topNames(ps []Process) []Top {
	by := map[string]*Top{}
	for _, p := range ps {
		t := by[p.Name]
		if t == nil {
			t = &Top{Name: p.Name}
			by[p.Name] = t
		}
		t.Mem += p.Mem
		t.CPU += p.CPU
	}
	out := make([]Top, 0, len(by))
	for _, t := range by {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mem > out[j].Mem })
	return out[:min(3, len(out))]
}

func (m *minute) finish(at time.Time) Row {
	n := float64(max(m.n, 1))
	r := m.row
	r.T = at.Unix()
	r.CPU /= n
	for _, g := range m.groups {
		g.CPU /= n
		g.Read /= n
		g.Write /= n
		if g.Mem >= worthMem || g.CPU >= worthCPU || (g.Kind == KindLeft && g.Mem >= 50<<20) {
			r.Groups = append(r.Groups, *g)
		}
	}
	sort.Slice(r.Groups, func(i, j int) bool { return r.Groups[i].Mem > r.Groups[j].Mem })
	return r
}

func dayFile(dir string, t time.Time) string {
	return filepath.Join(dir, t.Format("2006-01-02")+".jsonl")
}

func appendRow(dir string, r Row) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(dayFile(dir, time.Unix(r.T, 0)), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func prune(dir string, now time.Time) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		day, ok := strings.CutSuffix(e.Name(), ".jsonl")
		if !ok {
			continue
		}
		if t, err := time.ParseInLocation("2006-01-02", day, now.Location()); err == nil && now.Sub(t) > (keepDays+1)*24*time.Hour {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func readRows(dir string, since, until time.Time, key string) []Row {
	var rows []Row
	mark := []byte(`"k":"` + key + `"`)
	for d := since; !d.After(until.Add(24 * time.Hour)); d = d.Add(24 * time.Hour) {
		f, err := os.Open(dayFile(dir, d))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<16), 1<<22)
		for sc.Scan() {
			if key != "" && !bytes.Contains(sc.Bytes(), mark) {
				continue
			}
			var r Row
			if json.Unmarshal(sc.Bytes(), &r) == nil && r.T >= since.Unix() && r.T <= until.Unix() {
				rows = append(rows, r)
			}
		}
		f.Close()
	}
	// A test server sharing this folder writes the same minute too.
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].T < rows[j].T })
	return slices.CompactFunc(rows, func(a, b Row) bool { return a.T == b.T })
}

// thin folds rows into at most maxPoints: CPU and disk rates are averaged over the bucket, memory
// keeps the bucket's peak, so a spike between two points still shows at its true height.
func thin(rows []Row, points int) []Row {
	if len(rows) <= points || points <= 0 {
		return rows
	}
	out := make([]Row, 0, points)
	size := float64(len(rows)) / float64(points)
	for i := range points {
		part := rows[int(float64(i)*size):min(int(float64(i+1)*size), len(rows))]
		out = append(out, fold(part))
	}
	return out
}

func fold(part []Row) Row {
	r := Row{T: part[len(part)-1].T, Total: part[len(part)-1].Total, Cores: part[len(part)-1].Cores}
	n := float64(len(part))
	by := map[string]*RowGroup{}
	for _, p := range part {
		r.CPU += p.CPU / n
		r.Mem = max(r.Mem, p.Mem)
		r.RAM = max(r.RAM, p.RAM)
		for _, g := range p.Groups {
			id := g.Kind + "/" + g.Key
			x := by[id]
			if x == nil {
				x = &RowGroup{Key: g.Key, Kind: g.Kind, Title: g.Title}
				by[id] = x
			}
			x.CPU += g.CPU / n
			x.Read += g.Read / n
			x.Write += g.Write / n
			if g.Mem >= x.Mem {
				x.Mem, x.Top = g.Mem, g.Top
			}
		}
	}
	for _, g := range by {
		r.Groups = append(r.Groups, *g)
	}
	sort.Slice(r.Groups, func(i, j int) bool { return r.Groups[i].Mem > r.Groups[j].Mem })
	return r
}
