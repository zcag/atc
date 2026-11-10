package whatsapp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGroups(t *testing.T) {
	var fetched atomic.Int32
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/groups"):
			w.Write([]byte(`[{"id":"1@g.us","name":"Trip"},{"id":"2@g.us","name":"Alerts"},{"id":"3@g.us","name":"Others"}]`))
		case strings.HasSuffix(r.URL.Path, "/groups/1@g.us"), strings.HasSuffix(r.URL.Path, "/groups/2@g.us"):
			fetched.Add(1)
			w.Write([]byte(`{"id":"x@g.us","participants":[{"id":"9@lid","number":"12025550100"},{"id":"12025550199@c.us","number":"12025550199"}]}`))
		case strings.HasSuffix(r.URL.Path, "/groups/3@g.us"):
			w.Write([]byte(`{"id":"3@g.us","participants":[{"id":"12025550199@c.us","number":"12025550199"}]}`))
		case strings.HasSuffix(r.URL.Path, "/sessions/s"):
			w.Write([]byte(`{"phone":"+12025550199"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gw.Close()
	for k, v := range map[string]string{"URL": gw.URL, "KEY": "k", "SESSION": "s", "OWNER": "12025550100", "SECRET": "0123456789abcdef"} {
		t.Setenv("ATC_WHATSAPP_"+k, v)
	}
	c := FromEnv()
	c.Quiet = &Quiet{Path: filepath.Join(t.TempDir(), "groups-quiet")}
	ctx := context.Background()

	if _, ok := c.Open(ctx, "1@g.us"); !ok {
		t.Error("a group with the owner in it is open")
	}
	c.Open(ctx, "1@g.us")
	if fetched.Load() != 1 {
		t.Errorf("fetched the group %d times, want once while cached", fetched.Load())
	}
	if _, ok := c.Open(ctx, "3@g.us"); ok {
		t.Error("a group without the owner is open")
	}
	if _, ok := c.Open(ctx, "12025550199@c.us"); ok {
		t.Error("a direct chat is open as a group")
	}
	g, err := c.FindGroup(ctx, "alerts")
	if err != nil || g.ID != "2@g.us" {
		t.Fatalf("find by name: %v %v", g, err)
	}
	if _, err := c.FindGroup(ctx, "nope"); err == nil {
		t.Error("found a group that isn't there")
	}
	if err := c.Quiet.Set(g.ID, g.Name, true); err != nil {
		t.Fatal(err)
	}
	c.Quiet.Set("1@g.us", "Trip", true)
	c.Quiet.Set("1@g.us", "", false)
	if _, ok := c.Open(ctx, "2@g.us"); ok || !c.Quiet.Has("2@g.us") || c.Quiet.Has("1@g.us") {
		t.Error("quiet list")
	}
	if self, err := c.Self(ctx); err != nil || self != "12025550199" {
		t.Errorf("self: %q %v", self, err)
	}
}
