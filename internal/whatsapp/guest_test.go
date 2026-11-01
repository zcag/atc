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
			w.Write([]byte(`{"phone":"905320000000"}`))
		case strings.HasSuffix(r.URL.Path, "/messages/send-text"):
			b, _ := io.ReadAll(r.Body)
			sent = append(sent, string(b))
			w.Write([]byte(`{"messageId":"x"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gw.Close()
	for k, v := range map[string]string{"URL": gw.URL, "KEY": "k", "SESSION": "s", "OWNER": "15550100", "SECRET": "0123456789abcdef"} {
		t.Setenv("ATC_WHATSAPP_"+k, v)
	}
	c := FromEnv()
	path := filepath.Join(t.TempDir(), "guests")
	c.Guests = &Guests{Path: path}
	if len(c.Guests.List()) != 0 || c.Guest(context.Background(), "905320000000@c.us", "") != "" {
		t.Fatal("no file is no guests")
	}
	for _, bad := range [][2]string{{"Sam Ali", "905320000000"}, {"sam", "0532"}, {"sam", "+90 532 abc"}} {
		if c.Guests.Add(bad[0], bad[1]) == nil {
			t.Errorf("added %v", bad)
		}
	}
	if err := c.Guests.Add("Sam", "+90 532 000 0000"); err != nil {
		t.Fatal(err)
	}
	if c.Guests.Add("friend", "905320000000") == nil {
		t.Error("the same number twice")
	}
	c.Guests.Add("pat", "905330000000")
	if err := c.Guests.Remove("pat"); err != nil || c.Guests.Remove("pat") == nil {
		t.Fatalf("remove: %v", err)
	}
	if b, _ := os.ReadFile(path); !strings.HasSuffix(string(b), "\nsam 905320000000\n") {
		t.Fatalf("file %q", b)
	}

	ctx := context.Background()
	for from, want := range map[string]string{
		"905320000000@c.us": "sam",
		"444@lid":           "sam",
		"15550100@c.us": "",
		"555@lid":           "",
	} {
		if got := c.Guest(ctx, from, ""); got != want {
			t.Errorf("Guest(%s) = %q, want %q", from, got, want)
		}
	}
	chat, ok := c.GuestChat("SAM")
	if !ok || chat != "905320000000@c.us" {
		t.Fatalf("GuestChat = %q %v", chat, ok)
	}
	if _, ok := c.GuestChat("pat"); ok {
		t.Fatal("pat is no guest")
	}
	c.Text(To(ctx, chat), "geldi", "")
	c.Text(ctx, "to them", "")
	if len(sent) != 2 || !strings.Contains(sent[0], `"chatId":"905320000000@c.us"`) || !strings.Contains(sent[1], `"chatId":"15550100@c.us"`) {
		t.Fatalf("sent %v", sent)
	}
}
