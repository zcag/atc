package hub

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/zcag/atc/internal/startover"
)

func TestMain(m *testing.M) {
	if os.Getenv("HUB_FAKE_CLAUDE") == "1" {
		fakeClaude()
		return
	}
	os.Exit(m.Run())
}

// fakeClaude speaks enough stream-json for the hub: it replays each message, answers
// "echo: <message>", and for a message containing TOOL runs a tool first, taking in what
// arrives meanwhile as joined messages, the way Claude reads them at a tool boundary.
func fakeClaude() {
	sid := ""
	for i, a := range os.Args {
		if (a == "--session-id" || a == "--resume") && i+1 < len(os.Args) {
			sid = os.Args[i+1]
		}
	}
	out := json.NewEncoder(os.Stdout)
	emit := func(v map[string]any) { out.Encode(v) }
	se := func(ev map[string]any) { emit(map[string]any{"type": "stream_event", "event": ev}) }
	textBlock := func(s string) {
		se(map[string]any{"type": "content_block_start", "content_block": map[string]any{"type": "text"}})
		for _, w := range strings.SplitAfter(s, " ") {
			se(map[string]any{"type": "content_block_delta", "delta": map[string]any{"type": "text_delta", "text": w}})
		}
		se(map[string]any{"type": "content_block_stop"})
	}
	emit(map[string]any{"type": "system", "subtype": "init", "session_id": sid})
	lines := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(nil, 1<<20)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	tokens := 0
	replay := func(text string) {
		emit(map[string]any{"type": "user", "isReplay": true, "message": map[string]any{"role": "user", "content": text}})
		tokens += 1000
	}
	for l := range lines {
		var m struct {
			Type    string
			Message struct{ Content string }
		}
		json.Unmarshal([]byte(l), &m)
		if m.Type != "user" {
			continue
		}
		text := m.Message.Content
		if strings.Contains(text, "SLOW") && cutBeforeReplay(lines) {
			emit(map[string]any{"type": "result", "subtype": "error_during_execution"})
			continue
		}
		replay(text)
		if strings.Contains(text, "[hub: this conversation is closing") {
			textBlock("HANDOVER NOTE")
		} else if strings.Contains(text, "TOOL") {
			textBlock("looking")
			se(map[string]any{"type": "content_block_start", "content_block": map[string]any{"type": "tool_use", "name": "Bash"}})
			se(map[string]any{"type": "content_block_stop"})
			var joined []string
			interrupted := func(d time.Duration) bool {
				for wait := time.After(d); ; {
					select {
					case l := <-lines:
						var j struct {
							Type    string
							Request struct{ Subtype string }
							Message struct{ Content string }
						}
						json.Unmarshal([]byte(l), &j)
						if j.Type == "control_request" && j.Request.Subtype == "interrupt" {
							return true
						}
						if j.Type == "user" {
							replay(j.Message.Content)
							joined = append(joined, last(j.Message.Content))
						}
						continue
					case <-wait:
					}
					return false
				}
			}
			if interrupted(400 * time.Millisecond) {
				textBlock("tool cancelled")
				emit(map[string]any{"type": "result", "subtype": "error_during_execution"})
				continue
			}
			emit(map[string]any{"type": "user", "parent_tool_use_id": nil, "message": map[string]any{"role": "user",
				"content": []map[string]any{{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}}}})
			if interrupted(200 * time.Millisecond) {
				emit(map[string]any{"type": "result", "subtype": "error_during_execution"})
				continue
			}
			textBlock("done " + strings.Join(joined, "+"))
		} else {
			textBlock("echo: " + last(text))
		}
		emit(map[string]any{"type": "assistant", "message": map[string]any{"usage": map[string]int{"input_tokens": tokens}}})
		emit(map[string]any{"type": "result", "subtype": "success"})
	}
}

// cutBeforeReplay is Claude Code taking ~2 s to replay a message: an interrupt in that time ends
// the turn without the message ever being replayed.
func cutBeforeReplay(lines chan string) bool {
	select {
	case l := <-lines:
		return strings.Contains(l, `"interrupt"`)
	case <-time.After(600 * time.Millisecond):
		return false
	}
}

