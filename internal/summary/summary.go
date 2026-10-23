package summary

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/history"
)

//go:embed prompt.md
var Prompt string

const (
	verbatimUpTo  = 160
	overviewFrom  = 1200
	keep          = 400
	retryAfter    = 10 * time.Minute
	maxAttempts   = 3
	verbatimModel = "verbatim"
)

type Summary struct {
	Reply    string    `json:"reply"`
	Status   string    `json:"status"`
	Gist     []string  `json:"gist,omitempty"`
	Overview []string  `json:"overview,omitempty"`
	Model    string    `json:"model"`
	At       time.Time `json:"at"`
}

type Complete func(ctx context.Context, system, user string) (string, error)

type Summarizer struct {
	Model    string
	complete Complete
	path     string

	mu      sync.Mutex
	done    map[string]Summary
	queued  map[string]bool
	failed  map[string]failure
	queue   chan job
	changed chan struct{}
}

type failure struct {
	n  int
	at time.Time
}

type job struct {
	sid, path, reply, prompt string
}

func Open(path, model string, complete Complete) (*Summarizer, error) {
	s := &Summarizer{Model: model, complete: complete, path: path, done: map[string]Summary{}, queued: map[string]bool{},
		failed: map[string]failure{}, queue: make(chan job, 64), changed: make(chan struct{})}
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &s.done); err != nil {
			return nil, err
		}
	}
	go s.work()
	return s, nil
}

func (s *Summarizer) Get(t history.Transcript) *Summary {
	if s == nil || t.ReplyID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if x, ok := s.done[t.SessionID]; ok && x.Reply == t.ReplyID {
		return &x
	}
	return nil
}

func (s *Summarizer) Want(t history.Transcript) bool {
	if s == nil || t.ReplyID == "" || t.Path == "" {
		return false
	}
	key := t.SessionID + "/" + t.ReplyID
	s.mu.Lock()
	defer s.mu.Unlock()
	if x, ok := s.done[t.SessionID]; ok && x.Reply == t.ReplyID {
		return false
	}
	if s.queued[key] {
		return true
	}
	if f := s.failed[key]; f.n >= maxAttempts || time.Since(f.at) < retryAfter {
		return false
	}
	select {
	case s.queue <- job{t.SessionID, t.Path, t.ReplyID, t.LastPrompt}:
		s.queued[key] = true
		return true
	default:
		return false
	}
}

func (s *Summarizer) Forget(sid string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	delete(s.done, sid)
	for k := range s.failed {
		if strings.HasPrefix(k, sid+"/") {
			delete(s.failed, k)
		}
	}
	s.mu.Unlock()
}

func (s *Summarizer) Wait(ctx context.Context, t history.Transcript) *Summary {
	for {
		s.mu.Lock()
		ch := s.changed
		s.mu.Unlock()
		if x := s.Get(t); x != nil {
			return x
		}
		if !s.pending(t) {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ch:
		}
	}
}

func (s *Summarizer) pending(t history.Transcript) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.queued[t.SessionID+"/"+t.ReplyID]
}

func (s *Summarizer) work() {
	for j := range s.queue {
		x, err := s.make(j)
		key := j.sid + "/" + j.reply
		s.mu.Lock()
		delete(s.queued, key)
		if err != nil {
			f := s.failed[key]
			s.failed[key] = failure{f.n + 1, time.Now()}
			log.Printf("summary %s: %v", j.sid, err)
		} else {
			delete(s.failed, key)
			s.done[j.sid] = x
			s.save()
		}
		close(s.changed)
		s.changed = make(chan struct{})
		s.mu.Unlock()
	}
}

func (s *Summarizer) make(j job) (Summary, error) {
	text, err := history.Reply(j.path, j.reply)
	if err != nil {
		return Summary{}, err
	}
	text = strings.TrimSpace(text)
	if line := clean(text); len([]rune(line)) <= verbatimUpTo {
		return Summary{Reply: j.reply, Status: line, Model: verbatimModel, At: time.Now()}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out, err := s.complete(ctx, Prompt, fmt.Sprintf("The person asked:\n%s\n\nThe assistant's final message:\n%s", j.prompt, text))
	if err != nil {
		return Summary{}, err
	}
	x, err := Parse(out)
	if err != nil {
		return Summary{}, err
	}
	if len([]rune(text)) < overviewFrom {
		x.Overview = nil
	}
	x.Reply, x.Model, x.At = j.reply, s.Model, time.Now()
	return x, nil
}

var object = regexp.MustCompile(`(?s)\{.*\}`)

func Parse(out string) (Summary, error) {
	var raw struct {
		Status   string `json:"status"`
		Gist     any    `json:"gist"`
		Overview any    `json:"overview"`
	}
	if err := json.Unmarshal([]byte(object.FindString(out)), &raw); err != nil {
		return Summary{}, fmt.Errorf("unreadable answer: %.200s", out)
	}
	x := Summary{Status: clean(raw.Status), Gist: lines(raw.Gist), Overview: lines(raw.Overview)}
	if x.Status == "" {
		return Summary{}, fmt.Errorf("answer has no status: %.200s", out)
	}
	return x, nil
}

func lines(v any) []string {
	var parts []string
	switch v := v.(type) {
	case string:
		parts = strings.Split(v, "\n")
	case []any:
		for _, p := range v {
			if s, ok := p.(string); ok {
				parts = append(parts, s)
			}
		}
	}
	var out []string
	for _, p := range parts {
		if p = clean(strings.TrimLeft(strings.TrimSpace(p), "-•* ")); p != "" {
			out = append(out, p)
		}
	}
	return out
}

var (
	link   = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	marks  = regexp.MustCompile("\\*\\*|__|`+")
	header = regexp.MustCompile(`(?m)^\s*(#+|>)\s*`)
)

func clean(s string) string {
	s = marks.ReplaceAllString(header.ReplaceAllString(link.ReplaceAllString(s, "$1"), ""), "")
	return strings.Join(strings.Fields(s), " ")
}

func (s *Summarizer) save() {
	if len(s.done) > keep {
		ids := make([]string, 0, len(s.done))
		for id := range s.done {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return s.done[ids[i]].At.After(s.done[ids[j]].At) })
		for _, id := range ids[keep:] {
			delete(s.done, id)
		}
	}
	b, _ := json.MarshalIndent(s.done, "", " ")
	os.MkdirAll(filepath.Dir(s.path), 0o755)
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err == nil {
		os.Rename(tmp, s.path)
	}
}
