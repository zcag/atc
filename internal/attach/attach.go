package attach

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"regexp"
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
	Holder  string `json:"holder,omitempty"`
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
	hidden     bool
	rejoin     bool
	name       string
	typed      time.Time
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

	q := r.URL.Query()
	v := &viewer{conn: conn, szSig: make(chan struct{}, 1), cols: size(q.Get("cols"), 120), rows: size(q.Get("rows"), 40), hidden: q.Get("hidden") != "", rejoin: q.Get("reconnect") != "", name: q.Get("device")}
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
			if !terminalReport.Match(b) {
				h.mu.Lock()
				v.typed = time.Now()
				h.mu.Unlock()
				h.claim(id, v)
			}
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
		case "hidden", "visible":
			h.show(id, v, c.Type == "visible")
		}
	}
}

func (h *Hub) Viewing(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if g := h.groups[id]; id != "" && g != nil {
		for v := range g.viewers {
			if !v.hidden {
				return true
			}
		}
	}
	return false
}

func (h *Hub) show(id string, v *viewer, visible bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	g := h.groups[id]
	if g == nil {
		return
	}
	v.hidden = !visible
	switch {
	case visible && g.owner != v:
		g.owner = v
	case !visible && g.owner == v:
		for o := range g.viewers {
			if !o.hidden {
				g.owner = o
				break
			}
		}
	default:
		return
	}
	g.apply()
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
	if g.owner == nil || !v.hidden && !v.rejoin && time.Since(g.owner.typed) > recentInput {
		g.owner = v
	}
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
		g.owner = nil
		for o := range g.viewers {
			if g.owner == nil || !o.hidden {
				g.owner = o
			}
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

const recentInput = 2 * time.Minute

var terminalReport = regexp.MustCompile(`^(\x1b\[[IO]|\x1b\[[?>]?[0-9;]*[cnR]|\x1b\][^\x07\x1b]*(\x07|\x1b\\))+$`)

func (g *group) apply() {
	o := g.owner
	for v := range g.viewers {
		pty.Setsize(v.pty, &pty.Winsize{Cols: o.cols, Rows: o.rows})
		v.queueSize(Control{Type: "size", Cols: o.cols, Rows: o.rows, Owner: v == o, Viewers: len(g.viewers), Holder: o.name})
	}
}

func (h *Hub) Send(ctx context.Context, id, text string) error {
	h.mu.Lock()
	var cols, rows uint16 = 120, 40
	var live *os.File
	if g := h.groups[id]; g != nil {
		live, cols, rows = g.owner.pty, g.owner.cols, g.owner.rows
	}
	h.mu.Unlock()
	paste := []byte("\x1b[200~" + text + "\x1b[201~")
	if live != nil {
		live.Write(paste)
		time.Sleep(300 * time.Millisecond)
		_, err := live.Write([]byte("\r"))
		return err
	}

	cmd := exec.CommandContext(ctx, h.Bin, "attach", id)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return err
	}
	defer func() {
		cmd.Process.Signal(syscall.SIGHUP)
		f.Close()
		cmd.Wait()
	}()
	out, gone := make(chan struct{}, 1), make(chan struct{})
	go func() {
		defer close(gone)
		buf := make([]byte, 32<<10)
		for {
			if _, err := f.Read(buf); err != nil {
				return
			}
			select {
			case out <- struct{}{}:
			default:
			}
		}
	}()
	settle := func(quiet, limit time.Duration) error {
		end := time.After(limit)
		for {
			select {
			case <-out:
			case <-time.After(quiet):
				return nil
			case <-end:
				return nil
			case <-gone:
				return errors.New("the session ended")
			}
		}
	}
	if err := settle(700*time.Millisecond, 8*time.Second); err != nil {
		return err
	}
	f.Write(paste)
	time.Sleep(300 * time.Millisecond)
	f.Write([]byte("\r"))
	settle(500*time.Millisecond, 3*time.Second)
	return nil
}
