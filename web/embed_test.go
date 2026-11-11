package web

import (
	"io/fs"
	"regexp"
	"testing"
)

func TestIndexAssetsEmbedded(t *testing.T) {
	index, err := fs.ReadFile(FS, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range regexp.MustCompile(`(?:href|src)="([^":?#]+)"`).FindAllSubmatch(index, -1) {
		if _, err := fs.Stat(FS, string(m[1])); err != nil && string(m[1]) != "/" {
			t.Errorf("index.html links %s, which is not embedded", m[1])
		}
	}
}
