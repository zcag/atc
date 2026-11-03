package whatsapp

import "testing"

func TestMediaKind(t *testing.T) {
	for _, c := range []struct {
		mime string
		size int
		ptt  bool
		want string
	}{
		{"image/jpeg", 1 << 20, false, "image"},
		{"image/png; charset=binary", 1 << 10, false, "image"},
		{"image/vnd.dwg", 1 << 20, false, "document"},
		{"image/svg+xml", 1 << 10, false, "document"},
		{"image/jpeg", 6 << 20, false, "document"},
		{"video/mp4", 1 << 20, false, "video"},
		{"video/x-matroska", 1 << 20, false, "document"},
		{"audio/ogg", 1 << 10, false, "audio"},
		{"application/octet-stream", 1 << 10, true, "audio"},
		{"application/pdf", 1 << 10, false, "document"},
	} {
		if got := mediaKind(c.mime, c.size, c.ptt); got != c.want {
			t.Errorf("mediaKind(%q, %d, %v) = %q, want %q", c.mime, c.size, c.ptt, got, c.want)
		}
	}
}
