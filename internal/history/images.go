package history

import (
	"bytes"
	"encoding/base64"
	img "image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// dataURL inlines an image the transcript shows. One over maxImage is re-encoded as a JPEG, halved until it fits, so a
// large screenshot is shown smaller rather than left out.
func dataURL(mediaType string, raw []byte) string {
	if base64.StdEncoding.EncodedLen(len(raw)) <= maxImage {
		return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(raw)
	}
	pic, _, err := img.Decode(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	for pic.Bounds().Dx() >= 64 {
		var b bytes.Buffer
		if jpeg.Encode(&b, pic, &jpeg.Options{Quality: 82}) != nil {
			return ""
		}
		if base64.StdEncoding.EncodedLen(b.Len()) <= maxImage {
			return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(b.Bytes())
		}
		r := pic.Bounds()
		half := img.NewRGBA(img.Rect(0, 0, r.Dx()/2, r.Dy()/2))
		draw.ApproxBiLinear.Scale(half, half.Bounds(), pic, r, draw.Src, nil)
		pic = half
	}
	return ""
}
