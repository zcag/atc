package history

import (
	"bytes"
	"encoding/base64"
	img "image"
	"image/png"
	"math/rand"
	"strings"
	"testing"
)

func TestDataURLShrinksLargeImage(t *testing.T) {
	pic := img.NewRGBA(img.Rect(0, 0, 900, 900))
	rnd := rand.New(rand.NewSource(1))
	for i := range pic.Pix {
		pic.Pix[i] = byte(rnd.Intn(256))
	}
	var b bytes.Buffer
	png.Encode(&b, pic)
	if base64.StdEncoding.EncodedLen(b.Len()) <= maxImage {
		t.Fatalf("fixture too small: %d", b.Len())
	}
	blk := block{Type: "image"}
	blk.Source = &struct {
		Type      string `json:"type"`
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	}{"base64", "image/png", base64.StdEncoding.EncodeToString(b.Bytes())}
	got := image(blk)
	if !strings.HasPrefix(got, "data:image/jpeg;base64,") || len(got) > maxImage+64 {
		t.Fatalf("got %d bytes, prefix %.30q", len(got), got)
	}
	if small := dataURL("image/png", []byte("tiny")); small != "data:image/png;base64,dGlueQ==" {
		t.Fatalf("small image changed: %q", small)
	}
}
