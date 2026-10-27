package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
)

const pageWindow = 6 * time.Hour

func (s *Server) pageURLs(list []pages.Page) []pages.Page {
	exp := time.Now().Truncate(pageWindow).Add(2 * pageWindow).Unix()
	for i := range list {
		list[i].Host = s.Host
		if !list[i].Gone {
			list[i].URL = s.fileURL(list[i].Session, list[i].Path, exp)
		}
	}
	return list
}

func (s *Server) sessionPages(w http.ResponseWriter, r *http.Request) {
	reply(w, s.pageURLs(s.Pages.Of(s.owner(r.PathValue("sid")))))
}

func (s *Server) showPage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path, Name, Title, Note string
		Actions                 map[string][]string
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !filepath.IsAbs(req.Path) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	target, err := pages.Target(filepath.Clean(req.Path))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	name := pages.Name(cmp.Or(req.Name, target))
	if filepath.Base(target) == "index.html" && req.Name == "" {
		name = pages.Name(filepath.Dir(target))
	}
	if name == "" {
		http.Error(w, "give the page a name with letters or digits", http.StatusBadRequest)
		return
	}
	for a, argv := range req.Actions {
		if a == "" || len(argv) == 0 {
			http.Error(w, "an action needs a name and a command: --action name='command'", http.StatusBadRequest)
			return
		}
	}
	p, created, err := s.Pages.Show(pages.Page{Session: s.owner(r.PathValue("sid")), Name: name, Title: strings.TrimSpace(req.Title), Path: target, Note: strings.TrimSpace(req.Note), Shown: time.Now(), Actions: req.Actions})
	if err != nil {
		fail(w, err)
		return
	}
	s.refresh()
	p, _ = s.Pages.Get(p.Session, p.Name)
	reply(w, map[string]any{"page": s.pageURLs([]pages.Page{p})[0], "created": created})
}

func (s *Server) hidePage(w http.ResponseWriter, r *http.Request) {
	ok, err := s.Pages.Remove(s.owner(r.PathValue("sid")), r.PathValue("name"))
	if err != nil {
		fail(w, err)
		return
	}
	if !ok {
		http.Error(w, "no page named "+r.PathValue("name"), http.StatusNotFound)
		return
	}
	s.refresh()
	reply(w, map[string]string{"ok": "removed"})
}

func (s *Server) pageState(w http.ResponseWriter, r *http.Request) {
	sid, name := s.owner(r.PathValue("sid")), r.PathValue("name")
	if r.Method == http.MethodGet {
		st := s.Pages.State(sid, name)
		if st == nil {
			st = json.RawMessage("null")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(st)
		return
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, pages.MaxState))
	if err != nil || (len(b) > 0 && !json.Valid(b)) {
		http.Error(w, "state is JSON, at most 256 KB", http.StatusBadRequest)
		return
	}
	if err := s.Pages.SetState(sid, name, b); errors.Is(err, os.ErrNotExist) {
		http.Error(w, "no page named "+name, http.StatusNotFound)
		return
	} else if errors.Is(err, pages.ErrTooBig) {
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		return
	} else if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"ok": "saved"})
}

const (
	runTimeout = 30 * time.Second
	runOutput  = 256 << 10
)

func (s *Server) runAction(w http.ResponseWriter, r *http.Request) {
	sid, name := s.owner(r.PathValue("sid")), r.PathValue("name")
	var req struct {
		Action string
		Args   []string
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "send {action, args}: "+err.Error(), http.StatusBadRequest)
		return
	}
	p, ok := s.Pages.Get(sid, name)
	if !ok {
		http.Error(w, "no page named "+name, http.StatusNotFound)
		return
	}
	argv, ok := p.Actions[req.Action]
	if !ok {
		http.Error(w, fmt.Sprintf("page %s has no action %q; declare it with atc show --action %s='command'", name, req.Action, cmp.Or(req.Action, "name")), http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), runTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], append(argv[1:len(argv):len(argv)], req.Args...)...)
	cmd.Dir, cmd.WaitDelay = filepath.Dir(p.Path), 2*time.Second
	var out, errb capped
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := cmd.ProcessState.ExitCode()
	if ctx.Err() == context.DeadlineExceeded {
		errb.Write([]byte("\natc: stopped after " + runTimeout.String()))
	} else if err != nil && code == -1 {
		errb.Write([]byte(err.Error()))
	}
	log.Printf("page %s/%s: ran %s with %d args, exit %d", sid[:min(8, len(sid))], name, req.Action, len(req.Args), code)
	reply(w, map[string]any{"code": code, "stdout": out.String(), "stderr": errb.String()})
}

type capped struct{ bytes.Buffer }

func (c *capped) Write(b []byte) (int, error) {
	if room := runOutput - c.Len(); room < len(b) {
		c.Buffer.Write(b[:max(room, 0)])
	} else {
		c.Buffer.Write(b)
	}
	return len(b), nil
}

func (s *Server) allPages(w http.ResponseWriter, r *http.Request) {
	list := s.Pages.All()
	want := map[string]bool{}
	for _, p := range list {
		want[p.Session] = true
	}
	briefs := s.M.Briefs(want)
	for i := range list {
		b := briefs[list[i].Session]
		list[i].Of, list[i].Cwd = cmp.Or(b.Title, strings.TrimPrefix(list[i].Session, appRef)), b.Cwd
	}
	gather(s, w, r, "/api/pages", s.pageURLs(list), func(p *pages.Page, h string) { p.Host = h })
}

func (s *Server) attachPages(list []sessions.Session) {
	for i := range list {
		if ps := s.Pages.Of(s.owner(list[i].SessionID)); len(ps) > 0 {
			list[i].Shown = s.pageURLs(ps)
		}
	}
}

func pageAlerts(prev map[string]time.Time, list []sessions.Session, viewing func(sessions.Session) bool) (map[string]time.Time, []push.Message) {
	now := map[string]time.Time{}
	var out []push.Message
	for _, x := range list {
		for _, p := range x.Shown {
			key := x.SessionID + "/" + p.Name
			now[key] = p.Shown
			was, ok := prev[key]
			if prev == nil || (ok && !p.Shown.After(was)) || x.Parked || x.App != "" || viewing(x) {
				continue
			}
			out = append(out, push.Message{Title: x.Title, Tag: key, URL: "/#/s/" + x.SessionID + "/p/" + p.Name,
				Body: "Showing you " + cmp.Or(p.Title, p.Name) + prefixed(": ", p.Note)})
		}
	}
	return now, out
}

func prefixed(pre, s string) string {
	if s == "" {
		return ""
	}
	return pre + s
}
