package server

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/zcag/atc/internal/attach"
	"github.com/zcag/atc/internal/claude"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
)

func TestPalOnlyWhenSet(t *testing.T) {
	for _, pal := range []string{"", "https://pal.example:7373"} {
		bin := fakeClaude(t)
		st, _ := store.Open(filepath.Join(t.TempDir(), "meta.json"))
		s := &Server{M: &sessions.Manager{CLI: claude.CLI{Bin: bin}, Index: history.New(t.TempDir()), Store: st}, Term: &attach.Hub{Bin: bin},
			Web: fstest.MapFS{"index.html": {Data: []byte("atc")}}, Token: "tok", Host: "here", Pal: pal, PalToken: "pt", PalBarHide: []string{"audio/volume"}}
		ts := httptest.NewServer(s.Handler())
		defer ts.Close()

		res, _ := get(t, ts.URL+"/", "tok")
		csp := res.Header.Get("Content-Security-Policy")
		_, body := get(t, ts.URL+"/api/me", "tok")
		var me struct {
			Pal *struct {
				Server, Token string
				Hide          []string
			}
		}
		json.Unmarshal([]byte(body), &me)
		if pal == "" {
			if me.Pal != nil || strings.Contains(csp, "pal") {
				t.Errorf("no pal set, yet: me %+v, csp %q", me.Pal, csp)
			}
			continue
		}
		if me.Pal == nil || me.Pal.Server != pal || me.Pal.Token != "pt" || len(me.Pal.Hide) != 1 {
			t.Errorf("me: %+v", me.Pal)
		}
		if !strings.Contains(csp, "script-src 'self' "+pal+";") || !strings.Contains(csp, "frame-src 'self' "+pal+";") {
			t.Errorf("csp: %q", csp)
		}
	}
}
