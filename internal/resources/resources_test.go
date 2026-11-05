package resources

import (
	"os"
	"testing"
	"time"
)

func TestAttribute(t *testing.T) {
	procs := map[int]*proc{
		1:  {pid: 1, args: "systemd"},
		10: {pid: 10, ppid: 1, args: "claude daemon run", cgroup: "/claude.slice/claude-daemon-10.scope"},
		20: {pid: 20, ppid: 10, args: "claude bg-pty-host --bg-pty-host x"},
		21: {pid: 21, ppid: 20, args: "claude bg-spare --bg-spare x", job: "stale000"},
		30: {pid: 30, ppid: 21, args: "zsh -c rspec", sess: "aaaaaaaa-1"},
		31: {pid: 31, ppid: 30, args: "ruby rspec"},
		40: {pid: 40, ppid: 1, args: "mongod", job: "aaaaaaaa"},
		41: {pid: 41, ppid: 1, args: "bundle exec puma", sess: "bbbbbbbb-1"},
		42: {pid: 42, ppid: 1, args: "chromium --user-data-dir=/h/.claude/jobs/cccccccc/x", job: "cccccccc"},
		50: {pid: 50, ppid: 1, args: "postgres", cgroup: "/system.slice/docker-abc.scope", job: "aaaaaaaa"},
		60: {pid: 60, ppid: 10, args: "claude bg-pty-host --bg-pty-host y", job: "aaaaaaaa"},
		61: {pid: 61, ppid: 60, args: "claude bg-spare --bg-spare y"},
		43: {pid: 43, ppid: 42, args: "chromium --type=renderer"},
		44: {pid: 44, ppid: 1, args: "sudo find", cgroup: "/claude.slice/claude-daemon-10.scope"},
		70: {pid: 70, ppid: 1, args: "atc serve", cgroup: "/app.slice/atc.service"},
	}
	attribute(procs, []Target{
		{Key: "aaaaaaaa", SessionID: "aaaaaaaa-1", PID: 21},
		{Key: "bbbbbbbb", SessionID: "bbbbbbbb-1"},
	})
	want := map[int][2]string{
		10: {KindOutside, claudeGroup},
		20: {KindSession, "aaaaaaaa"},
		21: {KindSession, "aaaaaaaa"},
		30: {KindSession, "aaaaaaaa"},
		31: {KindSession, "aaaaaaaa"},
		40: {KindSession, "aaaaaaaa"},
		41: {KindLeft, "bbbbbbbb"},
		42: {KindLeft, "cccccccc"},
		43: {KindLeft, "cccccccc"},
		44: {KindLeft, unknownLeft},
		50: {KindOutside, "docker-abc.scope"},
		60: {KindOutside, claudeGroup},
		61: {KindOutside, claudeGroup},
		70: {KindOutside, "atc.service"},
	}
	for pid, w := range want {
		if p := procs[pid]; p.kind != w[0] || p.owner != w[1] {
			t.Errorf("pid %d (%s): got %s/%s, want %s/%s", pid, p.args, p.kind, p.owner, w[0], w[1])
		}
	}
}

func TestCPUSurvivesAChildBeingReaped(t *testing.T) {
	s := New("", "")
	s.prevMax = 100
	targets := []Target{{Key: "a", PID: 100}}
	before := map[int]*proc{
		100: {pid: 100, start: 50, args: "claude", own: 10, total: 10},
		101: {pid: 101, ppid: 100, start: 60, args: "rspec", own: 30, total: 30},
	}
	attribute(before, targets)
	now := time.Now()
	s.aggregate(before, targets, now, 0, true)

	after := map[int]*proc{
		100: {pid: 100, start: 50, args: "claude", own: 10, total: 45},
	}
	attribute(after, targets)
	g := s.aggregate(after, targets, now, 10, false)[KindSession+"/a"]
	if g.CPU != 50 {
		t.Fatalf("5 CPU-seconds in a child that exited during 10s should read 50%%, got %v", g.CPU)
	}
}

