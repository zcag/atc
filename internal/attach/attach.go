package attach

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
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
	Viewer  int    `json:"viewer,omitempty"`
	Code    int    `json:"code,omitempty"`
}

type Hub struct {
	Bin    string
	mu     sync.Mutex
	groups map[string]*group
	seq    int
}

type group struct {
	viewers    map[*viewer]bool
	owner      *viewer
	cols, rows uint16
}

type viewer struct {
	n          int
	sid        string
	since      time.Time
	resized    atomic.Int64
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

func (v *viewer) String() string {
	if v == nil {
		return "nobody"
	}
	name := v.name
	if name == "" {
		name = "?"
	}
	return fmt.Sprintf("#%d (%s)", v.n, name)
}

func (v *viewer) logf(format string, a ...any) {
	sid := v.sid
	if len(sid) > 8 {
		sid = sid[:8]
	}
	log.Printf("term %s %v: %s", sid, v, fmt.Sprintf(format, a...))
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
	v := &viewer{sid: id, since: time.Now(), conn: conn, szSig: make(chan struct{}, 1), cols: size(q.Get("cols"), 120), rows: size(q.Get("rows"), 40), hidden: q.Get("hidden") != "", rejoin: q.Get("reconnect") != "", name: q.Get("device")}
	h.mu.Lock()
	h.seq++
	v.n = h.seq
	h.mu.Unlock()
	cmd := exec.Command(h.Bin, "attach", id)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	v.pty, err = pty.StartWithSize(cmd, &pty.Winsize{Cols: v.cols, Rows: v.rows})
	if err != nil {
		v.logf("attach failed: %v", err)
		conn.Close(websocket.StatusInternalError, "attach failed: "+err.Error())
		return
	}
	v.logf("connected %dx%d hidden=%v reconnect=%v", v.cols, v.rows, v.hidden, v.rejoin)
	h.join(id, v)
	var sent atomic.Int64
	why := "closed by the browser"
	defer func() {
		cancel()
		cmd.Process.Signal(syscall.SIGHUP)
		v.pty.Close()
		h.leave(id, v)
		v.logf("gone after %s, %s, %dKB sent", time.Since(v.since).Round(time.Second), why, sent.Load()>>10)
	}()

	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := v.pty.Read(buf)
			if at := v.resized.Swap(0); at != 0 && n > 0 {
				v.logf("redrawn %s after the resize", time.Since(time.Unix(0, at)).Round(time.Millisecond))
			}
			sent.Add(int64(n))
			if n > 0 && v.send(ctx, websocket.MessageBinary, buf[:n]) != nil {
				why = "write to the browser failed"
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
		if ctx.Err() == nil {
			v.logf("claude attach exited (%d)", code)
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
		var missed time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pc := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pctx)
				pc()
				switch {
				case err != nil && ctx.Err() == nil && missed.IsZero():
					missed = time.Now()
					v.logf("no pong: %v", err)
				case err == nil && !missed.IsZero():
					v.logf("pong again after %s silent", time.Since(missed).Round(time.Second))
					missed = time.Time{}
				}
			}
		}
	}()

	for {
		typ, b, err := conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == -1 && ctx.Err() == nil {
				why = err.Error()
			}
			return
		}
		if typ == websocket.MessageBinary {
			if !terminalReport.Match(b) {
				h.mu.Lock()
				v.typed = time.Now()
				h.mu.Unlock()
				h.claim(id, v, typedWhy(b))
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
			h.claim(id, v, "asked for it")
		case "hidden", "visible":
			v.logf("%s", c.Type)
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
		g.take(v, "became visible")
	case !visible && g.owner == v:
		for o := range g.viewers {
			if !o.hidden {
				g.take(o, v.String()+" was hidden")
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
	switch {
	case g.owner == nil:
		g.take(v, "first viewer")
	case !v.hidden && !v.rejoin && time.Since(g.owner.typed) > recentInput:
		g.take(v, "joined visible")
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
		var next *viewer
		for o := range g.viewers {
			if next == nil || !o.hidden {
				next = o
			}
		}
		g.take(next, v.String()+" left")
	}
	g.apply()
}

func (h *Hub) claim(id string, v *viewer, why string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if g := h.groups[id]; g != nil && g.owner != v {
		g.take(v, why)
		g.apply()
	}
}

func typedWhy(b []byte) string {
	if len(b) > 0 && b[0] == 0x1b {
		return fmt.Sprintf("typed %q", b[:min(len(b), 24)])
	}
	return fmt.Sprintf("typed %dB", len(b))
}

func (h *Hub) resize(id string, v *viewer, cols, rows uint16) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if v.cols != cols || v.rows != rows {
		v.logf("resize %dx%d", cols, rows)
	}
	v.cols, v.rows = cols, rows
	if g := h.groups[id]; g != nil && g.owner == v {
		g.apply()
	}
}

const recentInput = 2 * time.Minute

var terminalReport = regexp.MustCompile(`^(\x1b\[[IO]|\x1b\[[?>]?[0-9;]*[cnR]|\x1b\][^\x07\x1b]*(\x07|\x1b\\))+$`)

func (g *group) take(v *viewer, why string) {
	if g.owner != v {
		v.logf("takes the size: %s (was %v)", why, g.owner)
		g.owner = v
	}
}

func (g *group) apply() {
	o := g.owner
	if g.cols != o.cols || g.rows != o.rows {
		o.logf("session size %dx%d (was %dx%d), %d viewers", o.cols, o.rows, g.cols, g.rows, len(g.viewers))
		g.cols, g.rows = o.cols, o.rows
		o.resized.Store(time.Now().UnixNano())
	}
	for v := range g.viewers {
		pty.Setsize(v.pty, &pty.Winsize{Cols: o.cols, Rows: o.rows})
		v.queueSize(Control{Type: "size", Cols: o.cols, Rows: o.rows, Owner: v == o, Viewers: len(g.viewers), Holder: o.name, Viewer: v.n})
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
