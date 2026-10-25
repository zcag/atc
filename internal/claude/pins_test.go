package claude

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestKeepAliveWritesPinsOnlyWhenTheyChange(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	path := filepath.Join(dir, "jobs", "pins.json")
	os.MkdirAll(filepath.Dir(path), 0o755)
	os.WriteFile(path, []byte("[]"), 0o644)

	if err := KeepAlive([]string{"f8636676", "a8f32be7"}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != `["a8f32be7","f8636676"]` {
		t.Fatalf("pins = %s", b)
	}
	old := time.Now().Add(-time.Hour)
	os.Chtimes(path, old, old)
	KeepAlive([]string{"a8f32be7", "f8636676"})
	if st, _ := os.Stat(path); !st.ModTime().Equal(old) {
		t.Error("rewrote an unchanged pin list")
	}
	KeepAlive(nil)
	if b, _ := os.ReadFile(path); string(b) != "[]" {
		t.Fatalf("pins after all stopped = %s", b)
	}
}
