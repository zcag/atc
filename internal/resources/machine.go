package resources

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type Disk struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Used int64  `json:"used"`
}

type Machine struct {
	Cores     int     `json:"cores"`
	CPU       float64 `json:"cpu"`
	MemTotal  int64   `json:"memTotal"`
	MemUsed   int64   `json:"memUsed"`
	SwapTotal int64   `json:"swapTotal"`
	SwapUsed  int64   `json:"swapUsed"`
	Load      float64 `json:"load"`
	Pressure  float64 `json:"pressure"`
	Shared    int64   `json:"shared,omitempty"`
	RAMDisk   int64   `json:"ramDisk,omitempty"`
	Read      float64 `json:"read"`
	Write     float64 `json:"write"`
	Disks     []Disk  `json:"disks,omitempty"`
}

type machineReader struct {
	busy, idle  float64
	read, write int64
	devices     map[string]bool
}

func (m *machineReader) sample(dt float64) Machine {
	out := Machine{Cores: runtime.NumCPU()}
	if runtime.GOOS != "linux" {
		darwinMachine(&out)
		return out
	}
	if b, err := os.ReadFile("/proc/stat"); err == nil {
		line, _, _ := bytes.Cut(b, []byte{'\n'})
		f := bytes.Fields(line)
		var busy, idle float64
		for i, v := range f[1:] {
			n, _ := strconv.ParseFloat(string(v), 64)
			if i == 3 || i == 4 {
				idle += n
			} else if i < 8 {
				busy += n
			}
		}
		if total := busy - m.busy + idle - m.idle; m.busy > 0 && total > 0 {
			out.CPU = (busy - m.busy) / total * 100 * float64(out.Cores)
		}
		m.busy, m.idle = busy, idle
	}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		out.MemTotal = field(b, "MemTotal:") * 1024
		out.MemUsed = out.MemTotal - field(b, "MemAvailable:")*1024
		out.SwapTotal = field(b, "SwapTotal:") * 1024
		out.SwapUsed = out.SwapTotal - field(b, "SwapFree:")*1024
		out.Shared = field(b, "Shmem:") * 1024
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		if f := bytes.Fields(b); len(f) > 0 {
			out.Load, _ = strconv.ParseFloat(string(f[0]), 64)
		}
	}
	if b, err := os.ReadFile("/proc/pressure/memory"); err == nil {
		out.Pressure = psiAvg60(b)
	}
	out.Read, out.Write = m.diskIO(dt)
	return out
}

func psiAvg60(b []byte) float64 {
	line, _, _ := bytes.Cut(b, []byte{'\n'})
	_, rest, ok := bytes.Cut(line, []byte("avg60="))
	if !ok {
		return 0
	}
	f := bytes.Fields(rest)
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(string(f[0]), 64)
	return v
}

func (m *machineReader) diskIO(dt float64) (float64, float64) {
	if m.devices == nil {
		m.devices = map[string]bool{}
		entries, _ := os.ReadDir("/sys/block")
		for _, e := range entries {
			if n := e.Name(); !strings.HasPrefix(n, "loop") && !strings.HasPrefix(n, "ram") && !strings.HasPrefix(n, "dm-") && !strings.HasPrefix(n, "zram") {
				m.devices[n] = true
			}
		}
	}
	b, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return 0, 0
	}
	var read, write int64
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) > 9 && m.devices[f[2]] {
			r, _ := strconv.ParseInt(f[5], 10, 64)
			w, _ := strconv.ParseInt(f[9], 10, 64)
			read += r * 512
			write += w * 512
		}
	}
	var rr, wr float64
	if m.read > 0 && dt > 0 {
		rr, wr = float64(read-m.read)/dt, float64(write-m.write)/dt
	}
	m.read, m.write = read, write
	return rr, wr
}

func diskFree() []Disk {
	home, _ := os.UserHomeDir()
	b, err := exec.Command("df", "-kP", home).Output()
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return nil
	}
	f := strings.Fields(lines[len(lines)-1])
	if len(f) < 6 {
		return nil
	}
	size, _ := strconv.ParseInt(f[1], 10, 64)
	avail, _ := strconv.ParseInt(f[3], 10, 64)
	return []Disk{{Path: filepath.Clean(f[len(f)-1]), Size: size * 1024, Used: (size - avail) * 1024}}
}

