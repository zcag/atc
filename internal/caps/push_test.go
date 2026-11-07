package caps

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckPushSaysWhenAPhoneStoppedHearing(t *testing.T) {
	ntfy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer ntfy.Close()
	env := Env{Devices: []string{ntfy.URL + "/up1"}}
	if r := checkPush(context.Background(), env); r.Status != OK {
		t.Fatalf("%+v", r)
	}
	env.Deaf = []string{"phone since 02:29"}
	if r := checkPush(context.Background(), env); r.Status != Broken || !strings.Contains(r.Detail, "phone since 02:29") {
		t.Fatalf("%+v", r)
	}
}
