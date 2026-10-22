package attach

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
)

type Control struct {
	Type    string `json:"type"`
	Cols    uint16 `json:"cols,omitempty"`
	Rows    uint16 `json:"rows,omitempty"`
	Owner   bool   `json:"owner,omitempty"`
	Viewers int    `json:"viewers,omitempty"`
	Code    int    `json:"code,omitempty"`
}

type Hub struct {
	Bin    string
	mu     sync.Mutex
	groups map[string]*group
}

type group struct {
	viewers map[*viewer]bool
	owner   *viewer
}

type viewer struct {
	conn       *websocket.Conn
	pty        *os.File
	cols, rows uint16
	wmu        sync.Mutex
	smu        sync.Mutex
	sz         Control
	szSig      chan struct{}
}

func (v *viewer) queueSize(c Control) {
	v.smu.Lock()
	v.sz = c
	v.smu.Unlock()
	select {
	case v.szSig <- struct{}{}:
	default:
	}
}

func (v *viewer) send(ctx context.Context, typ websocket.MessageType, b []byte) error {
	v.wmu.Lock()
	defer v.wmu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return v.conn.Write(ctx, typ, b)
}

func (v *viewer) control(ctx context.Context, c Control) {
	b, _ := json.Marshal(c)
	v.send(ctx, websocket.MessageText, b)
}

func size(q string, def uint16) uint16 {
	n, err := strconv.Atoi(q)
	if err != nil || n < 10 || n > 1000 {
		return def
	}
	return uint16(n)
}

func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, id string) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	v := &viewer{conn: conn, szSig: make(chan struct{}, 1), cols: size(r.URL.Query().Get("cols"), 120), rows: size(r.URL.Query().Get("rows"), 40)}
	cmd := exec.Command(h.Bin, "attach", id)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	v.pty, err = pty.StartWithSize(cmd, &pty.Winsize{Cols: v.cols, Rows: v.rows})
	if err != nil {
		conn.Close(websocket.StatusInternalError, "attach failed: "+err.Error())
		return
	}
	h.join(id, v)
	defer func() {
		cmd.Process.Signal(syscall.SIGHUP)
		v.pty.Close()
		h.leave(id, v)
	}()

	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := v.pty.Read(buf)
			if n > 0 && v.send(ctx, websocket.MessageBinary, buf[:n]) != nil {
				break
			}
			if err != nil {
				break
			}
		}
		code := 0
		var ee *exec.ExitError
		if err := cmd.Wait(); errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		v.control(ctx, Control{Type: "exit", Code: code})
		conn.Close(websocket.StatusNormalClosure, "attach exited")
		cancel()
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-v.szSig:
				v.smu.Lock()
				c := v.sz
				v.smu.Unlock()
				v.control(ctx, c)
			}
		}
	}()
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pc := context.WithTimeout(ctx, 10*time.Second)
				conn.Ping(pctx)
				pc()
			}
		}
	}()

	for {
		typ, b, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			h.claim(id, v)
			v.pty.Write(b)
			continue
		}
		var c Control
		if json.Unmarshal(b, &c) != nil {
			continue
		}
		switch c.Type {
		case "resize":
			h.resize(id, v, size(strconv.Itoa(int(c.Cols)), v.cols), size(strconv.Itoa(int(c.Rows)), v.rows))
		case "claim":
			h.claim(id, v)
		}
	}
}

func (h *Hub) join(id string, v *viewer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.groups == nil {
		h.groups = map[string]*group{}
	}
	g := h.groups[id]
	if g == nil {
		g = &group{viewers: map[*viewer]bool{}}
		h.groups[id] = g
	}
	g.viewers[v] = true
	g.owner = v
	g.apply()
}

func (h *Hub) leave(id string, v *viewer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	g := h.groups[id]
	if g == nil {
		return
	}
	delete(g.viewers, v)
	if len(g.viewers) == 0 {
		delete(h.groups, id)
		return
	}
	if g.owner == v {
		for o := range g.viewers {
			g.owner = o
			break
		}
	}
	g.apply()
}

func (h *Hub) claim(id string, v *viewer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if g := h.groups[id]; g != nil && g.owner != v {
		g.owner = v
		g.apply()
	}
}

func (h *Hub) resize(id string, v *viewer, cols, rows uint16) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v.cols, v.rows = cols, rows
	if g := h.groups[id]; g != nil && g.owner == v {
		g.apply()
	}
}

func (g *group) apply() {
	o := g.owner
	for v := range g.viewers {
		pty.Setsize(v.pty, &pty.Winsize{Cols: o.cols, Rows: o.rows})
		v.queueSize(Control{Type: "size", Cols: o.cols, Rows: o.rows, Owner: v == o, Viewers: len(g.viewers)})
	}
}