func TestAttributionFlipIsNoDiskSpike(t *testing.T) {
	s := New("", "")
	now := time.Now()
	outside := map[int]*proc{100: {pid: 100, start: 50, args: "claude", own: 1, total: 1}}
	attribute(outside, nil)
	s.aggregate(outside, nil, now, 0, true)

	targets := []Target{{Key: "a", PID: 100}}
	inside := map[int]*proc{100: {pid: 100, start: 50, args: "claude", own: 1, total: 1, read: 1 << 40, write: 1 << 40, hasIO: true}}
	attribute(inside, targets)
	g := s.aggregate(inside, targets, now, 10, false)[KindSession+"/a"]
	if g.Read != 0 || g.Write != 0 {
		t.Fatalf("a lifetime's disk counters read as a rate: %v %v", g.Read, g.Write)
	}
	again := map[int]*proc{100: {pid: 100, start: 50, args: "claude", own: 1, total: 1, read: 1<<40 + 1000, write: 1 << 40, hasIO: true}}
	attribute(again, targets)
	if g = s.aggregate(again, targets, now, 10, false)[KindSession+"/a"]; g.Read != 100 {
		t.Fatalf("real rate lost: %v", g.Read)
	}
}

func TestHostReapingASessionIsNoCPUSpike(t *testing.T) {
	s := New("", "")
	now := time.Now()
	host := func(reaped float64) map[int]*proc {
		return map[int]*proc{50: {pid: 50, ppid: 10, start: 5, args: "claude bg-pty-host --bg-pty-host x", own: 1, total: 1 + reaped}}
	}
	first := host(0)
	attribute(first, nil)
	s.aggregate(first, nil, now, 0, true)
	after := host(36000)
	attribute(after, nil)
	if g := s.aggregate(after, nil, now, 10, false)[KindOutside+"/"+claudeGroup]; g.CPU != 0 {
		t.Fatalf("a session's lifetime CPU landed on its host: %v", g.CPU)
	}
}

func TestNoHistoryBeforeSessionsAreKnown(t *testing.T) {
	s := New(t.TempDir(), "")
	s.tick(time.Now())
	s.tick(time.Now().Add(every))
	if s.min.n != 0 {
		t.Fatalf("rolled %d samples with no session list", s.min.n)
	}
	s.Track(nil)
	s.tick(time.Now().Add(2 * every))
	if s.min.n != 1 {
		t.Fatalf("rolled %d samples once tracked", s.min.n)
	}
}

func TestScrub(t *testing.T) {
	for in, want := range map[string]string{
		"npm exec x --cdp-header Authorization: Bearer a3f5c9 --flag": "npm exec x --cdp-header Authorization: Bearer *** --flag",
		"curl --token abc123 http://x":                                "curl --token *** http://x",
		"app --api-key=sk-123 run":                                    "app --api-key=*** run",
		"mysql --password=hunter2 db":                                 "mysql --password=*** db",
		"puma 6.4.3 (tcp://0.0.0.0:3020) [wt-42]":                     "puma 6.4.3 (tcp://0.0.0.0:3020) [wt-42]",
		"rspec spec/token_spec.rb":                                    "rspec spec/token_spec.rb",
	} {
		if got := scrub(in); got != want {
			t.Errorf("%q: got %q", in, got)
		}
	}
}

func TestSessionEnv(t *testing.T) {
	job, sess := sessionEnv([]byte("A=1\x00CLAUDE_JOB_DIR=/h/.claude/jobs/7de3376e\x00CLAUDE_CODE_SESSION_ID=7de3-x\x00"))
	if job != "7de3376e" || sess != "7de3-x" {
		t.Fatal(job, sess)
	}
}

func TestParseCPUTime(t *testing.T) {
	for in, want := range map[string]float64{"0:01.50": 1.5, "12:00.00": 720, "1-00:00:01": 86401} {
		if got := parseCPUTime(in); got != want {
			t.Errorf("%s: %v", in, got)
		}
	}
}

