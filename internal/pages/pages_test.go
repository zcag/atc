package pages

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestMerge(t *testing.T) {
	for _, c := range []struct{ old, v, want string }{
		{``, `{"a":1,"b":null}`, `{"a":1}`},
		{`{"a":1,"b":2}`, `{"b":3,"c":4}`, `{"a":1,"b":3,"c":4}`},
		{`{"a":1,"b":2}`, `{"a":null}`, `{"b":2}`},
		{`{"a":1}`, `[1,2]`, `[1,2]`},
		{`[1,2]`, `{"a":1}`, `{"a":1}`},
		{`"x"`, `{"a":1}`, `{"a":1}`},
		{`{"a":1}`, `null`, `null`},
	} {
		if got := string(Merge(json.RawMessage(c.old), json.RawMessage(c.v))); got != c.want {
			t.Errorf("Merge(%s, %s) = %s, want %s", c.old, c.v, got, c.want)
		}
	}
}

func TestSetStateMerges(t *testing.T) {
	st, _ := Open("")
	st.Show(Page{Session: "s", Name: "p", Path: "/x"})
	if err := st.SetState("s", "q", json.RawMessage(`{}`)); err == nil {
		t.Fatal("state on a missing page")
	}
	st.SetState("s", "p", json.RawMessage(`{"mail":[1],"handled":{"a":true}}`))
	st.SetState("s", "p", json.RawMessage(`{"mail":[2]}`))
	if got := string(st.State("s", "p")); got != `{"handled":{"a":true},"mail":[2]}` {
		t.Fatalf("merged %s", got)
	}
	big := `{"x":"` + strings.Repeat("a", MaxState/2) + `"}`
	if err := st.SetState("s", "p", json.RawMessage(big)); err != nil {
		t.Fatal(err)
	}
	if err := st.SetState("s", "p", json.RawMessage(strings.Replace(big, "x", "y", 1))); !errors.Is(err, ErrTooBig) {
		t.Fatalf("merged past MaxState: %v", err)
	}
	st.SetState("s", "p", json.RawMessage(`null`))
	if st.State("s", "p") != nil {
		t.Fatal("null kept the state")
	}
}
