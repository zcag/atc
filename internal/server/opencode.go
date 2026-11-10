package server

import (
	"cmp"
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
	"strings"
	"time"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/ends"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func (s *Server) watchOpenCode() {
	oc := s.M.OC
	if oc == nil {
		return
	}
	s.Term.Attach = func(id string) *exec.Cmd {
		if s.M.OpenCode(id) {
			return oc.Attach(id)
		}
		return nil
	}
	go oc.Watch(context.Background(), func(e opencode.Event) {
		switch e.Type {
		case "session.status":
			if e.Status == "busy" {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				s.M.Adopt(ctx, e.SessionID)
				cancel()
			}
		case "session.idle", "session.updated", "session.deleted", "session.error", "message.updated",
			"question.asked", "question.replied", "question.rejected", "permission.asked", "permission.replied":
		default:
			return
		}
		s.refresh()
	})
}

func (s *Server) startOpenCode(ctx context.Context, dir, name, prompt string, e Engine, p Preset) (string, error) {
	brief, err := p.brief(dir)
	if err != nil {
		return "", err
	}
	op := opencode.Prompt{Text: prompt, Model: e.Model, Brief: brief}
	sid, err := s.M.OC.Start(ctx, dir, name, op)
	if sid != "" {
		s.M.Store.Update(sid, func(m *store.Meta) { m.Live, m.Engine = store.Running, e.Name })
	}
	return sid, err
}

func (s *Server) sendOpenCode(ctx context.Context, sid, text string) error {
	p := opencode.Prompt{Text: text}
	if e, ok := s.engine(s.M.Store.Get(sid).Engine); ok {
		p.Model = e.Model
	}
	return s.M.OC.Send(ctx, sid, p)
}

func (s *Server) answer(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	var a opencode.Answer
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.nameViewer(r)
	q := r.URL.Query()
	got := sessions.Answered{Ask: r.PathValue("ask"), Key: q.Get("key"), What: answerWhat(a), Via: cmp.Or(q.Get("via"), "web"), Device: q.Get("device")}
	done := func(id string, err error) {
		if err == nil {
			got.At = time.Now()
			s.answers.mark(sid, got)
			log.Printf("answered %s from %s on %q: %s", sid, got.Via, got.Device, got.What)
		}
		s.done(w, id, err)
	}
	if !s.M.OpenCode(sid) {
		s.answerClaude(w, r, sid, a, got.Key, done)
		return
	}
	done(sid, s.M.OC.Respond(r.Context(), sid, r.PathValue("ask"), a))
}

// stopAsked is a stop someone asked for: you from a device, a session through its tools, or `atc stop`.
func (s *Server) stopAsked(w http.ResponseWriter, r *http.Request) {
	s.nameViewer(r)
	q := r.URL.Query()
	by := ends.Stop{By: cmp.Or(q.Get("by"), ends.You), Who: q.Get("device")}
	if by.By == ends.Session {
		by.Who = q.Get("from")
	}
	s.act(func(ctx context.Context, id string) error {
		err := s.stop(ctx, id)
		if err == nil {
			by.ID = id
			s.Ends.Stopped(by)
		}
		return err
	})(w, r)
}

// stopFor is atc stopping a session for a reason of its own, which it keeps for the session's end.
func (s *Server) stopFor(ctx context.Context, id, why string) error {
	err := s.M.CLI.Stop(ctx, id)
	if err == nil {
		s.Ends.Stopped(ends.Stop{ID: id, By: ends.Atc, Why: why})
	}
	return err
}

func (s *Server) stop(ctx context.Context, id string) error {
	if l := s.linkOf(id); l != nil {
		_, err := l.c.Interrupt(ctx, "atc")
		return err
	}
	if !s.M.OpenCode(id) {
		return s.M.CLI.Stop(ctx, id)
	}
	if err := s.M.OC.Stop(ctx, id); err != nil {
		log.Printf("stop %s: %v", id, err)
	}
	return s.M.Keep(id, store.Stopped)
}

func (s *Server) remove(ctx context.Context, id string) error {
	if s.hubSession(id) {
		return errors.New("the assistant runs in atc's hub; it starts over with /new on WhatsApp or a fresh assistant in atc, not by removing it")
	}
	if !s.M.OpenCode(id) {
		return s.M.CLI.Remove(ctx, id)
	}
	if err := s.M.OC.Stop(ctx, id); err != nil {
		log.Printf("remove %s: %v", id, err)
	}
	return s.M.Keep(id, "")
}

