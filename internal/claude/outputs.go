package claude

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Output is the end of what a background shell command or monitor has written so far, and how it exited once it
// has. An agent's output is its transcript, read elsewhere.
type Output struct {
	Lines   []string  `json:"lines"`
	Size    int64     `json:"size"`
	Updated time.Time `json:"updated"`
	Exit    *int      `json:"exit,omitempty"`
}

var exited = regexp.MustCompile(`^\[exited with code (-?\d+)\]$`)

// taskDirs is where Claude Code keeps a session's background task outputs: <tmp>/claude-<uid>/<project>/<session>/tasks.
func taskDirs(sessionID string) []string {
	seen := map[string]bool{}
	var out []string
	for _, tmp := range []string{os.TempDir(), "/tmp"} {
		got, _ := filepath.Glob(filepath.Join(tmp, "claude-*", "*", sessionID, "tasks"))
		for _, d := range got {
			if !seen[d] {
				seen[d] = true
				out = append(out, d)
			}
		}
	}
	return out
}

// Outputs is the last n lines of each background shell command and monitor of a session, or of only the one task
// given.
func Outputs(sessionID string, n int, only string) map[string]Output {
	out := map[string]Output{}
	for _, dir := range taskDirs(sessionID) {
		files, _ := filepath.Glob(filepath.Join(dir, "*.output"))
		for _, f := range files {
			id := strings.TrimSuffix(filepath.Base(f), ".output")
			if only != "" && id != only {
				continue
			}
			st, err := os.Lstat(f)
			if err != nil || st.Mode()&os.ModeSymlink != 0 {
				continue
			}
			out[id] = tail(f, st, n)
		}
	}
	return out
}

func tail(path string, st os.FileInfo, n int) Output {
	o := Output{Size: st.Size(), Updated: st.ModTime()}
	f, err := os.Open(path)
	if err != nil {
		return o
	}
	defer f.Close()
	const most = 64 << 10
	if st.Size() > most {
		f.Seek(-most, io.SeekEnd)
	}
	b, _ := io.ReadAll(f)
	var lines []string
	for _, l := range bytes.Split(b, []byte("\n")) {
		if t := strings.TrimRight(string(l), "\r "); strings.TrimSpace(t) != "" {
			lines = append(lines, lastFrame(t))
		}
	}
	if len(lines) > 0 {
		if m := exited.FindStringSubmatch(lines[len(lines)-1]); m != nil {
			code, _ := strconv.Atoi(m[1])
			o.Exit, lines = &code, lines[:len(lines)-1]
		}
	}
	o.Lines = lines[max(0, len(lines)-n):]
	return o
}

// lastFrame is what a line that redraws itself with carriage returns (a progress bar) shows last.
func lastFrame(l string) string {
	if i := strings.LastIndex(l, "\r"); i >= 0 {
		return l[i+1:]
	}
	return l
}
