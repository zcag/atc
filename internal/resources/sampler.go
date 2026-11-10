// Package resources measures what agents cost the machine: every process attributed to a session,
// to a session that has ended, or to whatever else runs on the box.
package resources

import (
	"context"
	"log"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	every        = 10 * time.Second
	diskEvery    = time.Hour
	maxProcesses = 40
	maxOutside   = 24
	leftWorth    = 16 << 20
	ramDirWorth  = 50 << 20
	ramDirEvery  = 5 * time.Minute
)

type Target struct {
	Key, SessionID, Title, Cwd string
	PID                        int
}

type Process struct {
	PID   int     `json:"pid"`
	PPID  int     `json:"ppid"`
	Name  string  `json:"name"`
	Cmd   string  `json:"cmd"`
	CPU   float64 `json:"cpu"`
	Mem   int64   `json:"mem"`
	Read  float64 `json:"read,omitempty"`
	Write float64 `json:"write,omitempty"`
	Age   int64   `json:"age,omitempty"`
}

type Group struct {
	Key       string    `json:"key"`
	SessionID string    `json:"sessionId,omitempty"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	Detail    string    `json:"detail,omitempty"`
	CPU       float64   `json:"cpu"`
	Mem       int64     `json:"mem"`
	Read      float64   `json:"read"`
	Write     float64   `json:"write"`
	Count     int       `json:"count"`
	RSSOnly   bool      `json:"rssOnly,omitempty"`
	Procs     []Process `json:"procs,omitempty"`
}

type Report struct {
	At       time.Time `json:"at"`
	Machine  Machine   `json:"machine"`
	Sessions []Group   `json:"sessions"`
	Left     []Group   `json:"left"`
	Outside  []Group   `json:"outside"`
	Rest     Group     `json:"rest"`
	Disk     []DiskUse `json:"disk,omitempty"`
	DiskAt   time.Time `json:"diskAt,omitzero"`
	RAMDirs  []DiskUse `json:"ramDirs,omitempty"`
	Exact    bool      `json:"exact"`
	Cost     float64   `json:"cost"`
}

// Load is what a session row carries, only while it is heavy and rounded, so an ordinary
// fluctuation does not re-send the whole session list.
type Load struct {
	CPU int   `json:"cpu,omitempty"`
	Mem int64 `json:"mem,omitempty"`
}

const (
	heavyMem = 1 << 30
	heavyCPU = 100
)

type procKey struct {
	pid   int
	start uint64
}

type procPrev struct {
	own, total  float64
	read, write int64
	hasIO       bool
	group       string
}

type Sampler struct {
	Dir       string
	ClaudeDir string
	Resolve   func(key string) (title, sessionID string)

	mu      sync.Mutex
	targets []Target
	tracked bool
	costAvg float64
	report  Report
	loads   map[string]Load
	disk    diskScan
	dirs    map[string][]string

	sc         *scanner
	mach       machineReader
	prev       map[procKey]procPrev
	totals     map[string]float64
	prevMax    uint64
	prevAt     time.Time
	cgPrev     map[string]counters
	docker     map[string]container
	dockerMiss bool
	free       []Disk
	ramDisk    int64
	ramAt      time.Time
	ramDirs    []DiskUse
	lastSlow   time.Time
	min        minute
	minAt      time.Time
	resolved   map[string][2]string
	owners     map[int]Owner
}

func New(dir, claudeDir string) *Sampler {
	return &Sampler{Dir: dir, ClaudeDir: claudeDir, sc: newScanner(), prev: map[procKey]procPrev{}, cgPrev: map[string]counters{},
		loads: map[string]Load{}, resolved: map[string][2]string{}}
}

func (s *Sampler) Track(targets []Target) {
	s.mu.Lock()
	s.targets, s.tracked = targets, true
	s.mu.Unlock()
}

func (s *Sampler) Run(ctx context.Context) {
	if s.Dir != "" {
		s.disk = loadDisk(filepath.Join(s.Dir, "disk.json"))
		go s.watchDisk(ctx)
	}
	t := time.NewTicker(every)
	defer t.Stop()
	s.tick(time.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			s.tick(now)
		}
	}
}

func (s *Sampler) watchDisk(ctx context.Context) {
	wait := max(diskEvery-time.Since(s.disk.At), time.Minute)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		s.mu.Lock()
		var cwds, inside []string
		for _, t := range s.targets {
			cwds = append(cwds, t.Cwd)
		}
		for _, paths := range s.dirs {
			inside = append(inside, paths...)
		}
		s.mu.Unlock()
		d := diskScan{At: time.Now(), Uses: measureDisk(dedupe(cwds), dedupe(inside), s.ClaudeDir)}
		s.mu.Lock()
		s.disk = d
		s.mu.Unlock()
		saveDisk(filepath.Join(s.Dir, "disk.json"), d)
		wait = diskEvery
	}
}

func (s *Sampler) measureRAMDirs() {
	dirs := ramDirs()
	s.mu.Lock()
	s.ramDirs = dirs
	s.mu.Unlock()
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range in {
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func (s *Sampler) tick(now time.Time) {
	began := time.Now()
	s.mu.Lock()
	targets, tracked := s.targets, s.tracked
	s.mu.Unlock()

	if now.Sub(s.lastSlow) >= time.Minute {
		s.lastSlow = now
		s.free = diskFree()
		if runtime.GOOS == "linux" {
			s.ramDisk = ramDisks()
			if now.Sub(s.ramAt) >= ramDirEvery {
				s.ramAt = now
				go s.measureRAMDirs()
			}
		}
		if s.docker == nil || s.dockerMiss {
			s.docker, s.dockerMiss = dockerNames(), false
		}
	}
	dt := now.Sub(s.prevAt).Seconds()
	first := s.prevAt.IsZero()
	procs := s.sc.scan()
	attribute(procs, targets)
	for _, p := range procs {
		if p.kind != KindOutside {
			s.sc.detail(p)
		}
	}
	r := Report{At: now, Machine: s.mach.sample(dt), Exact: s.sc.boot > 0}
	r.Machine.Disks, r.Machine.RAMDisk = s.free, s.ramDisk
	groups := s.aggregate(procs, targets, now, dt, first)
	s.remember(procs, groups, now)
	if runtime.GOOS != "linux" {
		for _, g := range groups {
			r.Machine.CPU += g.CPU
		}
	}
	dirs := map[string][]string{}
	for _, p := range procs {
		if p.kind == KindSession && p.cwd != "" {
			if g := groups[KindSession+"/"+p.owner]; g != nil {
				dirs[g.Title] = append(dirs[g.Title], p.cwd)
			}
		}
	}
	for _, t := range targets {
		if g := groups[KindSession+"/"+t.Key]; g != nil && t.Cwd != "" {
			dirs[g.Title] = append(dirs[g.Title], t.Cwd)
		}
	}
	all := make([]Group, 0, len(groups))
	loads := map[string]Load{}
	for _, g := range groups {
		sort.Slice(g.Procs, func(i, j int) bool { return g.Procs[i].Mem > g.Procs[j].Mem })
		all = append(all, *g)
		if g.Kind == KindSession {
			if l := loadOf(g); l != (Load{}) {
				loads[g.Key] = l
			}
		}
	}
	if !first && tracked {
		s.roll(now, r.Machine, all)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Mem > all[j].Mem })
	for i := range all {
		g := &all[i]
		g.Procs = g.Procs[:min(maxProcesses, len(g.Procs))]
		switch g.Kind {
		case KindSession:
			r.Sessions = append(r.Sessions, *g)
		case KindLeft:
			if g.Mem >= leftWorth || g.CPU >= 1 {
				r.Left = append(r.Left, *g)
				break
			}
			fallthrough
		default:
			if g.Kind == KindOutside && len(r.Outside) < maxOutside {
				r.Outside = append(r.Outside, *g)
			} else {
				r.Rest.Mem += g.Mem
				r.Rest.CPU += g.CPU
				r.Rest.Read += g.Read
				r.Rest.Write += g.Write
				r.Rest.Count += g.Count
			}
		}
	}
	s.prevAt = now
	s.costAvg += (time.Since(began).Seconds() - s.costAvg) / 12
	r.Cost = s.costAvg
	s.mu.Lock()
	s.report, s.loads, s.dirs = r, loads, dirs
	s.mu.Unlock()
}

func loadOf(g *Group) Load {
	var l Load
	if g.Mem >= heavyMem {
		l.Mem = g.Mem / (100 << 20) * (100 << 20)
	}
	if g.CPU >= heavyCPU {
		l.CPU = int(g.CPU/10) * 10
	}
	return l
}

func (s *Sampler) aggregate(procs map[int]*proc, targets []Target, now time.Time, dt float64, first bool) map[string]*Group {
	byKey := map[string]Target{}
	for _, t := range targets {
		byKey[t.Key] = t
	}
	groups := map[string]*Group{}
	cgShared := map[string]bool{}
	next := make(map[procKey]procPrev, len(procs))
	var maxStart uint64
	cgroupOf := map[string]string{}
	totals, base := map[string]float64{}, map[string]float64{}
	for _, p := range procs {
		maxStart = max(maxStart, p.start)
		k := procKey{p.pid, p.start}
		prev, seen := s.prev[k]
		id := p.kind + "/" + p.owner
		total := p.total
		if claudeInfra(p.args) {
			total = p.own
		}
		next[k] = procPrev{p.own, total, p.read, p.write, p.hasIO, id}
		fresh := !seen && !first && p.start > s.prevMax
		g := groups[id]
		if g == nil {
			g = s.newGroup(p, byKey)
			groups[id] = g
		}
		pr := Process{PID: p.pid, PPID: p.ppid, Name: p.name(), Cmd: clip(scrub(p.args), 240), Mem: p.mem()}
		if s.sc.boot > 0 && p.start > 0 {
			pr.Age = max(now.Unix()-s.sc.boot-int64(float64(p.start)/clockTick), 0)
		}
		if dt > 0 && (seen || fresh) {
			pr.CPU = max(p.own-prev.own, 0) / dt * 100
			if p.hasIO && (prev.hasIO || fresh) {
				pr.Read = float64(max(p.read-prev.read, 0)) / dt
				pr.Write = float64(max(p.write-prev.write, 0)) / dt
			}
		}
		totals[id] += total
		if !fresh && !seen {
			base[id] += total
		} else if seen && prev.group != id {
			base[id] += prev.total
		}
		g.Mem += pr.Mem
		g.Read += pr.Read
		g.Write += pr.Write
		g.Count++
		g.Procs = append(g.Procs, pr)
		if p.kind != KindOutside {
			cgShared[p.cgroup] = true
		} else if p.cgroup != "" {
			cgroupOf[id] = p.cgroup
		}
		if p.kind == KindOutside && p.pss == 0 {
			g.RSSOnly = true
		}
	}
	for id, g := range groups {
		if dt > 0 {
			g.CPU = max(totals[id]-s.totals[id]-base[id], 0) / dt * 100
		}
	}
	s.prev, s.prevMax, s.totals = next, maxStart, totals
	cgNext := map[string]counters{}
	for id, cg := range cgroupOf {
		g := groups[id]
		if cgShared[cg] || g.Key == claudeGroup {
			continue
		}
		mem, c, ok := readCgroup(cg)
		if !ok {
			continue
		}
		cgNext[cg] = c
		g.Mem = mem
		g.CPU, g.Read, g.Write = 0, 0, 0
		if prev, seen := s.cgPrev[cg]; seen && dt > 0 {
			g.CPU = max(c.usec-prev.usec, 0) / 1e6 / dt * 100
			g.Read = float64(max(c.read-prev.read, 0)) / dt
			g.Write = float64(max(c.write-prev.write, 0)) / dt
		}
	}
	s.cgPrev = cgNext
	return groups
}

func (s *Sampler) newGroup(p *proc, byKey map[string]Target) *Group {
	g := &Group{Key: p.owner, Kind: p.kind}
	switch p.kind {
	case KindSession:
		t := byKey[p.owner]
		g.Title, g.SessionID = t.Title, t.SessionID
	case KindLeft:
		if p.owner == unknownLeft {
			g.Title = "Session unknown"
			break
		}
		g.Title, g.SessionID = s.leftTitle(p.owner, byKey)
		if g.Title == "" {
			g.Title = p.owner
		}
	default:
		g.Title, g.Detail = s.outsideName(p.owner)
	}
	return g
}

func (s *Sampler) leftTitle(key string, byKey map[string]Target) (string, string) {
	if t, ok := byKey[key]; ok {
		return t.Title, t.SessionID
	}
	if v, ok := s.resolved[key]; ok {
		return v[0], v[1]
	}
	var v [2]string
	if s.Resolve != nil {
		v[0], v[1] = s.Resolve(key)
	}
	s.resolved[key] = v
	return v[0], v[1]
}

func (s *Sampler) outsideName(key string) (string, string) {
	if key == claudeGroup {
		return "Claude daemon and idle spares", ""
	}
	if id, ok := strings.CutPrefix(key, "docker-"); ok {
		id = strings.TrimSuffix(id, ".scope")
		if c, ok := s.docker[id]; ok {
			return c.name, c.dir
		}
		s.dockerMiss = true
		return "container " + short(id), ""
	}
	return strings.TrimSuffix(strings.TrimSuffix(key, ".service"), ".scope"), ""
}

var secretArg = regexp.MustCompile(`(?i)(bearer\s+|(?:token|secret|password|passwd|pwd|api[-_]?key|auth)[-_a-z]*[=:\s]\s*(?:bearer\s+)?)[^\s"']+`)

// scrub hides what command lines often carry, since they end up on screen and in agents' transcripts.
func scrub(args string) string {
	return secretArg.ReplaceAllString(args, "${1}***")
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func (s *Sampler) roll(now time.Time, m Machine, groups []Group) {
	if s.Dir == "" {
		return
	}
	cur := now.Truncate(time.Minute)
	if !s.minAt.IsZero() && cur.After(s.minAt) && s.min.n > 0 {
		if err := appendRow(s.Dir, s.min.finish(s.minAt)); err != nil {
			log.Printf("resources: %v", err)
		}
		if cur.Hour() != s.minAt.Hour() {
			prune(s.Dir, now)
		}
		s.min = minute{}
	}
	s.minAt = cur
	s.min.add(m, groups)
}

func (s *Sampler) Report() Report {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.report
	r.Disk, r.DiskAt = claimDisk(s.disk.Uses, s.dirs), s.disk.At
	r.RAMDirs = s.ramDirs
	return r
}

func (s *Sampler) Load(key string) *Load {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if l, ok := s.loads[key]; ok {
		return &l
	}
	return nil
}

// History is the machine's rows, or with a key only that session's, which is far less to send.
func (s *Sampler) History(d time.Duration, key string) []Row {
	if s.Dir == "" {
		return nil
	}
	now := time.Now()
	rows := readRows(s.Dir, now.Add(-d), now, key)
	if key != "" {
		for i := range rows {
			rows[i].Groups = slices.DeleteFunc(rows[i].Groups, func(g RowGroup) bool { return g.Key != key })
		}
	}
	return thin(rows, maxPoints)
}
