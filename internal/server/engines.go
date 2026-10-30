package server

import (
	"cmp"
	"context"
	"encoding/json"
	"log"
	"maps"
	"net/http"
	"time"

	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/store"
)

type Engine struct {
	Name    string            `json:"name"`
	Harness string            `json:"harness,omitempty"`
	Model   string            `json:"model"`
	URL     string            `json:"url,omitempty"`
	Token   string            `json:"token,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Host    string            `json:"host,omitempty"`
}

func LoadEngines(path string) ([]Engine, error) { return loadList[Engine](path) }

func (e Engine) args() []string {
	env := map[string]string{
		"ANTHROPIC_BASE_URL":             e.URL,
		"ANTHROPIC_AUTH_TOKEN":           cmp.Or(e.Token, "local"),
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   e.Model,
		"ANTHROPIC_DEFAULT_SONNET_MODEL": e.Model,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  e.Model,
		"CLAUDE_CODE_SUBAGENT_MODEL":     e.Model,

		"CLAUDE_CODE_ATTRIBUTION_HEADER":           "0",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
	}
	maps.Copy(env, e.Env)
	b, _ := json.Marshal(map[string]any{"env": env})
	return []string{"--settings", string(b), "--model", e.Model}
}

func (s *Server) engine(name string) (Engine, bool) {
	for _, e := range s.Engines {
		if e.Name == name && (e.Harness != opencode.Harness || s.M.OC != nil) {
			return e, true
		}
	}
	return Engine{}, false
}

// tag sets atc's own fields of a session Claude just started or resumed, once it lists it.
func (s *Server) tag(ctx context.Context, id string, f func(*store.Meta)) {
	for range 10 {
		agents, err := s.M.CLI.Agents(ctx)
		if err != nil {
			log.Printf("tag %s: %v", id, err)
			return
		}
		for _, a := range agents {
			if a.ID == id && a.SessionID != "" {
				s.M.Store.Update(a.SessionID, f)
				return
			}
		}
		time.Sleep(time.Second)
	}
	log.Printf("tag %s: Claude does not list it", id)
}

func (s *Server) engineOf(sid string) (Engine, bool) {
	if name := s.M.Store.Get(sid).Engine; name != "" {
		return s.engine(name)
	}
	for _, t := range s.M.Index.Scan() {
		if t.SessionID != sid {
			continue
		}
		for _, e := range s.Engines {
			if e.Model == t.Model {
				return e, true
			}
		}
		break
	}
	return Engine{}, false
}

func (s *Server) engines(w http.ResponseWriter, r *http.Request) {
	list := []Engine{}
	for _, e := range s.Engines {
		if _, ok := s.engine(e.Name); ok {
			list = append(list, Engine{Name: e.Name, Harness: e.Harness, Model: e.Model})
		}
	}
	gather(s, w, r, "/api/engines", list, func(e *Engine, h string) { e.Host = h })
}
