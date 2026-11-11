package pages

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPins(t *testing.T) {
	root := t.TempDir()
	st, _ := Open("")
	if _, _, err := st.NewPin("x"); !errors.Is(err, ErrNoPins) {
		t.Fatalf("pins off: %v", err)
	}
	st.PinAt(filepath.Join(root, "pinned"))
	if _, _, err := st.NewPin("Bad Name"); err == nil {
		t.Fatal("a name that is not a slug is refused")
	}
	dir, created, err := st.NewPin("sheet")
	if err != nil || !created {
		t.Fatal(created, err)
	}
	if len(st.Of(Pinned)) != 0 {
		t.Fatal("a pin without an index.html does not show yet")
	}
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<title>Sheet</title>"), 0o644)
	if again, created, _ := st.NewPin("sheet"); again != dir || created {
		t.Fatal("an existing name gives its folder")
	}
	list := st.Of(Pinned)
	if len(list) != 1 || list[0].Title != "Sheet" || list[0].Unpinned {
		t.Fatalf("%+v", list)
	}
	if err := st.SetState(Pinned, "sheet", json.RawMessage(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := st.DeletePin("sheet"); err == nil {
		t.Fatal("a pinned page is not deleted")
	}
	if err := st.SetPinned("sheet", false); err != nil {
		t.Fatal(err)
	}
	if l := st.Of(Pinned); len(l) != 1 || !l[0].Unpinned {
		t.Fatalf("unpinned stays listed: %+v", l)
	}
	if _, _, err := st.NewPin("sheet"); err == nil {
		t.Fatal("an unpinned name is not made again")
	}
	if err := st.SetPinned("sheet", true); err != nil || st.Of(Pinned)[0].Unpinned {
		t.Fatal("pin brings it back", err)
	}
	st.SetPinned("sheet", false)
	if err := st.DeletePin("sheet"); err != nil {
		t.Fatal(err)
	}
	if len(st.Of(Pinned)) != 0 || st.State(Pinned, "sheet") != nil {
		t.Fatal("delete removes the folder and its state")
	}
}
