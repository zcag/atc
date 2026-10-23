package server

import (
	"cmp"
	"context"
	"encoding/json"
	"log"
	"maps"
	"net/http"

	"github.com/zcag/atc/internal/store"
)

type Engine struct {
	Name  string            `json:"name"`
	Model string            `json:"model"`
	URL   string            `json:"url,omitempty"`
	Token string            `json:"token,omitempty"`
	Env   map[string]string `json:"env,omitempty"`
	Host  string            `json:"host,omitempty"`
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
		if e.Name == name {
			return e, true
		}
	}
	return Engine{}, false
}

func (s *Server) tagEngine(ctx context.Context, id, engine string) {
	if engine == "" {
		return
	}
	agents, err := s.M.CLI.Agents(ctx)
	if err != nil {
		log.Printf("engine %s for %s: %v", engine, id, err)
		return
	}
	for _, a := range agents {
		if a.ID == id {
			s.M.Store.Update(a.SessionID, func(m *store.Meta) { m.Engine = engine })
			return
		}
	}
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
	list := make([]Engine, len(s.Engines))
	for i, e := range s.Engines {
		list[i] = Engine{Name: e.Name, Model: e.Model}
	}
	gather(s, w, r, "/api/engines", list, func(e *Engine, h string) { e.Host = h })
}