func last(text string) string {
	lines := strings.Split(text, "\n")
	return lines[len(lines)-1]
}

type rig struct {
	t   *testing.T
	h   *Hub
	srv *httptest.Server
}

func newRig(t *testing.T, call CallConfig) *rig {
	exe, _ := os.Executable()
	t.Setenv("HUB_FAKE_CLAUDE", "1")
	h := New(Config{Bin: exe, Dir: t.TempDir(), State: t.TempDir(), Call: call,
		Mode: func(ch string) string {
			if ch == "agent" {
				return ""
			}
			return "MODE " + ch
		}})
	if err := h.Start(); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h.Handler())
	t.Cleanup(func() { srv.Close(); h.Stop() })
	return &rig{t, h, srv}
}

type conn struct {
	t  *testing.T
	ws *websocket.Conn
	ev chan Event
}

func (r *rig) dial(channel string) *conn {
	path := "/ws?channel=" + channel
	if channel == "" {
		path = "/events"
	}
	ws, _, err := websocket.Dial(context.Background(), strings.Replace(r.srv.URL, "http", "ws", 1)+path, nil)
	if err != nil {
		r.t.Fatal(err)
	}
	c := &conn{r.t, ws, make(chan Event, 256)}
	go func() {
		for {
			var e Event
			if wsjson.Read(context.Background(), ws, &e) != nil {
				close(c.ev)
				return
			}
			c.ev <- e
		}
	}()
	r.t.Cleanup(func() { ws.CloseNow() })
	return c
}

func (c *conn) send(typ, text string) {
	if err := wsjson.Write(context.Background(), c.ws, map[string]string{"type": typ, "text": text}); err != nil {
		c.t.Fatal(err)
	}
}

// until collects events up to and including the first of type typ.
func (c *conn) until(typ string) []Event {
	var got []Event
	for {
		select {
		case e, ok := <-c.ev:
			if !ok {
				c.t.Fatalf("closed waiting for %s, got %v", typ, got)
			}
			got = append(got, e)
			if e.Type == typ {
				return got
			}
		case <-time.After(5 * time.Second):
			c.t.Fatalf("no %s, got %v", typ, got)
		}
	}
}

func said(es []Event) string {
	var b strings.Builder
	for _, e := range es {
		if e.Type == "text" {
			b.WriteString(e.Delta)
		}
	}
	return b.String()
}

func types(es []Event, typ string) int {
	n := 0
	for _, e := range es {
		if e.Type == typ {
			n++
		}
	}
	return n
}

func TestModeInlinedOnChannelChangeOnly(t *testing.T) {
	r := newRig(t, CallConfig{})
	atc := r.dial("atc")
	all := r.dial("")
	atc.send("message", "hi")
	es := atc.until("done")
	if got := said(es); got != "echo: hi" || types(es, "block") != 1 {
		t.Fatalf("reply %q, events %v", got, es)
	}
	first := all.until("done")
	if first[0].Type != "session" {
		t.Fatalf("watcher first event %v", first[0])
	}
	atc.send("message", "again")
	atc.until("done")
	b, _ := os.ReadFile(filepath.Join(r.h.cfg.State, "home"))
	if strings.TrimSpace(string(b)) != "atc" {
		t.Fatalf("home %q", b)
	}
}

func TestPrefix(t *testing.T) {
	r := newRig(t, CallConfig{})
	var mu sync.Mutex
	var written []string
	in := r.h.in
	r.h.mu.Lock()
	r.h.in = writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		written = append(written, string(b))
		mu.Unlock()
		return in.Write(b)
	})
	r.h.mu.Unlock()
	atc, wa := r.dial("atc"), r.dial("whatsapp")
	atc.send("message", "one")
	atc.until("done")
	atc.send("message", "two")
	atc.until("done")
	wa.send("message", "three")
	wa.until("done")
	mu.Lock()
	defer mu.Unlock()
	want := []string{"[talk-mode: atc, until the next talk-mode line]\\nMODE atc\\n[message]\\none", "\"two\"", "[talk-mode: whatsapp, until the next talk-mode line]\\nMODE whatsapp\\n[message]\\nthree"}
	for i, w := range want {
		if !strings.Contains(written[i], w) {
			t.Errorf("message %d: %s, want %s", i, written[i], w)
		}
	}
}

