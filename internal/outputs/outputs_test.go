package outputs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestToolResultsGiveNoLinks(t *testing.T) {
	tr := filepath.Join(t.TempDir(), "t.jsonl")
	os.WriteFile(tr, []byte(`{"type":"user","timestamp":"2026-10-01T10:02:00Z","message":{"content":[{"type":"tool_result","content":"fetched https://docs.example.com/x\n  http://pages.example/report"}]}}
`), 0o644)
	var s Scanner
	if _, links, _ := s.Scan(tr, t.TempDir()); len(links) != 0 {
		t.Errorf("links %v", links)
	}
}

func TestScan(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "app.go"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(home, "shot.png"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(home, "report.md"), []byte("x"), 0o644)
	tr := filepath.Join(t.TempDir(), "t.jsonl")
	lines := `{"type":"assistant","timestamp":"2026-10-01T10:00:00Z","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"` + home + `/report.md"}}]}}
{"type":"assistant","timestamp":"2026-10-01T10:01:00Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"` + home + `/app.go"}}]}}
{"type":"user","timestamp":"2026-10-01T10:02:00Z","message":{"content":[{"type":"tool_result","content":"  VITE ready\n  Local: http://localhost:5173/\nsaved ~/shot.png"}]}}
{"type":"assistant","timestamp":"2026-10-01T10:03:00Z","message":{"content":[{"type":"text","text":"Published it at http://pages.example/report. Also see ` + home + `/gone.png."}]}}
`
	os.WriteFile(tr, []byte(lines), 0o644)
	var s Scanner
	files, links, ports := s.Scan(tr, home)
	got := map[string]string{}
	for _, f := range files {
		got[filepath.Base(f.Path)] = f.Op + " " + f.Kind
	}
	want := map[string]string{"report.md": "made markdown", "app.go": "edited text", "shot.png": "seen image"}
	if len(got) != len(want) {
		t.Fatalf("files %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %q, want %q", k, got[k], v)
		}
	}
	if len(links) != 1 || links[0].URL != "http://pages.example/report" {
		t.Errorf("links %v", links)
	}
	if _, ok := ports["5173"]; !ok || len(ports) != 1 {
		t.Errorf("ports %v", ports)
	}
	os.WriteFile(tr, []byte(lines+`{"type":"assistant","timestamp":"2026-10-01T10:04:00Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"`+home+`/report.md"}}]}}
`), 0o644)
	files, _, _ = s.Scan(tr, home)
	if files[0].Op != "edited" || filepath.Base(files[0].Path) != "report.md" {
		t.Errorf("incremental rescan: %+v", files[0])
	}
}

func TestElapsed(t *testing.T) {
	for in, want := range map[string]int{"05:03": 303, "1:02:03": 3723, "2-00:00:01": 172801} {
		if d, ok := elapsed(in); !ok || int(d.Seconds()) != want {
			t.Errorf("%s: %v", in, d)
		}
	}
}

func TestCommandPorts(t *testing.T) {
	for cmd, want := range map[string]string{"python3 -m http.server 8765": "8765", "npm run dev -- --port 5174": "5174", "PORT=3001 node app.js": "3001", "vite -p 4000": "4000", "curl localhost:7272/x": "7272"} {
		if m := cmdPortRe.FindStringSubmatch(cmd); m == nil || m[1] != want {
			t.Errorf("%q: %v", cmd, m)
		}
	}
}

func TestTrimURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://www.who.int/detail/ambient-(outdoor)-air-quality": "https://www.who.int/detail/ambient-(outdoor)-air-quality",
		"https://x.org/a).": "https://x.org/a",
		"https://x.org/a/,": "https://x.org/a/",
	} {
		if got := trimURL(in); got != want {
			t.Errorf("%s: %s", in, got)
		}
	}
}
