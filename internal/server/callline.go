package server

import (
	"context"
	"log"
	"net/http"
	"strings"

	"github.com/coder/websocket"
)

// callLine is the phone app's end of a call: its socket passed through to delta-call's app line,
// which only answers on loopback, so atc's login is what guards it.
func (s *Server) callLine(w http.ResponseWriter, r *http.Request) {
	if s.CallLine == "" {
		http.Error(w, "atc on "+s.Host+" has no call line (ATC_DELTA_CALL)", http.StatusNotFound)
		return
	}
	up, _, err := websocket.Dial(r.Context(), strings.Replace(s.CallLine, "http", "ws", 1)+"/app", nil)
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
	log.Printf("call: app line open (%s)", s.clientIP(r))
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		defer cancel()
		relay(ctx, down, up)
	}()
	err = relay(ctx, up, down)
	log.Printf("call: app line closed (%v)", err)
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
