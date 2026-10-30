// Package hub keeps one Claude Code session in a stream-json process that several channels
// (the phone, atc, WhatsApp, other sessions) talk into, and routes its replies back.
//
// ws /ws?channel=<name>
//
//	in:  {"type":"message","text":...}  {"type":"note","text":...}  {"type":"interrupt"}
//	out: text{delta} tool{name} block{text} read joined held done{interrupted,subtype} error{error} notice{text}
//
// ws /events gets every event of every channel, each with its channel.
package hub

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/startover"
)

const (
	Phone = "phone"
	Agent = "agent"
	reset = "reset"
)

type Config struct {
	Bin   string
	Args  []string
	Dir   string
	State string
	// Mode is the text that tells the session how to talk on a channel, "" for none.
	Mode func(channel string) string

	Reset startover.Policy

	Call CallConfig
	Now  func() time.Time
}

type Event struct {
	Type        string `json:"type"`
	Channel     string `json:"channel,omitempty"`
	Delta       string `json:"delta,omitempty"`
	Name        string `json:"name,omitempty"`
	Text        string `json:"text,omitempty"`
	Error       string `json:"error,omitempty"`
	Interrupted bool   `json:"interrupted,omitempty"`
	Subtype     string `json:"subtype,omitempty"`
}

type Status struct {
	Session  string         `json:"session"`
	PID      int            `json:"pid"`
	Alive    bool           `json:"alive"`
	Context  int            `json:"context"`
	IdleS    int            `json:"idle_s"`
	Owners   []string       `json:"owners"`
	Route    string         `json:"route,omitempty"`
	Pending  []string       `json:"pending"`
	Held     []string       `json:"held"`
	Home     string         `json:"home,omitempty"`
	Call     string         `json:"call,omitempty"`
	Channels map[string]int `json:"channels"`

	Reset     startover.Policy `json:"reset"`
	Dir       string           `json:"dir"`
	LastReset time.Time        `json:"lastReset,omitzero"`
}

type msg struct{ channel, text string }

type turn struct {
	channels    []string
	route       string
	block       string
	inText      bool
	text        strings.Builder
	wrote       map[string]bool
	interrupted bool
	tools       int
	cutAfter    bool
}

type sub struct {
	channel string
	all     bool
	ch      chan Event
}

var ErrRestarting = errors.New("claude is restarting, try again")

type Hub struct {
	cfg Config

	mu       sync.Mutex
	cmd      *exec.Cmd
	in       io.WriteCloser
	alive    bool
	sid      string
	pending  []msg
	held     []msg
	turn     *turn
	cutEarly bool
	last     string
	home     string
	context  int
	lastTurn time.Time
	handover *strings.Builder
	seed     string
	call     *call
	subs     map[*sub]bool
	fails    int
	stopped  bool
}

func New(cfg Config) *Hub {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Mode == nil {
		cfg.Mode = func(string) string { return "" }
	}
	h := &Hub{cfg: cfg, subs: map[*sub]bool{}, lastTurn: cfg.Now()}
	if b, err := os.ReadFile(h.sidPath()); err == nil {
		h.sid = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile(h.homePath()); err == nil {
		h.home = strings.TrimSpace(string(b))
	}
	return h
}

func (h *Hub) sidPath() string  { return filepath.Join(h.cfg.State, "session") }
func (h *Hub) homePath() string { return filepath.Join(h.cfg.State, "home") }

func (h *Hub) Start() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.start()
}

