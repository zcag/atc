package server

import (
	"os"
	"strings"
	"testing"
)

func TestSaveUploadKeepsSameNameFiles(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	paths := map[string]string{}
	for _, body := range []string{"one", "two", "three"} {
		path, err := saveUpload("shared", "image.png", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		paths[path] = body
	}
	if len(paths) != 3 {
		t.Fatalf("three uploads landed in %d files: %v", len(paths), paths)
	}
	for path, want := range paths {
		if got, _ := os.ReadFile(path); string(got) != want {
			t.Errorf("%s holds %q, want %q", path, got, want)
		}
	}
}