// ramDisks is what files hold in /tmp and /dev/shm when those are tmpfs. It is memory no process
// owns, so it shows in no group's numbers.
func ramDisks() int64 {
	b, _ := exec.Command("df", "-k", "-t", "tmpfs", "--output=used", "/tmp", "/dev/shm").Output()
	var kb int64
	for _, line := range strings.Split(string(b), "\n") {
		n, _ := strconv.ParseInt(strings.TrimSpace(line), 10, 64)
		kb += n
	}
	return kb * 1024
}

// ramDirs lists the big folders directly under /tmp.
func ramDirs() []DiskUse {
	b, _ := exec.Command("nice", "-n", "19", "du", "-xk", "--max-depth=1", "/tmp").Output()
	var out []DiskUse
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.SplitN(line, "\t", 2)
		if len(f) != 2 || f[1] == "/tmp" {
			continue
		}
		kb, _ := strconv.ParseInt(f[0], 10, 64)
		if kb*1024 >= ramDirWorth {
			out = append(out, DiskUse{Path: f[1], Kind: "ram", Size: kb * 1024})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Size > out[j].Size })
	return out[:min(12, len(out))]
}

func darwinMachine(out *Machine) {
	sysctl := func(name string) string {
		b, _ := exec.Command("sysctl", "-n", name).Output()
		return strings.TrimSpace(string(b))
	}
	out.MemTotal, _ = strconv.ParseInt(sysctl("hw.memsize"), 10, 64)
	if f := strings.Fields(strings.Trim(sysctl("vm.loadavg"), "{} ")); len(f) > 0 {
		out.Load, _ = strconv.ParseFloat(f[0], 64)
	}
	if b, err := exec.Command("vm_stat").Output(); err == nil {
		page, free := int64(16384), int64(0)
		for _, line := range strings.Split(string(b), "\n") {
			if _, rest, ok := strings.Cut(line, "page size of "); ok {
				page, _ = strconv.ParseInt(strings.Fields(rest)[0], 10, 64)
			}
			k, v, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			if k == "Pages free" || k == "Pages inactive" || k == "Pages speculative" || k == "Pages purgeable" {
				n, _ := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(v), "."), 10, 64)
				free += n
			}
		}
		out.MemUsed = out.MemTotal - free*page
	}
	swap := strings.Fields(sysctl("vm.swapusage"))
	for i, w := range swap {
		if i+2 < len(swap) && swap[i+1] == "=" {
			n, _ := strconv.ParseFloat(strings.TrimSuffix(swap[i+2], "M"), 64)
			if w == "total" {
				out.SwapTotal = int64(n * (1 << 20))
			} else if w == "used" {
				out.SwapUsed = int64(n * (1 << 20))
			}
		}
	}
}

type counters struct {
	usec        float64
	read, write int64
}

func readCgroup(path string) (mem int64, c counters, ok bool) {
	dir := "/sys/fs/cgroup" + path + "/"
	b, err := os.ReadFile(dir + "memory.current")
	if err != nil {
		return 0, c, false
	}
	mem, _ = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if st, err := os.ReadFile(dir + "memory.stat"); err == nil {
		mem -= field(st, "inactive_file ")
	}
	if st, err := os.ReadFile(dir + "cpu.stat"); err == nil {
		c.usec = float64(field(st, "usage_usec "))
	}
	if st, err := os.ReadFile(dir + "io.stat"); err == nil {
		for _, w := range strings.Fields(string(st)) {
			if v, ok := strings.CutPrefix(w, "rbytes="); ok {
				n, _ := strconv.ParseInt(v, 10, 64)
				c.read += n
			} else if v, ok := strings.CutPrefix(w, "wbytes="); ok {
				n, _ := strconv.ParseInt(v, 10, 64)
				c.write += n
			}
		}
	}
	return max(mem, 0), c, true
}

type container struct{ name, dir string }

func dockerNames() map[string]container {
	if _, err := exec.LookPath("docker"); err != nil {
		return nil
	}
	b, err := exec.Command("docker", "ps", "--no-trunc", "--format", `{{.ID}}	{{.Names}}	{{.Label "com.docker.compose.project.working_dir"}}`).Output()
	if err != nil {
		return nil
	}
	out := map[string]container{}
	for _, line := range strings.Split(string(b), "\n") {
		if f := strings.Split(line, "\t"); len(f) == 3 {
			out[f[0]] = container{f[1], f[2]}
		}
	}
	return out
}
