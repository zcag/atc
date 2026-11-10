package resources

import "time"

const ownerKeep = 10 * time.Minute

// Owner is who a process belonged to when the sampler last saw it. A process the kernel kills
// for memory is gone by the time anyone asks, so this is kept for a few minutes after it goes.
type Owner struct {
	Kind      string    `json:"kind"`
	Key       string    `json:"key"`
	Title     string    `json:"title"`
	SessionID string    `json:"sessionId,omitempty"`
	Name      string    `json:"name"`
	Mem       int64     `json:"mem"`
	Seen      time.Time `json:"seen"`
}

func (s *Sampler) remember(procs map[int]*proc, groups map[string]*Group, now time.Time) {
	next := make(map[int]Owner, len(procs))
	s.mu.Lock()
	for pid, o := range s.owners {
		if now.Sub(o.Seen) < ownerKeep {
			next[pid] = o
		}
	}
	s.mu.Unlock()
	for _, p := range procs {
		o := Owner{Kind: p.kind, Key: p.owner, Name: p.name(), Mem: p.mem(), Seen: now}
		if g := groups[p.kind+"/"+p.owner]; g != nil {
			o.Title, o.SessionID = g.Title, g.SessionID
		}
		next[p.pid] = o
	}
	s.mu.Lock()
	s.owners = next
	s.mu.Unlock()
}

// Between is the machine's rows from since to until, a point a minute, not thinned.
func (s *Sampler) Between(since, until time.Time) []Row {
	if s == nil || s.Dir == "" {
		return nil
	}
	return readRows(s.Dir, since, until, "")
}

// OwnerOf is who pid belonged to, if the sampler saw it in the last few minutes.
func (s *Sampler) OwnerOf(pid int) (Owner, bool) {
	if s == nil {
		return Owner{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.owners[pid]
	return o, ok
}
