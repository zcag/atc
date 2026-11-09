package claude

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOutputs(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	dir := filepath.Join(tmp, "claude-1000", "-home-x-proj", "sess-1", "tasks")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "b1.output"), []byte("building\nstep 1/4\rstep 2/4\rstep 3/4\n\nall done\n\n[exited with code 2]\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "m1.output"), []byte(`{"status":"PREPARING"}`+"\n"), 0o644)
	os.Symlink("/nowhere/agent.jsonl", filepath.Join(dir, "a1.output"))

	got := Outputs("sess-1", 2, "")
	if len(got) != 2 {
		t.Fatalf("an agent's output is its transcript, not a tail: %+v", got)
	}
	b := got["b1"]
	if !reflect.DeepEqual(b.Lines, []string{"step 3/4", "all done"}) || b.Exit == nil || *b.Exit != 2 {
		t.Fatalf("%+v", b)
	}
	if m := got["m1"]; !reflect.DeepEqual(m.Lines, []string{`{"status":"PREPARING"}`}) || m.Exit != nil {
		t.Fatalf("a monitor still running: %+v", m)
	}
	if only := Outputs("sess-1", 40, "m1"); len(only) != 1 {
		t.Fatalf("%+v", only)
	}
}
