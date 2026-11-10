package ends

import (
	"strings"
	"testing"
	"time"
)

var base = time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)

func at(d time.Duration) string { return base.Add(d).Format("2006-01-02T15:04:05.000Z") }

func watcher(lines ...string) *Watcher {
	w := New("", "", "box", nil)
	w.since = base.Add(-time.Hour)
	for _, l := range lines {
		w.daemonLine(l)
	}
	return w
}

func TestStoppedInAtc(t *testing.T) {
	w := watcher("[" + at(2*time.Second) + "] [bg] bg settled aaaa1111 (killed)")
	w.stops["aaaa1111"] = []Stop{{At: base, ID: "aaaa1111", By: You, Who: "laptop, Chrome"}}
	e := w.explain("aaaa1111", time.Time{})
	if e.Cause != You || !strings.Contains(e.Text, "laptop, Chrome") {
		t.Fatalf("got %+v", e)
	}
	w.stops["aaaa1111"] = []Stop{{At: base, ID: "aaaa1111", By: Session, Who: "Planner"}}
	if e := w.explain("aaaa1111", time.Time{}); e.Cause != Session || e.Short != "stopped by “Planner”" {
		t.Fatalf("got %+v", e)
	}
}

func TestKilledOutsideAtc(t *testing.T) {
	w := watcher("[" + at(0) + "] [bg] bg settled aaaa1111 (killed)")
	if e := w.explain("aaaa1111", time.Time{}); e.Cause != Outside || !e.Sure {
		t.Fatalf("got %+v", e)
	}
	w.since = base.Add(time.Hour)
	if e := w.explain("aaaa1111", time.Time{}); e.Sure {
		t.Fatalf("before atc kept stops it can't say who: %+v", e)
	}
}

func TestClosedForMemory(t *testing.T) {
	w := watcher(
		"["+at(0)+"] [bg] bg: low memory persists after shedding non-pinned",
		"["+at(time.Second)+"] [bg] bg retire bbbb2222: idle-prompt, idle 70m [low memory, pinned]",
		"["+at(10*time.Second)+"] [bg] bg settled bbbb2222 (done)",
	)
	e := w.explain("bbbb2222", time.Time{})
	if e.Cause != Memory || !strings.Contains(e.Text, "idle 70m") || e.Incident != lowID(base) {
		t.Fatalf("got %+v", e)
	}
	inc := w.Incident(e.Incident)
	if inc == nil || len(inc.Closed) != 1 || inc.Closed[0].ID != "bbbb2222" {
		t.Fatalf("incident %+v", inc)
	}
}

func TestOutOfMemoryTakesTheDaemon(t *testing.T) {
	w := watcher(
		"["+at(-2*time.Minute)+"] [bg] bg: low memory persists after shedding non-pinned",
		"["+at(-2*time.Minute+time.Second)+"] [bg] bg retire bbbb2222: settled, idle 4h [low memory, pinned]",
		"["+at(-2*time.Minute+5*time.Second)+"] [bg] bg settled bbbb2222 (done)",
		"["+at(0)+"] [supervisor] shutting down (cause=signal, uptime=100s, leases=1, live_workers=3)",
		"["+at(7*time.Second)+"] [bg] bg settled aaaa1111 (done)",
		"["+at(8*time.Second)+"] [bg] bg settled cccc3333 (done)",
	)
	w.kills = []Kill{{At: base.Add(time.Second), PID: 42, Name: "java", RSS: 20 << 30, Global: true,
		Cgroup: "/user.slice/user-1000.slice/user@1000.service/claude.slice/claude-daemon-7.scope",
		Owner:  &Owner{Kind: "session", Key: "cccc3333", Title: "Builder"}}}
	e := w.explain("aaaa1111", time.Time{})
	if e.Cause != OOM || !strings.Contains(e.Text, "java in “Builder” (20.0 GB)") || !strings.Contains(e.Text, "systemd stopped") {
		t.Fatalf("got %+v", e)
	}
	if e := w.explain("cccc3333", time.Time{}); !strings.Contains(e.Text, "this session's java") {
		t.Fatalf("the culprit itself: %+v", e)
	}
	inc := w.Incident(e.Incident)
	if inc == nil || len(inc.Lost) != 2 || len(inc.Closed) != 1 || !inc.DaemonDown || !inc.Scoped {
		t.Fatalf("incident %+v", inc)
	}
	if !strings.Contains(inc.Text, "closed 1 session") || !strings.Contains(inc.Text, "2 sessions stopped") {
		t.Fatalf("text %q", inc.Text)
	}
	if got := w.Incidents(); len(got) != 1 || got[0].ID != e.Incident {
		t.Fatalf("the low-memory warning before the kill is part of it, not its own incident: %+v", got)
	}
}

func TestUpdateAndCrash(t *testing.T) {
	w := watcher(
		"["+at(0)+"] [supervisor] binary at /home/u/.local/bin/claude changed (/v/2.1.1 → /v/2.1.2), self-restarting for upgrade",
		"["+at(time.Second)+"] [supervisor] shutting down (cause=upgrade, uptime=10s, leases=0, live_workers=1)",
		"["+at(5*time.Second)+"] [bg] bg settled aaaa1111 (done)",
		"["+at(time.Hour)+"] [bg] bg settled dddd4444 (crashed)",
		"["+at(2*time.Hour)+"] [bg] bg settled eeee5555 (done)",
	)
	if e := w.explain("aaaa1111", time.Time{}); e.Cause != Updated || !strings.Contains(e.Text, "2.1.1 → 2.1.2") {
		t.Fatalf("got %+v", e)
	}
	if e := w.explain("dddd4444", time.Time{}); e.Cause != Crashed {
		t.Fatalf("got %+v", e)
	}
	if e := w.explain("eeee5555", time.Time{}); e.Cause != Exited {
		t.Fatalf("got %+v", e)
	}
}

func TestNoLineAfterReboot(t *testing.T) {
	w := watcher()
	w.boot = base
	if e := w.explain("ffff6666", base.Add(-time.Hour)); e.Cause != Rebooted {
		t.Fatalf("got %+v", e)
	}
	if e := w.explain("ffff6666", base.Add(time.Hour)); e.Cause != Unknown || e.Sure {
		t.Fatalf("got %+v", e)
	}
}

func TestKernelLines(t *testing.T) {
	where := kOOM.FindStringSubmatch("oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/user.slice/claude.slice/run-p1-i2.scope,task=java,pid=99,uid=1000")
	kill := kKill.FindStringSubmatch("Out of memory: Killed process 99 (java) total-vm:100kB, anon-rss:2048kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:4kB oom_score_adj:200")
	if where == nil || where[2] != "/user.slice/claude.slice/run-p1-i2.scope" || where[4] != "99" || kill == nil || kill[1] != "99" || kill[3] != "2048" {
		t.Fatalf("%q %q", where, kill)
	}
	if !inClaude(where[2]) {
		t.Fatal("a scope in claude.slice holds Claude's daemon")
	}
}
