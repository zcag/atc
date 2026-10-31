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

// callLine is the phone app's end of a call: its socket passed through to delta-call's app line,
// which only answers on loopback, so atc's login is what guards it. Calls from CallTestFrom (a test
// device, such as an emulator) go to CallTestLine instead, a delta-call of their own, so a test
// never touches the line they call on.
func (s *Server) callLine(w http.ResponseWriter, r *http.Request) {
	line := s.CallLine
	if s.CallTestLine != "" && slices.Contains(s.CallTestFrom, s.clientIP(r).String()) {
		line = s.CallTestLine
	}
	if line == "" {
		http.Error(w, "atc on "+s.Host+" has no call line (ATC_DELTA_CALL)", http.StatusNotFound)
		return
	}
	up, _, err := websocket.Dial(r.Context(), strings.Replace(line, "http", "ws", 1)+"/app", nil)
	if err != nil {
		http.Error(w, "delta-call: "+err.Error(), http.StatusBadGateway)
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
		relay(ctx, down, up)
	}()
	err = relay(ctx, up, down)
	log.Printf("call: app line closed (%v)", err)
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

func relay(ctx context.Context, dst, src *websocket.Conn) error {
	for {
		typ, b, err := src.Read(ctx)
		if err != nil {
			return err
		}
		if err := dst.Write(ctx, typ, b); err != nil {
			return err
		}
	}
}