func (h *Hub) start() error {
	args := append([]string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--replay-user-messages"}, h.cfg.Args...)
	switch {
	case h.sid == "":
		h.saveSID(newID())
		args = append(args, "--session-id", h.sid)
	case written(h.sid):
		args = append(args, "--resume", h.sid)
	default:
		args = append(args, "--session-id", h.sid)
	}
	cmd := exec.Command(h.cfg.Bin, args...)
	cmd.Dir, cmd.Stderr = h.cfg.Dir, os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	h.cmd, h.in, h.alive = cmd, in, true
	log.Printf("hub: claude %d on %s", cmd.Process.Pid, h.sid)
	go h.read(cmd, out)
	if h.seed != "" {
		h.say(reset, h.seed)
		h.seed = ""
	}
	h.release()
	return nil
}

func (h *Hub) saveSID(sid string) {
	h.sid = sid
	os.MkdirAll(h.cfg.State, 0o755)
	if sid == "" {
		os.Remove(h.sidPath())
		return
	}
	os.WriteFile(h.sidPath(), []byte(sid+"\n"), 0o644)
}

// written is whether the session has a transcript yet: one that never had a turn can't be resumed.
func written(sid string) bool {
	m, _ := filepath.Glob(filepath.Join(claude.ConfigDir(), "projects", "*", sid+".jsonl"))
	return len(m) > 0
}

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// Left is a channel's connection going away. A phone connection lives exactly as long as a call, so the next
// call's first message must carry the phone mode again even though the last message was also the phone's
// (the previous call's "görüşme bitti").
func (h *Hub) Left(channel string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if channel == Phone && h.last == Phone {
		h.last = ""
	}
}

// Say hands text from a channel to the session: "sent", or "held" until the running turn ends.
func (h *Hub) Say(channel, text string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.say(channel, text)
}

func (h *Hub) say(ch, text string) (string, error) {
	if !h.alive {
		return "", ErrRestarting
	}
	if h.holds(ch) {
		h.held = append(h.held, msg{ch, text})
		h.emit(Event{Type: "held", Channel: ch})
		log.Printf("hub: held %s behind %v", ch, h.busy())
		return "held", nil
	}
	if c := h.call; ch == Phone && c != nil && !c.told {
		text = c.envelope(h.cfg.Now()) + "\n" + text
		c.told = true
		if c.answered {
			h.call = nil
		}
	}
	if ch != Agent && ch != reset {
		if ch != h.last {
			if mode := h.cfg.Mode(ch); mode != "" {
				text = fmt.Sprintf("[talk-mode: %s, until the next talk-mode line]\n%s\n[message]\n%s", ch, mode, text)
			}
		}
		h.last = ch
		if ch != Phone && ch != h.home {
			h.home = ch
			os.WriteFile(h.homePath(), []byte(ch+"\n"), 0o644)
		}
	}
	h.pending = append(h.pending, msg{ch, text})
	return "sent", h.write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
}

// holds is the routing rule for a message that arrives while the session is busy: it joins the
// running turn, except that text waits while the phone is part of it, so a call never reads out
// an answer meant for a screen, and everything waits for a handover to finish.
func (h *Hub) holds(ch string) bool {
	if ch == reset {
		return false
	}
	if h.handover != nil {
		return true
	}
	if ch == Phone {
		return false
	}
	return slices.Contains(h.busy(), Phone)
}

func (h *Hub) busy() []string {
	var out []string
	if h.turn != nil {
		out = append(out, h.turn.channels...)
	}
	for _, m := range h.pending {
		out = append(out, m.channel)
	}
	return out
}

func (h *Hub) release() {
	held := h.held
	h.held = nil
	for _, m := range held {
		if h.holds(m.channel) || !h.alive {
			h.held = append(h.held, m)
			continue
		}
		h.say(m.channel, m.text)
	}
}

func (h *Hub) write(v any) error {
	b, _ := json.Marshal(v)
	_, err := h.in.Write(append(b, '\n'))
	return err
}

// Interrupt stops the running turn. A channel that is not forcing it (the phone's barge-in)
// only cuts what is being said to it, and lets a running tool finish first so its result is kept.
// Claude Code replays a message only about two seconds after taking it, when its answer starts;
// a cut in that time (their turn reopened right after it was sent) stops the turn before it began.
func (h *Hub) Interrupt(ch string, force bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.turn
	if t == nil && len(h.pending) > 0 && h.pending[0].channel == ch {
		h.cut()
		h.cutEarly = true
		log.Printf("hub: cut %s before claude replayed it", ch)
		return true
	}
	if t == nil || !force && t.route != ch {
		return false
	}
	if !force && t.tools > 0 {
		t.cutAfter = true
	} else {
		h.cut()
	}
	t.interrupted = true
	for _, c := range t.channels {
		if c != ch {
			h.emit(Event{Type: "notice", Channel: c, Text: "interrupted from " + ch})
		}
	}
	return true
}

func (h *Hub) cut() {
	h.write(map[string]any{"type": "control_request", "request_id": fmt.Sprintf("int%d", time.Now().UnixNano()),
		"request": map[string]string{"subtype": "interrupt"}})
}

type usage struct {
	Input       int `json:"input_tokens"`
	CacheRead   int `json:"cache_read_input_tokens"`
	CacheCreate int `json:"cache_creation_input_tokens"`
}

type line struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	IsReplay  bool   `json:"isReplay"`
	Parent    string `json:"parent_tool_use_id"`
	Message   struct {
		Content json.RawMessage `json:"content"`
		Usage   *usage          `json:"usage"`
	} `json:"message"`
	Event struct {
		Type         string `json:"type"`
		ContentBlock struct {
			Type string `json:"type"`
			Name string `json:"name"`
		} `json:"content_block"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
}

func (h *Hub) read(cmd *exec.Cmd, out io.Reader) {
	r := bufio.NewReaderSize(out, 1<<20)
	for {
		b, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(b)) > 0 {
			var l line
			if json.Unmarshal(b, &l) == nil {
				h.mu.Lock()
				h.event(l)
				h.mu.Unlock()
			}
		}
		if err != nil {
			break
		}
	}
	err := cmd.Wait()
	h.mu.Lock()
	h.alive = false
	if h.stopped {
		h.mu.Unlock()
		return
	}
	log.Printf("hub: claude %d exited: %v", cmd.Process.Pid, err)
	if t := h.turn; t != nil {
		for _, c := range t.channels {
			h.emit(Event{Type: "error", Channel: c, Error: "claude exited mid-turn, the reply is lost"})
		}
	}
	for _, m := range h.pending {
		h.emit(Event{Type: "error", Channel: m.channel, Error: "claude exited before reading your message"})
	}
	h.pending, h.turn = nil, nil
	h.emit(Event{Type: "notice", Text: "claude restarted"})
	quick := h.fails
	if h.handover == nil && h.seed == "" {
		h.fails++
	}
	h.mu.Unlock()
	time.Sleep(time.Duration(min(quick*quick+1, 30)) * time.Second)
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.start(); err != nil {
		log.Printf("hub: start claude: %v", err)
	}
}

func (h *Hub) event(l line) {
	switch {
	case l.Type == "system" && l.Subtype == "init":
		h.fails = 0
		if l.SessionID != "" && l.SessionID != h.sid {
			log.Printf("hub: session %s is now %s", h.sid, l.SessionID)
			h.saveSID(l.SessionID)
		}
		h.emit(Event{Type: "session", Text: h.sid})
	case l.Type == "user" && l.IsReplay && len(l.Message.Content) > 0 && l.Message.Content[0] == '"' && len(h.pending) > 0:
		m := h.pending[0]
		h.pending = h.pending[1:]
		ch := m.channel
		route := ch
		if ch == Agent && h.home != "" {
			route = h.home
		}
		h.emit(Event{Type: "read", Channel: ch})
		if h.turn == nil {
			h.turn = &turn{channels: []string{ch}, wrote: map[string]bool{}, interrupted: h.cutEarly}
			h.cutEarly = false
			h.emit(Event{Type: "turn", Channel: ch})
		} else if !slices.Contains(h.turn.channels, ch) {
			h.turn.channels = append(h.turn.channels, ch)
			h.emit(Event{Type: "joined", Channel: ch})
		}
		if !slices.Contains(h.turn.channels, route) {
			h.turn.channels = append(h.turn.channels, route)
		}
		h.turn.route = route
	case l.Type == "user" && !l.IsReplay && l.Parent == "" && h.turn != nil && h.turn.tools > 0:
		var blocks []struct{ Type string }
		json.Unmarshal(l.Message.Content, &blocks)
		for _, b := range blocks {
			if b.Type == "tool_result" {
				h.turn.tools--
				h.emit(Event{Type: "tool_done", Channel: h.turn.route})
			}
		}
		if h.turn.tools <= 0 && h.turn.cutAfter {
			h.turn.tools, h.turn.cutAfter = 0, false
			h.cut()
		}
	case l.Type == "assistant" && l.Message.Usage != nil:
		u := l.Message.Usage
		h.context = u.Input + u.CacheRead + u.CacheCreate
	case l.Type == "result":
		h.lastTurn = h.cfg.Now()
		t := h.turn
		h.turn = nil
		if t == nil && h.cutEarly && len(h.pending) > 0 {
			m := h.pending[0]
			h.pending, h.cutEarly = h.pending[1:], false
			log.Printf("hub: turn [%s] cut before it began", m.channel)
			h.emit(Event{Type: "done", Channel: m.channel, Interrupted: true, Subtype: l.Subtype})
			if len(h.pending) == 0 {
				h.release()
			}
			return
		}
		if t == nil {
			return
		}
		log.Printf("hub: turn %v ended (%s), context %d", t.channels, l.Subtype, h.context)
		for _, c := range t.channels {
			h.emit(Event{Type: "done", Channel: c, Interrupted: t.interrupted, Subtype: l.Subtype})
		}
		if slices.Contains(t.channels, reset) && h.handover != nil {
			h.freshStart()
			return
		}
		if len(h.pending) == 0 {
			h.release()
		}
	case l.Type == "stream_event" && h.turn != nil:
		h.stream(l)
	}
}

func (h *Hub) stream(l line) {
	t, ev := h.turn, l.Event
	switch ev.Type {
	case "content_block_start":
		switch ev.ContentBlock.Type {
		case "text":
			t.block, t.inText = t.route, true
			t.text.Reset()
			if t.wrote[t.block] {
				h.emit(Event{Type: "text", Channel: t.block, Delta: "\n\n"})
			}
		case "tool_use":
			if l.Parent == "" {
				t.tools++
			}
			h.emit(Event{Type: "tool", Channel: t.route, Name: ev.ContentBlock.Name})
		}
	case "content_block_delta":
		if ev.Delta.Type != "text_delta" || !t.inText {
			return
		}
		t.text.WriteString(ev.Delta.Text)
		t.wrote[t.block] = true
		if h.handover != nil && slices.Contains(t.channels, reset) {
			h.handover.WriteString(ev.Delta.Text)
		}
		h.emit(Event{Type: "text", Channel: t.block, Delta: ev.Delta.Text})
	case "content_block_stop":
		if t.inText && strings.TrimSpace(t.text.String()) != "" {
			h.emit(Event{Type: "block", Channel: t.block, Text: t.text.String()})
		}
		t.inText = false
	}
}

func (h *Hub) emit(e Event) {
	for s := range h.subs {
		if !s.all && e.Channel != "" && s.channel != e.Channel || !s.all && e.Type == "session" {
			continue
		}
		select {
		case s.ch <- e:
		default:
			log.Printf("hub: %s is not reading, dropped it", s.channel)
			delete(h.subs, s)
			close(s.ch)
		}
	}
}

// Subscribe gets the events of one channel, or of all of them when channel is "".
func (h *Hub) Subscribe(channel string) (<-chan Event, func()) {
	s := &sub{channel: channel, all: channel == "", ch: make(chan Event, 4096)}
	h.mu.Lock()
	h.subs[s] = true
	if s.all && h.sid != "" {
		s.ch <- Event{Type: "session", Text: h.sid}
	}
	h.mu.Unlock()
	return s.ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.subs[s] {
			delete(h.subs, s)
			close(s.ch)
		}
	}
}

func (h *Hub) Status() Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := Status{Session: h.sid, Alive: h.alive, Context: h.context, IdleS: int(h.cfg.Now().Sub(h.lastTurn).Seconds()),
		Pending: []string{}, Held: []string{}, Home: h.home, Channels: map[string]int{}, Reset: h.cfg.Reset, Dir: h.cfg.Dir}
	if ents, err := os.ReadDir(filepath.Join(h.cfg.State, "handovers")); err == nil {
		for _, e := range ents {
			if i, err := e.Info(); err == nil && i.ModTime().After(st.LastReset) {
				st.LastReset = i.ModTime()
			}
		}
	}
	if h.cmd != nil && h.cmd.Process != nil {
		st.PID = h.cmd.Process.Pid
	}
	if h.turn != nil {
		st.Owners, st.Route = h.turn.channels, h.turn.route
	}
	for _, m := range h.pending {
		st.Pending = append(st.Pending, m.channel)
	}
	for _, m := range h.held {
		st.Held = append(st.Held, m.channel)
	}
	if h.call != nil {
		st.Call = "dialing"
		if h.call.answered {
			st.Call = "answered"
		}
	}
	for s := range h.subs {
		if !s.all {
			st.Channels[s.channel]++
		}
	}
	return st
}

func (h *Hub) idle() bool {
	return h.turn == nil && len(h.pending) == 0 && len(h.held) == 0 && h.call == nil
}

var ErrBusy = errors.New("a turn is running")

// Reset starts the conversation over: the session writes a handover note in one last turn, and
// a new session starts with it as its first message.
func (h *Hub) Reset(why string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.idle() || h.handover != nil {
		return ErrBusy
	}
	return h.reset(why)
}

func (h *Hub) reset(why string) error {
	log.Printf("hub: reset (%s), context %d", why, h.context)
	h.handover = &strings.Builder{}
	_, err := h.say(reset, "[hub: bu oturum kapanıp yenisi başlayacak] Yeni oturumun bu konuşmayı sürdürebilmesi için bir devir "+
		"notu yaz: süren işler ve kimde oldukları, verilmiş sözler, bekleyen sorular, kullanıcının bu konuşmada "+
		"söylediği tercihler, son konuşulan konu. Kısa ve düz yaz, başka bir şey yapma.")
	if err != nil {
		h.handover = nil
	}
	return err
}

func (h *Hub) freshStart() {
	note := strings.TrimSpace(h.handover.String())
	h.handover = nil
	old := h.sid
	dir := filepath.Join(h.cfg.State, "handovers")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, h.cfg.Now().Format("20060102-150405")+"-"+old[:min(8, len(old))]+".md"), []byte(note+"\n"), 0o644)
	h.seed = fmt.Sprintf("[hub: yeni oturum; önceki oturum (%s) şu devir notunu bıraktı]\n\n%s", old, note)
	h.saveSID("")
	h.last, h.context = "", 0
	h.emit(Event{Type: "reset", Text: old})
	h.cmd.Process.Signal(syscall.SIGTERM)
}

// Watch applies the reset rule (cfg.Reset) every tick.
func (h *Hub) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if why := h.due(); why != "" && !h.cfg.Call.onCall(ctx) {
			h.mu.Lock()
			if h.idle() && h.handover == nil && h.alive {
				h.reset(why)
			}
			h.mu.Unlock()
		}
	}
}

func (h *Hub) due() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	quiet := h.cfg.Now().Sub(h.lastTurn)
	if !h.idle() || h.handover != nil {
		return ""
	}
	return h.cfg.Reset.Due(quiet, h.context)
}

// Stop ends the claude process for good, for tests and shutdown.
func (h *Hub) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopped = true
	if h.cmd != nil && h.cmd.Process != nil {
		h.in.Close()
		h.cmd.Process.Kill()
	}
}
