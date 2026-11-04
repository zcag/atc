package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// callLine is the phone app's end of a call: its socket passed through to the call line's app line,
// which only answers on loopback, so atc's login is what guards it. The Android app's calls from
// CallTestFrom (where a test emulator runs) go to CallTestLine instead, a call line of
// their own, so a test never touches the real line; a browser at such an address
// still gets the real line.
func (s *Server) callLine(w http.ResponseWriter, r *http.Request) {
	line := s.CallLine
	if s.CallTestLine != "" && slices.Contains(s.CallTestFrom, s.clientIP(r).String()) && strings.HasPrefix(r.UserAgent(), "okhttp") {
		line = s.CallTestLine
	}
	if line == "" {
		http.Error(w, "atc on "+s.Host+" has no call line (ATC_CALL_LINE)", http.StatusNotFound)
		return
	}
	up, _, err := websocket.Dial(r.Context(), strings.Replace(line, "http", "ws", 1)+"/app", nil)
	if err != nil {
		http.Error(w, "call line: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer up.CloseNow()
	down, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer down.CloseNow()
	log.Printf("call: app line open (%s, %s)", s.clientIP(r), line)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		defer cancel()
		relay(ctx, down, up, s.relayTrace())
	}()
	err = relay(ctx, up, down, nil)
	log.Printf("call: app line closed (%v)", err)
}

// relayTrace keeps, for each of the assistant's audio frames passed to the phone, how long after the previous one it came
// from the call line and how long writing it toward the phone took, in StateDir/call-relay/<opened>.jsonl, flushed every
// 10 s like the app's own arrival trace: a gap there and none here puts a burst between atc and the phone.
type relayTrace struct {
	path         string
	at, last     time.Time
	gaps, writes []int
}

func (s *Server) relayTrace() *relayTrace {
	if s.StateDir == "" {
		return nil
	}
	dir := filepath.Join(s.StateDir, "call-relay")
	os.MkdirAll(dir, 0o700)
	return &relayTrace{path: filepath.Join(dir, time.Now().Format("20060102-150405")+".jsonl")}
}

func (t *relayTrace) frame(read time.Time, wrote time.Duration) {
	if t == nil {
		return
	}
	if t.at.IsZero() {
		t.at = read
	}
	gap := 0
	if !t.last.IsZero() {
		gap = int(read.UnixMilli() - t.last.UnixMilli())
	}
	t.last = read
	t.gaps = append(t.gaps, gap)
	t.writes = append(t.writes, int(wrote.Milliseconds()))
	if read.Sub(t.at) >= 10*time.Second {
		t.flush()
	}
}

func (t *relayTrace) flush() {
	if t == nil || len(t.gaps) == 0 {
		return
	}
	b, _ := json.Marshal(map[string]any{"at": t.at.UnixMilli(), "gaps": t.gaps, "writes": t.writes})
	if f, err := os.OpenFile(t.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		f.Write(append(b, '\n'))
		f.Close()
	}
	t.at, t.gaps, t.writes = time.Time{}, nil, nil
}

// callDiag keeps what the phone app reports after a call about how Android handled it (its version, the
// calling account, permissions, its rows in the call log), in the journal and in call-diag.jsonl.
func (s *Server) callDiag(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	if err != nil || !json.Valid(b) {
		http.Error(w, "a JSON report is required", http.StatusBadRequest)
		return
	}
	var line bytes.Buffer
	json.Compact(&line, b)
	log.Printf("call: diag from %s: %s", s.clientIP(r), line.String())
	if s.StateDir != "" {
		if f, err := os.OpenFile(filepath.Join(s.StateDir, "call-diag.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			fmt.Fprintf(f, "{\"at\":%q,\"report\":%s}\n", time.Now().Format(time.RFC3339), line.String())
			f.Close()
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func relay(ctx context.Context, dst, src *websocket.Conn, trace *relayTrace) error {
	defer trace.flush()
	for {
		typ, b, err := src.Read(ctx)
		if err != nil {
			return err
		}
		read := time.Now()
		if err := dst.Write(ctx, typ, b); err != nil {
			return err
		}
		if typ == websocket.MessageBinary {
			trace.frame(read, time.Since(read))
		}
	}
}
