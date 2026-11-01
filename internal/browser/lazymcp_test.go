package browser

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if marker := os.Getenv("FAKE_MCP_MARKER"); marker != "" {
		fakeServer(marker)
		return
	}
	os.Exit(m.Run())
}

func fakeServer(marker string) {
	f, _ := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	f.WriteString("started\n")
	f.Close()
	r := bufio.NewReader(os.Stdin)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var m rpc
		json.Unmarshal(line, &m)
		var result string
		switch m.Method {
		case "initialize":
			result = `{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake"}}`
		case "tools/list":
			result = `{"tools":[{"name":"browser_click"}]}`
		case "tools/call":
			result = `{"content":[{"type":"text","text":"clicked"}]}`
		default:
			continue
		}
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": json.RawMessage(result)})
		os.Stdout.Write(append(b, '\n'))
	}
}

type session struct {
	t    *testing.T
	in   *io.PipeWriter
	out  *bufio.Reader
	done chan error
}

func run(t *testing.T, cache, marker string) *session {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	exe, _ := os.Executable()
	s := &session{t: t, in: inW, out: bufio.NewReader(outR), done: make(chan error, 1)}
	go func() {
		s.done <- LazyMCP([]string{exe}, append(os.Environ(), "FAKE_MCP_MARKER="+marker), []string{"fake"}, cache, inR, outW)
		outW.Close()
	}()
	return s
}

func (s *session) send(line string) { s.in.Write([]byte(line + "\n")) }

func (s *session) read() map[string]any {
	s.t.Helper()
	line, err := s.out.ReadBytes('\n')
	if err != nil {
		s.t.Fatalf("read: %v", err)
	}
	var m map[string]any
	json.Unmarshal(line, &m)
	return m
}

func starts(marker string) int {
	b, _ := os.ReadFile(marker)
	return strings.Count(string(b), "started")
}

func TestLazyMCPStartsOnFirstToolCall(t *testing.T) {
	dir := t.TempDir()
	cache, marker := filepath.Join(dir, "cache.json"), filepath.Join(dir, "marker")

	s := run(t, cache, marker)
	s.send(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	if r := s.read(); r["id"] != float64(0) || starts(marker) != 1 {
		t.Fatalf("without a cache the server starts at once: %v, %d starts", r, starts(marker))
	}
	s.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	s.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if r := s.read(); r["id"] != float64(1) {
		t.Fatalf("tools/list: %v", r)
	}
	s.in.Close()
	<-s.done

	s = run(t, cache, marker)
	s.send(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`)
	r := s.read()
	if v := r["result"].(map[string]any)["protocolVersion"]; v != "2025-11-25" {
		t.Fatalf("initialize from the cache answers in the client's version: %v", r)
	}
	s.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	s.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	r = s.read()
	if tools := r["result"].(map[string]any)["tools"].([]any); len(tools) != 1 {
		t.Fatalf("tools/list from the cache: %v", r)
	}
	time.Sleep(100 * time.Millisecond)
	if n := starts(marker); n != 1 {
		t.Fatalf("handshake and tool list must not start the server: %d starts", n)
	}
	s.send(`{"jsonrpc":"2.0","id":"call-7","method":"tools/call","params":{"name":"browser_click"}}`)
	r = s.read()
	if r["id"] != "call-7" || starts(marker) != 2 {
		t.Fatalf("the first tool call starts it and gets its answer: %v, %d starts", r, starts(marker))
	}
	s.in.Close()
	if err := <-s.done; err != nil {
		t.Fatal(err)
	}
}
