package server

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/push"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

// fromAgent says the request comes from a Claude session (atc's MCP tools or CLI), not from the user's page.
func fromAgent(r *http.Request) bool { return r.Header.Get(client.CallerHeader) != "" }

// hiddenFromAgent says the request is an agent's and names a private session: agents can't list, read or write to
// one. parts is the request path split at its slashes.
func hiddenFromAgent(r *http.Request, parts []string) bool {
	return fromAgent(r) && len(parts) >= 4 && parts[1] == "api" && parts[2] == "sessions" && claude.Private(parts[3])
}

func withoutPrivate(list []sessions.Session) []sessions.Session {
	return slices.DeleteFunc(list, func(x sessions.Session) bool { return x.Private })
}

// privatePush is the only push a private session sends: that it waits on you, never what it says.
func privatePush(x sessions.Session, body string) push.Message {
	return push.Message{Title: sessions.PrivateTitle, Body: body, Tag: x.SessionID, URL: "/#/s/" + x.SessionID}
}

// uploadDir is where a file sent to the session sid (or to the next new session, "") is kept: atc's cache, or for a
// private session its profile's memory folder, which goes with it.
func uploadDir(sid, profile string) string {
	var p claude.Profile
	if sid != "" {
		p = claude.Owner(sid)
	} else if profile != "" {
		p, _ = claude.ProfileNamed(profile)
	}
	if p.Ephemeral {
		return filepath.Join(p.Home(), "uploads", cmp.Or(sid, "new"))
	}
	return cachedUploads(cmp.Or(sid, "shared"))
}

func cachedUploads(folder string) string {
	cache, _ := os.UserCacheDir()
	return filepath.Join(cache, "atc", "uploads", filepath.Base(folder))
}

// erase ends the private session id and deletes everything of it: its job, conversation, prompt history, folder,
// uploads, summary, draft and name.
func (s *Server) erase(ctx context.Context, id string) error {
	p := claude.Owner(id)
	if !p.Ephemeral {
		return badf("%s is not a private session", id)
	}
	list, err := s.M.Live(ctx)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(list, func(x sessions.Session) bool { return x.ID == id || x.SessionID == id })
	if i < 0 {
		return fmt.Errorf("%w %s", errUnknown, id)
	}
	x := list[i]
	if x.ID != "" {
		if x.PID > 0 {
			if err := s.M.CLI.Stop(ctx, x.ID); err != nil {
				log.Printf("erase %s: stop: %v", x.ID, err)
			}
		}
		if err := s.M.CLI.RemoveFrom(ctx, p, x.ID); err != nil {
			return err
		}
	}
	if err := claude.Erase(p, x.SessionID); err != nil {
		return err
	}
	for _, dir := range []string{x.StartCwd, x.Cwd} {
		if rel, err := filepath.Rel(p.Scratch(), dir); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			os.RemoveAll(filepath.Join(p.Scratch(), strings.Split(rel, string(filepath.Separator))[0]))
		}
	}
	os.RemoveAll(uploadDir(x.SessionID, ""))
	s.M.Summary.Forget(x.SessionID)
	s.M.Store.Update(x.SessionID, func(m *store.Meta) { *m = store.Meta{} })
	s.dropDraft(x.SessionID)
	log.Printf("erase %s: private session erased", x.ID)
	return nil
}
