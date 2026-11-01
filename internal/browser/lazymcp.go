package browser

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
)

// LazyMCP fronts the MCP server argv on stdio and starts it on the first request it can't answer
// itself: initialize and tools/list come from what the server said last time (cache, under key).
func LazyMCP(argv, env, key []string, cache string, in io.Reader, out io.Writer) error {
	l := &lazy{argv: argv, env: env, key: key, cache: cache, out: out, replies: map[string]chan json.RawMessage{}}
	l.saved = l.load()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		s := <-sig
		l.mu.Lock()
		if l.child != nil {
			syscall.Kill(-l.child.Process.Pid, syscall.SIGTERM)
		}
		l.mu.Unlock()
		os.Exit(128 + int(s.(syscall.Signal)))
	}()
	r := bufio.NewReader(in)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			if err := l.handle(line); err != nil {
				return err
			}
		}
		if err != nil {
			if l.child != nil {
				l.stdin.Close()
				return l.child.Wait()
			}
			return nil
		}
	}
}

type lazy struct {
	argv, env, key []string
	cache          string
	saved          *saved
	initReq        json.RawMessage

	outMu sync.Mutex
	out   io.Writer

	child   *exec.Cmd
	stdin   io.WriteCloser
	mu      sync.Mutex
	replies map[string]chan json.RawMessage
}

type saved struct {
	Key   []string        `json:"key"`
	Init  json.RawMessage `json:"init"`
	Tools json.RawMessage `json:"tools"`
}

type rpc struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

func (l *lazy) handle(line []byte) error {
	if l.child != nil {
		_, err := l.stdin.Write(line)
		return err
	}
	var m rpc
	if json.Unmarshal(line, &m) != nil {
		return l.start(line)
	}
	switch {
	case m.Method == "initialize" && l.saved != nil:
		l.initReq = m.Params
		return l.reply(m.ID, withVersion(l.saved.Init, m.Params))
	case m.Method == "initialize":
		l.initReq = m.Params
		if err := l.start(nil); err != nil {
			return err
		}
		return l.reply(m.ID, l.saved.Init)
	case m.ID == nil && m.Method != "":
		return nil
	case m.Method == "tools/list" && l.saved != nil:
		return l.reply(m.ID, l.saved.Tools)
	case m.Method == "ping":
		return l.reply(m.ID, json.RawMessage("{}"))
	}
	return l.start(line)
}

// start runs the server, introduces atc's client to it as the client introduced itself, then
// hands it pending, the request that needed it.
func (l *lazy) start(pending []byte) error {
	cmd := exec.Command(l.argv[0], l.argv[1:]...)
	cmd.Env, cmd.Stderr = l.env, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	l.mu.Lock()
	err = cmd.Start()
	if err == nil {
		l.child, l.stdin = cmd, stdin
	}
	l.mu.Unlock()
	if err != nil {
		return err
	}
	go l.relay(stdout)
	init, err := l.call("atc-init", "initialize", l.initReq)
	if err != nil {
		return err
	}
	if err := l.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		return err
	}
	tools, err := l.call("atc-tools", "tools/list", nil)
	if err != nil {
		return err
	}
	if l.saved != nil && !bytes.Equal(compact(tools), compact(l.saved.Tools)) {
		l.write(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
	}
	l.saved = &saved{Key: l.key, Init: init, Tools: tools}
	l.store()
	if pending == nil {
		return nil
	}
	_, err = stdin.Write(pending)
	return err
}

func (l *lazy) call(id, method string, params json.RawMessage) (json.RawMessage, error) {
	ch := make(chan json.RawMessage, 1)
	l.mu.Lock()
	l.replies[`"`+id+`"`] = ch
	l.mu.Unlock()
	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	if err := l.send(req); err != nil {
		return nil, err
	}
	r, ok := <-ch
	if !ok {
		return nil, fmt.Errorf("%s exited before answering %s", l.argv[0], method)
	}
	return r, nil
}

func (l *lazy) relay(stdout io.Reader) {
	r := bufio.NewReader(stdout)
	for {
		line, err := r.ReadBytes('\n')
		var m rpc
		if len(line) > 0 && json.Unmarshal(line, &m) == nil && m.Method == "" {
			l.mu.Lock()
			ch, ours := l.replies[string(m.ID)]
			delete(l.replies, string(m.ID))
			l.mu.Unlock()
			if ours {
				ch <- m.Result
				continue
			}
		}
		if len(line) > 0 {
			l.outMu.Lock()
			l.out.Write(line)
			l.outMu.Unlock()
		}
		if err != nil {
			l.mu.Lock()
			for id, ch := range l.replies {
				close(ch)
				delete(l.replies, id)
			}
			l.mu.Unlock()
			return
		}
	}
}

func (l *lazy) send(v any) error {
	b, _ := json.Marshal(v)
	_, err := l.stdin.Write(append(b, '\n'))
	return err
}

func (l *lazy) reply(id, result json.RawMessage) error {
	return l.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (l *lazy) write(v any) error {
	b, _ := json.Marshal(v)
	l.outMu.Lock()
	defer l.outMu.Unlock()
	_, err := l.out.Write(append(b, '\n'))
	return err
}

func (l *lazy) load() *saved {
	b, err := os.ReadFile(l.cache)
	var s saved
	if err != nil || json.Unmarshal(b, &s) != nil || !slices.Equal(s.Key, l.key) || s.Init == nil || s.Tools == nil {
		return nil
	}
	return &s
}

func (l *lazy) store() {
	b, _ := json.Marshal(l.saved)
	os.MkdirAll(filepath.Dir(l.cache), 0o700)
	tmp := fmt.Sprintf("%s.%d", l.cache, os.Getpid())
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, l.cache)
	}
}

func withVersion(init, params json.RawMessage) json.RawMessage {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	var r map[string]json.RawMessage
	if json.Unmarshal(params, &p) != nil || p.ProtocolVersion == "" || json.Unmarshal(init, &r) != nil {
		return init
	}
	r["protocolVersion"], _ = json.Marshal(p.ProtocolVersion)
	b, _ := json.Marshal(r)
	return b
}

func compact(b json.RawMessage) []byte {
	var buf bytes.Buffer
	json.Compact(&buf, b)
	return buf.Bytes()
}
