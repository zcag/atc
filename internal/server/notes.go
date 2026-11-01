package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
)

type notes struct {
	mu sync.Mutex
	m  map[string]sessions.Note
}

func (n *notes) set(sid string, note sessions.Note) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.m == nil {
		n.m = map[string]sessions.Note{}
	}
	n.m[sid] = note
}

func (n *notes) attach(list []sessions.Session) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for i := range list {
		if note, ok := n.m[list[i].SessionID]; ok {
			list[i].Note = &note
		}
	}
}

func (s *Server) postNote(w http.ResponseWriter, r *http.Request) {
	var note sessions.Note
	if err := json.NewDecoder(r.Body).Decode(&note); err != nil || strings.TrimSpace(note.Text) == "" {
		http.Error(w, "say something: {text, urgent, replies}", http.StatusBadRequest)
		return
	}
	note.Text, note.At = strings.TrimSpace(note.Text), time.Now()
	sid := r.PathValue("sid")
	if note.Page != "" {
		name, at, _ := strings.Cut(note.Page, "#")
		if _, ok := s.Pages.Get(s.owner(sid), name); !ok {
			http.Error(w, "no page named "+name+" (atc show --list)", http.StatusNotFound)
			return
		}
		ref, err := pages.Ref(name, at)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		note.Page = ref
	}
	list, err := s.M.Live(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	if _, ok := find(list, sid); ok {
		s.notes.set(sid, note)
		s.refresh()
		reply(w, map[string]string{"ok": "noted"})
		return
	}
	if s.Push == nil || s.Push.Count() == 0 {
		http.Error(w, "atc on "+s.Host+" does not run this session and has no phone to push to", http.StatusNotFound)
		return
	}
	go s.pushAll([]push.Message{{Title: "Claude", Body: note.Text, Tag: sid + "/note"}}, note.Urgent)
	reply(w, map[string]string{"ok": "pushed"})
}

func noteAlerts(prev map[string]time.Time, list []sessions.Session, viewing func(sessions.Session) bool) (now map[string]time.Time, normal, urgent []push.Message) {
	now = map[string]time.Time{}
	for _, x := range list {
		if x.Note == nil {
			continue
		}
		now[x.SessionID] = x.Note.At
		if was, ok := prev[x.SessionID]; prev == nil || (ok && !x.Note.At.After(was)) {
			continue
		}
		m := push.Message{Title: x.Title, Body: x.Note.Text, Tag: x.SessionID + "/note", URL: "/#/s/" + x.SessionID}
		if x.Note.Page != "" {
			m.URL = pages.Link(x.SessionID, x.Note.Page)
		}
		if len(x.Note.Replies) > 0 && x.Attachable && x.ID != "" {
			m.Session, m.Replies = x.ID, x.Note.Replies
		}
		switch {
		case x.Note.Urgent:
			urgent = append(urgent, m)
		case !x.Away() && !viewing(x):
			normal = append(normal, m)
		}
	}
	return now, normal, urgent
}
