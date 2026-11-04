package caps

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const root = "../.."

var (
	heading  = regexp.MustCompile(`(?m)^#{1,6} +(.+?) *$`)
	mdLink   = regexp.MustCompile(`\]\(([^)\s]+)\)`)
	notInURL = regexp.MustCompile(`[^\p{L}\p{N} _-]`)
)

// anchors are the heading ids GitHub makes for a Markdown file.
func anchors(t *testing.T, path string) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, m := range heading.FindAllStringSubmatch(string(b), -1) {
		text := strings.ReplaceAll(m[1], "`", "")
		out[strings.ReplaceAll(strings.ToLower(notInURL.ReplaceAllString(text, "")), " ", "-")] = true
	}
	return out
}

func TestEveryGuideExistsInDocs(t *testing.T) {
	for _, c := range All() {
		g := c.Fix.Guide
		if g == "" {
			continue
		}
		page, anchor, _ := strings.Cut(g, "#")
		path := filepath.Join(root, "docs", page+".md")
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s: guide %q: no page %s", c.ID, g, path)
			continue
		}
		if anchor != "" && !anchors(t, path)[anchor] {
			t.Errorf("%s: guide %q: no such heading in %s", c.ID, g, path)
		}
	}
}

func TestDocsLinksResolve(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(root, "docs", "*.md"))
	files = append(files, filepath.Join(root, "README.md"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range mdLink.FindAllStringSubmatch(string(b), -1) {
			link := m[1]
			if strings.Contains(link, "://") {
				continue
			}
			target, anchor, _ := strings.Cut(link, "#")
			path := f
			if target != "" {
				path = filepath.Join(filepath.Dir(f), target)
			}
			if _, err := os.Stat(path); err != nil {
				t.Errorf("%s: link %s: no such file", f, link)
				continue
			}
			if anchor != "" && !anchors(t, path)[anchor] {
				t.Errorf("%s: link %s: no such heading", f, link)
			}
		}
	}
}

func TestGuideURL(t *testing.T) {
	if got, want := GuideURL("install#requirements"), "https://github.com/zcag/atc/blob/master/docs/install.md#requirements"; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
	if got, want := GuideURL("calls"), "https://github.com/zcag/atc/blob/master/docs/calls.md"; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
	if got := GuideName("install#run-it-as-a-service"); got != "Run it as a service" {
		t.Error(got)
	}
	if got := GuideName("calls"); got != "Calls" {
		t.Error(got)
	}
}