func TestMinuteKeepsPeaksAndDropsTheSmall(t *testing.T) {
	var m minute
	m.add(Machine{CPU: 100, MemUsed: 5}, []Group{{Key: "big", Kind: KindSession, Mem: 2 << 30, CPU: 100, Procs: []Process{{Name: "bundle", Mem: 2 << 30}}}, {Key: "small", Kind: KindSession, Mem: 1 << 20}})
	m.add(Machine{CPU: 200, MemUsed: 3}, []Group{{Key: "big", Kind: KindSession, Mem: 1 << 30, CPU: 300}})
	r := m.finish(time.Unix(600, 0))
	if r.CPU != 150 || r.Mem != 5 || len(r.Groups) != 1 {
		t.Fatalf("%+v", r)
	}
	g := r.Groups[0]
	if g.CPU != 200 || g.Mem != 2<<30 || g.Top[0].Name != "bundle" {
		t.Fatalf("%+v", g)
	}
}

func TestHistoryRoundTripAndThin(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	for i := range 10 {
		mem := int64(1)
		if i == 4 {
			mem = 99
		}
		if err := appendRow(dir, Row{T: base.Add(time.Duration(i) * time.Minute).Unix(), CPU: 10, Mem: mem, Groups: []RowGroup{{Key: "a", Kind: KindSession, Mem: mem}}}); err != nil {
			t.Fatal(err)
		}
	}
	if got := readRows(dir, base.Add(-time.Minute), time.Now(), "nobody"); len(got) != 0 {
		t.Fatalf("key filter kept %d rows", len(got))
	}
	rows := readRows(dir, base.Add(-time.Minute), time.Now(), "a")
	if len(rows) != 10 {
		t.Fatalf("read %d rows", len(rows))
	}
	got := thin(rows, 2)
	if len(got) != 2 || got[0].Mem != 99 || got[0].Groups[0].Mem != 99 || got[0].CPU != 10 {
		t.Fatalf("%+v", got)
	}
}

func TestClaimDisk(t *testing.T) {
	uses := []DiskUse{{Path: "/p/app", Kind: "repo"}, {Path: "/p/app/wt-1", Kind: "worktree"}, {Path: "/c/jobs", Kind: "claude"}}
	got := claimDisk(uses, map[string][]string{"in wt": {"/p/app/wt-1/app"}, "in repo": {"/p/app"}})
	if len(got[0].Sessions) != 1 || got[0].Sessions[0] != "in repo" || len(got[1].Sessions) != 1 || got[1].Sessions[0] != "in wt" || len(got[2].Sessions) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestSubtractNested(t *testing.T) {
	uses := []DiskUse{{Path: "/f", Size: 100}, {Path: "/f/repo", Size: 60}, {Path: "/f/repo/wt", Size: 20}}
	subtractNested(uses)
	if uses[0].Size != 40 || uses[1].Size != 40 || uses[2].Size != 20 {
		t.Fatalf("%+v", uses)
	}
}

func TestPSSRereadOnlyWhenItMoved(t *testing.T) {
	id := &identity{pss: 80, pssRSS: 100, pssAt: time.Now()}
	if pssStale(id, 105) {
		t.Fatal("a 5% change should use the cached share")
	}
	if !pssStale(id, 120) || !pssStale(&identity{}, 100) {
		t.Fatal("a large change or no reading must re-read")
	}
	id.pssAt = time.Now().Add(-2 * time.Minute)
	if !pssStale(id, 100) {
		t.Fatal("an old reading must re-read")
	}
}

func TestScanFindsThisProcess(t *testing.T) {
	sc := newScanner()
	p := sc.scan()[os.Getpid()]
	if p == nil || p.rss == 0 || p.args == "" {
		t.Fatalf("%+v", p)
	}
}
