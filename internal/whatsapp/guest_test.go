package whatsapp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGuests(t *testing.T) {
	var sent []string
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/contacts/444@lid/phone"):
			w.Write([]byte(`{"phone":"12025550121"}`))
		case strings.HasSuffix(r.URL.Path, "/messages/send-text"):
			b, _ := io.ReadAll(r.Body)
			sent = append(sent, string(b))
			w.Write([]byte(`{"messageId":"x"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gw.Close()
	for k, v := range map[string]string{"URL": gw.URL, "KEY": "k", "SESSION": "s", "OWNER": "12025550100", "SECRET": "0123456789abcdef"} {
		t.Setenv("ATC_WHATSAPP_"+k, v)
	}
	c := FromEnv()
	path := filepath.Join(t.TempDir(), "guests")
	c.Guests = &Guests{Path: path}
	if len(c.Guests.List()) != 0 || c.Guest(context.Background(), "12025550121@c.us", "") != "" {
		t.Fatal("no file is no guests")
	}
	for _, bad := range [][2]string{{"Pat Lee", "12025550121"}, {"pat", "0202"}, {"pat", "+1 202 abc"}} {
		if c.Guests.Add(bad[0], bad[1]) == nil {
			t.Errorf("added %v", bad)
		}
	}
	if err := c.Guests.Add("Pat", "+1 202 555 0121"); err != nil {
		t.Fatal(err)
	}
	if c.Guests.Add("kim", "12025550121") == nil {
		t.Error("the same number twice")
	}
	c.Guests.Add("ana", "12025550122")
	if err := c.Guests.Remove("ana"); err != nil || c.Guests.Remove("ana") == nil {
		t.Fatalf("remove: %v", err)
	}
	if b, _ := os.ReadFile(path); !strings.HasSuffix(string(b), "\npat 12025550121\n") {
		t.Fatalf("file %q", b)
	}

	ctx := context.Background()
	for from, want := range map[string]string{
		"12025550121@c.us": "pat",
		"444@lid":          "pat",
		"12025550100@c.us": "",
		"555@lid":          "",
	} {
		if got := c.Guest(ctx, from, ""); got != want {
			t.Errorf("Guest(%s) = %q, want %q", from, got, want)
		}
	}
	chat, ok := c.GuestChat("PAT")
	if !ok || chat != "12025550121@c.us" {
		t.Fatalf("GuestChat = %q %v", chat, ok)
	}
	if _, ok := c.GuestChat("ana"); ok {
		t.Fatal("ana is no guest")
	}
	c.Text(To(ctx, chat), "geldi", "")
	c.Text(ctx, "to the owner", "")
	if len(sent) != 2 || !strings.Contains(sent[0], `"chatId":"12025550121@c.us"`) || !strings.Contains(sent[1], `"chatId":"12025550100@c.us"`) {
		t.Fatalf("sent %v", sent)
	}
}

func TestGuestCalled(t *testing.T) {
	g := &Guests{Path: filepath.Join(t.TempDir(), "guests")}
	if err := g.Add("pat", "12025550121"); err != nil {
		t.Fatal(err)
	}
	if g.Call("sam", "Sam") == nil {
		t.Error("named someone who is not a guest")
	}
	if err := g.Call("pat", "  Pat  Lee "); err != nil {
		t.Fatal(err)
	}
	if err := g.Add("sam", "12025550122"); err != nil {
		t.Fatal(err)
	}
	if err := g.Remove("sam"); err != nil {
		t.Fatal(err)
	}
	if c := g.Called()["pat"]; c != "Pat Lee" {
		t.Errorf("an add and a remove of someone else lost what pat is called: %q", c)
	}
	if g.List()["pat"] != "12025550121" {
		t.Errorf("the number moved: %v", g.List())
	}
	if err := g.Call("pat", ""); err != nil || g.Called()["pat"] != "" {
		t.Errorf("clearing kept %q (%v)", g.Called()["pat"], err)
	}
}
