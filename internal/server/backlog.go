package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/zcag/atc/internal/backlog"
)

var worktreeDir = regexp.MustCompile(`/\.claude/worktrees/[^/]+$`)

type backlogReq struct {
	Dir      *string `json:"dir"`
	Title    *string `json:"title"`
	Prompt   *string `json:"prompt"`
	Status   *string `json:"status"`
	Why      *string `json:"why"`
	Accepted *bool   `json:"accepted"`
	Worktree *bool   `json:"worktree"`
	By       string  `json:"by"`
	From     string  `json:"from"`
}

func (q backlogReq) apply(it *backlog.Item) error {
	if q.Dir != nil {
		dir, err := expand(*q.Dir)
		if err != nil {
			return badRequest{err}
		}
		dir = worktreeDir.ReplaceAllString(dir, "")
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return badf("%s is not a folder here", dir)
		}
		it.Dir = dir
	}
	if q.Title != nil {
		it.Title = strings.Join(strings.Fields(*q.Title), " ")
	}
	if q.Prompt != nil {
		it.Prompt = strings.TrimSpace(*q.Prompt)
	}
	if it.FirstMessage() == "" {
		return badf("a title or a prompt is required")
	}
	if q.Status != nil {
		switch *q.Status {
		case backlog.Ready, backlog.Blocked, backlog.Done:
			it.Status = *q.Status
		default:
			return badf("status is ready, blocked or done")
		}
		if it.Status != backlog.Blocked {
			it.Why = ""
		}
	}
	if q.Why != nil {
		it.Why = strings.TrimSpace(*q.Why)
	}
	if q.Accepted != nil {
		it.Accepted = *q.Accepted
	}
	if q.Worktree != nil {
		it.Worktree = *q.Worktree
	}
	return nil
}

func (s *Server) backlogList(w http.ResponseWriter, r *http.Request) {
	items := s.Backlog.List()
	if slices.ContainsFunc(items, func(it backlog.Item) bool { return it.Session != "" && it.SID == "" }) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		live, _ := s.M.Live(ctx)
		cancel()
		for i, it := range items {
			if it.Session == "" || it.SID != "" {
				continue
			}
			for _, x := range live {
				if x.ID == it.Session {
					items[i], _ = s.Backlog.Update(it.ID, func(it *backlog.Item) { it.SID = x.SessionID })
				}
			}
		}
	}
	gather(s, w, r, "/api/backlog", items, func(it *backlog.Item, h string) { it.Host = h })
}

func (s *Server) backlogAdd(w http.ResponseWriter, r *http.Request) {
	var q backlogReq
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	it := backlog.Item{By: strings.TrimSpace(q.By), From: q.From}
	if q.Dir == nil {
		http.Error(w, "dir is required", http.StatusBadRequest)
		return
	}
	if err := q.apply(&it); err != nil {
		backlogFail(w, err)
		return
	}
	it, err := s.Backlog.Add(it)
	s.backlogDone(w, it, err)
}

func (s *Server) backlogPatch(w http.ResponseWriter, r *http.Request) {
	var q backlogReq
	if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var bad error
	it, err := s.Backlog.Update(r.PathValue("id"), func(it *backlog.Item) {
		next := *it
		if bad = q.apply(&next); bad == nil {
			*it = next
		}
	})
	s.backlogDone(w, it, errors.Join(bad, err))
}

func (s *Server) backlogRemove(w http.ResponseWriter, r *http.Request) {
	s.backlogDone(w, backlog.Item{ID: r.PathValue("id")}, s.Backlog.Remove(r.PathValue("id")))
}

func (s *Server) backlogStart(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var it backlog.Item
	for _, x := range s.Backlog.List() {
		if x.ID == id {
			it = x
		}
	}
	if it.ID == "" {
		backlogFail(w, backlog.ErrNotFound)
		return
	}
	sid, err := s.startSession(r.Context(), startReq{Dir: it.Dir, Name: it.Title, Prompt: it.FirstMessage(), Worktree: it.Worktree})
	if err != nil {
		backlogFail(w, err)
		return
	}
	_, err = s.Backlog.Update(id, func(it *backlog.Item) {
		it.Session, it.SID, it.Status, it.Why, it.Accepted = sid, "", backlog.Ready, "", true
	})
	s.done(w, sid, err)
}

func backlogFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, backlog.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.As(err, new(badRequest)):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		fail(w, err)
	}
}

func (s *Server) backlogDone(w http.ResponseWriter, it backlog.Item, err error) {
	if err != nil {
		backlogFail(w, err)
		return
	}
	it.Host = s.Host
	reply(w, it)
}