func TestEachCallStartsInPhoneMode(t *testing.T) {
	r := newRig(t, CallConfig{})
	var mu sync.Mutex
	var written []string
	in := r.h.in
	r.h.mu.Lock()
	r.h.in = writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		written = append(written, string(b))
		mu.Unlock()
		return in.Write(b)
	})
	r.h.mu.Unlock()
	first := r.dial(Phone)
	first.send("message", "alo")
	first.until("done")
	first.ws.Close(websocket.StatusNormalClosure, "")
	for i := 0; ; i++ {
		r.h.mu.Lock()
		last := r.h.last
		r.h.mu.Unlock()
		if last == "" {
			break
		}
		if i > 200 {
			t.Fatal("the hub never noticed the call ended")
		}
		time.Sleep(10 * time.Millisecond)
	}
	second := r.dial(Phone)
	second.send("message", "alo again")
	second.until("done")
	mu.Lock()
	defer mu.Unlock()
	for i, w := range []string{"alo", "alo again"} {
		if !strings.Contains(written[i], "[talk-mode: phone,") || !strings.Contains(written[i], w) {
			t.Errorf("call %d's first message: %s", i+1, written[i])
		}
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(b []byte) (int, error) { return f(b) }
func (f writerFunc) Close() error                { return nil }

func TestTextWaitsForPhoneTurn(t *testing.T) {
	r := newRig(t, CallConfig{})
	phone, wa := r.dial("phone"), r.dial("whatsapp")
	phone.send("message", "TOOL check")
	first := phone.until("tool")
	wa.send("message", "hello")
	if es := wa.until("held"); len(es) != 1 {
		t.Fatalf("whatsapp got %v before held", es)
	}
	ps := append(first, phone.until("done")...)
	if got := said(ps); got != "looking\n\ndone " {
		t.Fatalf("phone heard %q", got)
	}
	if got := said(wa.until("done")); got != "echo: hello" {
		t.Fatalf("whatsapp got %q", got)
	}
}

func TestCutBeforeReplay(t *testing.T) {
	r := newRig(t, CallConfig{})
	phone := r.dial("phone")
	phone.send("message", "SLOW half a question")
	time.Sleep(50 * time.Millisecond)
	phone.send("interrupt", "")
	es := phone.until("done")
	if got := said(es); got != "" || !es[len(es)-1].Interrupted {
		t.Fatalf("said %q, done %+v", got, es[len(es)-1])
	}
	phone.send("message", "the whole question")
	if got := said(phone.until("done")); got != "echo: the whole question" {
		t.Fatalf("after the cut: %q", got)
	}
	if st := r.h.Status(); len(st.Pending) != 0 {
		t.Fatalf("pending %v", st.Pending)
	}
}

func TestToolDoneReachesThePhone(t *testing.T) {
	r := newRig(t, CallConfig{})
	phone := r.dial("phone")
	phone.send("message", "TOOL check")
	es := phone.until("done")
	if types(es, "tool") != 1 || types(es, "tool_done") != 1 {
		t.Fatalf("events %v", es)
	}
	var order []string
	for _, e := range es {
		if e.Type == "tool" || e.Type == "tool_done" || e.Type == "done" {
			order = append(order, e.Type)
		}
	}
	if strings.Join(order, ",") != "tool,tool_done,done" {
		t.Fatalf("order %v", order)
	}
}

func TestJoinRoutesToNewest(t *testing.T) {
	r := newRig(t, CallConfig{})
	atc, wa := r.dial("atc"), r.dial("whatsapp")
	atc.send("message", "TOOL build")
	first := atc.until("tool")
	wa.send("message", "status?")
	ws := wa.until("done")
	if types(ws, "joined") != 1 || said(ws) != "done status?" {
		t.Fatalf("whatsapp %v", ws)
	}
	as := append(first, atc.until("done")...)
	if said(as) != "looking" {
		t.Fatalf("atc got %q", said(as))
	}
}

func TestAgentReportReachesNoOne(t *testing.T) {
	r := newRig(t, CallConfig{})
	var mu sync.Mutex
	var written []string
	in := r.h.in
	r.h.mu.Lock()
	r.h.in = writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		written = append(written, string(b))
		mu.Unlock()
		return in.Write(b)
	})
	r.h.mu.Unlock()
	wa, all := r.dial("whatsapp"), r.dial("")
	wa.send("message", "start it")
	wa.until("done")
	all.until("done")
	r.h.Say(Agent, "report: done")
	if es := all.until("done"); said(es) != "echo: report: done" || es[len(es)-1].Channel != Agent {
		t.Fatalf("agent turn %v", es)
	}
	select {
	case e := <-wa.ev:
		t.Fatalf("whatsapp got %v", e)
	case <-time.After(200 * time.Millisecond):
	}
	mu.Lock()
	note := written[len(written)-1]
	mu.Unlock()
	if !strings.Contains(note, "not on a call; the user last wrote from whatsapp") {
		t.Fatalf("agent note %s", note)
	}

	ph := r.dial(Phone)
	for r.h.Status().Channels[Phone] == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	r.h.Say(Agent, "report: merged")
	all.until("done")
	ph.send("message", "ne oldu")
	if got := said(ph.until("done")); got != "echo: ne oldu" {
		t.Fatalf("phone got %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	agent, phone := written[len(written)-2], written[len(written)-1]
	if !strings.Contains(agent, "on a call with you right now") || !strings.Contains(phone, "a report or a guest's message came in while you were on the call") {
		t.Fatalf("agent %s\nphone %s", agent, phone)
	}
}

func TestInterruptByPhoneOnlyWhenItsOwn(t *testing.T) {
	r := newRig(t, CallConfig{})
	atc := r.dial("atc")
	atc.send("message", "TOOL long")
	atc.until("tool")
	if r.h.Interrupt("phone", false) {
		t.Fatal("phone cut an atc turn")
	}
	if !r.h.Interrupt("whatsapp", true) {
		t.Fatal("forced interrupt refused")
	}
	if es := atc.until("done"); !es[len(es)-1].Interrupted {
		t.Fatalf("done %v", es[len(es)-1])
	}
}

func TestBargeInLetsTheToolFinish(t *testing.T) {
	r := newRig(t, CallConfig{})
	phone := r.dial("phone")
	phone.send("message", "TOOL send it")
	phone.until("tool")
	phone.send("interrupt", "")
	es := phone.until("done")
	if strings.Contains(said(es), "cancelled") || strings.Contains(said(es), "done") || !es[len(es)-1].Interrupted {
		t.Fatalf("said %q, done %v", said(es), es[len(es)-1])
	}
	phone.send("message", "next")
	if es := phone.until("done"); !strings.Contains(said(es), "echo: next") {
		t.Fatalf("after the cut: %q", said(es))
	}
}

type line_ struct {
	mu      sync.Mutex
	states  []lineState
	dialed  []string
	via     []string
	hangups int
}

func (l *line_) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		defer l.mu.Unlock()
		switch r.URL.Path {
		case "/status":
			st := l.states[0]
			if len(l.states) > 1 {
				l.states = l.states[1:]
			}
			json.NewEncoder(w).Encode(st)
		case "/dial":
			var b map[string]string
			json.NewDecoder(r.Body).Decode(&b)
			l.dialed = append(l.dialed, b["number"])
			v, ok := b["via"]
			if !ok {
				v = "-"
			}
			l.via = append(l.via, v)
			fmt.Fprint(w, `{"ok":true}`)
		case "/hangup":
			l.hangups++
			fmt.Fprint(w, `{"ok":true}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCallAnswered(t *testing.T) {
	l := &line_{states: []lineState{{"idle", "idle"}, {"offhook", "dialing"}, {"offhook", "alerting"}, {"offhook", "active"}}}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond})
	out, err := r.h.Call(context.Background(), CallReq{Reason: "deploy done", From: "[from session \"x\"]"})
	if err != nil || out != Answered {
		t.Fatalf("%s %v", out, err)
	}
	if l.dialed[0] != "+900" {
		t.Fatalf("dialed %v", l.dialed)
	}
	var mu sync.Mutex
	var written string
	in := r.h.in
	r.h.mu.Lock()
	r.h.in = writerFunc(func(b []byte) (int, error) { mu.Lock(); written += string(b); mu.Unlock(); return in.Write(b) })
	r.h.mu.Unlock()
	phone := r.dial("phone")
	phone.send("message", "[the user picked up]")
	phone.until("done")
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(written, "[message]\\n[phone · "+time.Now().Format("15:04")+" · you called the user, they picked up · reason: deploy done]\\n[from session \\\"x\\\"]\\n[the user") {
		t.Fatalf("phone message: %s", written)
	}
	if r.h.Status().Call != "" {
		t.Fatal("call still pending after the phone spoke")
	}
}

func TestCallOpeningWrittenWhileRinging(t *testing.T) {
	states := []lineState{{"idle", "idle"}, {"offhook", "dialing"}}
	for range 40 {
		states = append(states, lineState{"offhook", "alerting"})
	}
	l := &line_{states: append(states, lineState{"offhook", "active"})}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond})
	var mu sync.Mutex
	var written string
	in := r.h.in
	r.h.mu.Lock()
	r.h.in = writerFunc(func(b []byte) (int, error) { mu.Lock(); written += string(b); mu.Unlock(); return in.Write(b) })
	r.h.mu.Unlock()
	done := make(chan string)
	go func() { out, _ := r.h.Call(context.Background(), CallReq{Reason: "deploy done"}); done <- out }()
	for r.h.Status().Call != "dialing" {
		time.Sleep(time.Millisecond)
	}
	phone := r.dial("phone")
	phone.send("message", "[opening]")
	phone.until("done")
	if out := <-done; out != Answered {
		t.Fatal(out)
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(written, "you called the user, it is ringing, this is the first thing they hear when they pick up · reason: deploy done]\\n[opening]") {
		t.Fatalf("phone message: %s", written)
	}
	if r.h.Status().Call != "" {
		t.Fatal("call still pending after it was answered")
	}
}

func TestCallNotAnsweredTellsTheChannel(t *testing.T) {
	l := &line_{states: []lineState{{"idle", "idle"}, {"offhook", "dialing"}, {"idle", "disconnected"}}}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond})
	wa := r.dial("whatsapp")
	wa.send("message", "hi")
	wa.until("done")
	out, err := r.h.Call(context.Background(), CallReq{Reason: "soru", Notify: true})
	if err != nil || out != NoAnswer {
		t.Fatalf("%s %v", out, err)
	}
	if got := said(wa.until("done")); !strings.Contains(got, "no answer · reason: soru]") {
		t.Fatalf("whatsapp got %q", got)
	}
}

func TestCallTimesOutAndHangsUp(t *testing.T) {
	l := &line_{states: []lineState{{"idle", "idle"}, {"offhook", "alerting"}}}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond})
	out, _ := r.h.Call(context.Background(), CallReq{Timeout: 1})
	if out != NoAnswer || l.hangups != 1 {
		t.Fatalf("%s, %d hangups", out, l.hangups)
	}
}

func TestCallViaWhatsAppOnlyWhenAsked(t *testing.T) {
	l := &line_{states: []lineState{{"idle", "idle"}, {"offhook", "dialing"}, {"offhook", "active"}}}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond})
	if out, err := r.h.Call(context.Background(), CallReq{WhatsApp: true}); out != Answered {
		t.Fatalf("%s %v", out, err)
	}
	r.h.mu.Lock()
	r.h.call = nil
	r.h.mu.Unlock()
	l.mu.Lock()
	l.states = []lineState{{"idle", "idle"}, {"offhook", "dialing"}, {"offhook", "active"}}
	l.mu.Unlock()
	if out, err := r.h.Call(context.Background(), CallReq{}); out != Answered {
		t.Fatalf("%s %v", out, err)
	}
	if strings.Join(l.via, ",") != "whatsapp,app" {
		t.Fatalf("via %v", l.via)
	}
}

func TestCallFallsBackToThePhoneWhenTheAppDoesNotRing(t *testing.T) {
	states := []lineState{{"idle", "idle"}}
	for range 20 {
		states = append(states, lineState{"offhook", "dialing"})
	}
	l := &line_{states: append(states, lineState{"offhook", "alerting"}, lineState{"offhook", "active"})}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond, AppAck: 50 * time.Millisecond})
	events, done := r.h.Subscribe("")
	defer done()
	if out, err := r.h.Call(context.Background(), CallReq{Reason: "soru"}); out != Answered {
		t.Fatalf("%s %v", out, err)
	}
	if strings.Join(l.via, ",") != "app,-" || l.hangups != 1 {
		t.Fatalf("via %v, %d hangups", l.via, l.hangups)
	}
	for {
		select {
		case e := <-events:
			if e.Type == "ring" {
				if e.Text != "soru" {
					t.Fatalf("ring %q", e.Text)
				}
				return
			}
		case <-time.After(time.Second):
			t.Fatal("no ring event")
		}
	}
}

func TestCallDeclinedInTheAppDoesNotFallBack(t *testing.T) {
	l := &line_{states: []lineState{{"idle", "idle"}, {"offhook", "dialing"}, {"offhook", "alerting"}, {"idle", "idle"}}}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond, AppAck: time.Second})
	if out, _ := r.h.Call(context.Background(), CallReq{}); out != NoAnswer || strings.Join(l.via, ",") != "app" {
		t.Fatalf("%s via %v", out, l.via)
	}
}

func TestCallWhileOnACall(t *testing.T) {
	l := &line_{states: []lineState{{"offhook", "active"}}}
	r := newRig(t, CallConfig{URL: l.server(t).URL, Number: "+900", Poll: 10 * time.Millisecond})
	if out, _ := r.h.Call(context.Background(), CallReq{}); out != Busy || len(l.dialed) != 0 {
		t.Fatalf("%s, dialed %v", out, l.dialed)
	}
}

func TestResetHandsOver(t *testing.T) {
	r := newRig(t, CallConfig{})
	all := r.dial("")
	atc := r.dial("atc")
	atc.send("message", "hi")
	atc.until("done")
	all.until("done")
	old := r.h.Status().Session
	if err := r.h.Reset("test"); err != nil {
		t.Fatal(err)
	}
	if es := all.until("reset"); es[len(es)-1].Text != old {
		t.Fatalf("reset event %v", es[len(es)-1])
	}
	es := all.until("session")
	if sid := es[len(es)-1].Text; sid == old || sid == "" {
		t.Fatalf("new session %q (old %s)", sid, old)
	}
	es = all.until("done")
	if got := said(es); !strings.Contains(got, "HANDOVER NOTE") {
		t.Fatalf("seed turn said %q", got)
	}
	notes, _ := filepath.Glob(filepath.Join(r.h.cfg.State, "handovers", "*.md"))
	if len(notes) != 1 {
		t.Fatalf("handovers %v", notes)
	}
	atc.send("message", "after")
	if got := said(atc.until("done")); got != "echo: after" {
		t.Fatalf("after reset %q", got)
	}
}

func TestResetRule(t *testing.T) {
	now := time.Now()
	h := New(Config{State: t.TempDir(), Reset: startover.Default,
		Now: func() time.Time { return now }})
	for _, c := range []struct {
		quiet   time.Duration
		context int
		due     bool
	}{
		{7 * time.Hour, 50_000, false},
		{7 * time.Hour, 90_000, true},
		{time.Hour, 120_000, false},
		{11 * time.Minute, 160_000, true},
		{5 * time.Minute, 200_000, false},
	} {
		h.lastTurn, h.context = now.Add(-c.quiet), c.context
		if got := h.due() != ""; got != c.due {
			t.Errorf("quiet %s, context %d: due %v", c.quiet, c.context, got)
		}
	}
	h.turn = &turn{}
	h.lastTurn, h.context = now.Add(-7*time.Hour), 200_000
	if h.due() != "" {
		t.Error("due mid-turn")
	}
}
