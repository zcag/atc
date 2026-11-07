package push

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestDeafOnlyOnceAPhoneConfirms(t *testing.T) {
	ntfy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer ntfy.Close()
	p, _ := Open(filepath.Join(t.TempDir(), "devices.json"))
	p.Add(Device{Endpoint: ntfy.URL, Name: "phone", Widget: true})

	p.SendWidget(map[string]any{})
	if d := p.Deaf(0); len(d) != 0 {
		t.Fatalf("an app that never confirmed counts as deaf: %v", d)
	}
	p.Heard(ntfy.URL)
	heard := time.Now()
	p.SendWidget(map[string]any{})
	if d := p.Deaf(time.Hour); len(d) != 0 {
		t.Fatalf("deaf before the grace: %v", d)
	}
	d := p.Deaf(0)
	if len(d) != 1 || d[0].Name != "phone" || d[0].Since.Sub(heard).Abs() > time.Second {
		t.Fatalf("an unconfirmed push: %v", d)
	}
	p.Heard(ntfy.URL)
	if d := p.Deaf(0); len(d) != 0 {
		t.Fatalf("confirmed again, still deaf: %v", d)
	}
	q, _ := Open(p.path)
	if !q.Devices()[0].Confirms {
		t.Fatal("confirming is not kept across a restart")
	}
}
