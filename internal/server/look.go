package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Look struct {
	Scheme string `json:"scheme"`
	Theme  string `json:"theme"`
}

var themeName = regexp.MustCompile(`^[a-z0-9-]{0,40}$`)

func (s *Server) lookPath() string { return filepath.Join(s.StateDir, "look.json") }

func (s *Server) look() Look {
	l := Look{Scheme: "auto"}
	if s.StateDir != "" {
		if b, err := os.ReadFile(s.lookPath()); err == nil {
			json.Unmarshal(b, &l)
		}
	}
	return l
}

func (s *Server) setLook(w http.ResponseWriter, r *http.Request) {
	var l Look
	if err := json.NewDecoder(r.Body).Decode(&l); err != nil || !themeName.MatchString(l.Theme) {
		http.Error(w, "want {scheme: auto|light|dark, theme}", http.StatusBadRequest)
		return
	}
	if l.Scheme != "light" && l.Scheme != "dark" {
		l.Scheme = "auto"
	}
	if s.StateDir == "" {
		http.Error(w, "no state dir", http.StatusInternalServerError)
		return
	}
	b, _ := json.Marshal(l)
	if err := os.WriteFile(s.lookPath(), b, 0o644); err != nil {
		fail(w, err)
		return
	}
	s.broadcast("look", b)
	if s.Push != nil {
		list, err := s.liveAll(r.Context(), false)
		if err == nil {
			go s.Push.SendWidget(s.widgetFeed(list))
		}
	}
	if r.URL.Query().Get("from") != "peer" {
		go s.fleet.putLook(l)
	}
	reply(w, l)
}

func (f *fleet) putLook(l Look) {
	b, _ := json.Marshal(l)
	for _, p := range f.peers {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "PUT", strings.TrimRight(p.URL, "/")+"/api/look?from=peer", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+p.Token)
		req.Header.Set("Content-Type", "application/json")
		if res, err := f.client.Do(req); err != nil {
			log.Printf("look: %s: %v", p.Name, err)
		} else {
			res.Body.Close()
		}
		cancel()
	}
}
