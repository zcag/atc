package resources

import "strings"

const (
	KindSession = "session"
	KindLeft    = "left"
	KindOutside = "outside"
	claudeGroup = "claude"
	unknownLeft = "unknown"
)

func claudeInfra(args string) bool {
	return strings.Contains(args, "--bg-pty-host") || strings.Contains(args, "--bg-spare") || strings.Contains(args, "claude daemon run")
}

// attribute decides who each process belongs to. A session's process tree comes first. A process
// that lost its parent still carries the session in its environment (or its job folder in its
// arguments), so it counts for that session, or as left behind when that session is gone. Claude's
// daemon and idle spares inherit whatever environment started them, so they are never read that way.
func attribute(procs map[int]*proc, targets []Target) {
	byPID := map[int]*Target{}
	byID := map[string]*Target{}
	for i := range targets {
		t := &targets[i]
		if t.PID > 0 {
			byPID[t.PID] = t
		}
		byID[t.Key] = t
		if t.SessionID != "" {
			byID[t.SessionID] = t
			byID[short(t.SessionID)] = t
		}
	}
	owner := map[int]*Target{}
	var walk func(pid, depth int) *Target
	walk = func(pid, depth int) *Target {
		if t, ok := owner[pid]; ok {
			return t
		}
		var t *Target
		if t = byPID[pid]; t == nil && depth < 64 {
			if p := procs[pid]; p != nil && p.ppid > 1 {
				t = walk(p.ppid, depth+1)
			}
		}
		owner[pid] = t
		return t
	}
	for pid, p := range procs {
		if t := walk(pid, 0); t != nil {
			p.kind, p.owner = KindSession, t.Key
			continue
		}
		if claudeInfra(p.args) || strings.Contains(p.cgroup, "/docker-") {
			continue
		}
		key := carriedKey(p, procs)
		if key == "" {
			if strings.Contains(p.cgroup, "/claude-daemon-") {
				p.kind, p.owner = KindLeft, unknownLeft
			}
			continue
		}
		if t := byID[key]; t != nil && t.PID > 0 {
			p.kind, p.owner = KindSession, t.Key
		} else if t != nil {
			p.kind, p.owner = KindLeft, t.Key
		} else {
			p.kind, p.owner = KindLeft, key
		}
	}
	for _, p := range procs {
		if parent := procs[p.ppid]; p.kind == KindSession && parent != nil && parent.kind == "" && strings.Contains(parent.args, "--bg-pty-host") {
			parent.kind, parent.owner = KindSession, p.owner
		}
	}
	for _, p := range procs {
		if p.kind == "" {
			p.kind, p.owner = KindOutside, outsideKey(p)
		}
	}
}

// carriedKey is the session a process or its nearest ancestor names. Chromium's helpers, say, carry
// nothing themselves: only the browser they descend from has the job folder in its arguments.
func carriedKey(p *proc, procs map[int]*proc) string {
	for range 64 {
		if p == nil || claudeInfra(p.args) {
			return ""
		}
		if p.job != "" {
			return p.job
		}
		if p.sess != "" {
			return short(p.sess)
		}
		p = procs[p.ppid]
	}
	return ""
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func outsideKey(p *proc) string {
	if p.cgroup == "" {
		return p.name()
	}
	leaf := p.cgroup[strings.LastIndexByte(p.cgroup, '/')+1:]
	if claudeInfra(p.args) || strings.HasPrefix(leaf, "claude-daemon-") {
		return claudeGroup
	}
	if leaf == "" {
		return "kernel"
	}
	return leaf
}