func (s *Server) openCodeFound(ctx context.Context, sid string) ([]outputs.File, []outputs.Link, map[string]time.Time, error) {
	home, _ := os.UserHomeDir()
	return s.M.OC.Outputs(ctx, sid, home)
}

func (s *Server) answerClaude(w http.ResponseWriter, r *http.Request, sid string, a opencode.Answer, key string, done func(string, error)) {
	id := s.agentID(r.Context(), sid)
	b := claude.Asking(id)
	if key != "" && sessions.ClaudeAsk(id, b).Fingerprint() != key {
		http.Error(w, "it no longer asks that: open it to see what it asks now", http.StatusConflict)
		return
	}
	if b.Approve != "" {
		log.Printf("approve %s: reject=%v %q", id, a.Reject, b.Approve)
		err := s.Term.Drive(r.Context(), id, func(t *attach.Typist) error { return claudeApprove(t, a.Reject) })
		if errors.Is(err, errNoDialog) {
			err = s.Term.Send(r.Context(), id, map[bool]string{false: "yes", true: "no"}[a.Reject])
		}
		done(id, err)
		return
	}
	qs := b.Questions
	if len(qs) == 0 {
		http.Error(w, "Claude is not asking anything right now", http.StatusConflict)
		return
	}
	if t, ok := s.M.Index.Find(sid); ok {
		multi := history.LastAsk(t.Path)
		for i := range qs {
			qs[i].MultiSelect = qs[i].MultiSelect || multi[qs[i].Question]
		}
	}
	for _, x := range a.Answers {
		if len(x) == 0 {
			http.Error(w, "every question needs an answer", http.StatusBadRequest)
			return
		}
	}
	if a.Reject {
		done(id, s.Term.Keys(r.Context(), id, "\x1b"))
		return
	}
	if len(a.Answers) != len(qs) {
		http.Error(w, "one answer per question", http.StatusBadRequest)
		return
	}
	log.Printf("answer %s: %q", id, a.Answers)
	done(id, s.Term.Drive(r.Context(), id, func(t *attach.Typist) error { return claudeAnswer(t, qs, a.Answers) }))
}

type typist interface {
	Key(string) error
	Screen() string
}

var yesOption = regexp.MustCompile(`(\d)\.\s+Yes\s`)

var errNoDialog = errors.New("Claude's approval prompt is not on screen")

func claudeApprove(t typist, reject bool) error {
	m := yesOption.FindAllStringSubmatch(t.Screen(), -1)
	if len(m) == 0 {
		return errNoDialog
	}
	if reject {
		return t.Key("\x1b")
	}
	return t.Key(m[len(m)-1][1])
}

var checkbox = regexp.MustCompile(`\[[ ✔✓x]\]`)

func claudeAnswer(t typist, qs []claude.Question, answers [][]string) error {
	key := func(ks ...string) error {
		for _, k := range ks {
			if err := t.Key(k); err != nil {
				return err
			}
		}
		return nil
	}
	review := len(qs) > 1
	for i, q := range qs {
		labels := map[string]int{}
		for j, o := range q.Options {
			labels[o.Label] = j + 1
		}
		var picked []int
		var typed string
		for _, x := range answers[i] {
			if n, ok := labels[x]; ok {
				picked = append(picked, n)
			} else if typed == "" {
				typed = x
			}
		}
		if len(picked) == 0 && typed == "" {
			return fmt.Errorf("no answer for %q", q.Question)
		}
		down := func(n int) string { return strings.Repeat("\x1b[B", n) }
		if !(q.MultiSelect || checkbox.MatchString(t.Screen())) {
			var err error
			if typed != "" {
				err = key(strconv.Itoa(len(q.Options)+1), typed, "\r")
			} else {
				err = key(strconv.Itoa(picked[0]))
			}
			if err != nil {
				return err
			}
			continue
		}
		for _, n := range picked {
			if err := key(strconv.Itoa(n)); err != nil {
				return err
			}
		}
		row := 1
		if typed != "" {
			if err := key(down(len(q.Options)), typed); err != nil {
				return err
			}
			row = len(q.Options) + 1
		}
		if err := key(down(len(q.Options)+2-row), "\r"); err != nil {
			return err
		}
		review = true
	}
	if review {
		return key("1")
	}
	return nil
}

func (s *Server) agentID(ctx context.Context, sid string) string {
	agents, _ := s.M.CLI.Agents(ctx)
	for _, a := range agents {
		if a.SessionID == sid || a.ID == sid {
			return a.ID
		}
	}
	return sid
}
