package pair

import (
	"fmt"
	"strings"

	"rsc.io/qr"
)

const quiet = 4

func code(text string) (*qr.Code, error) { return qr.Encode(text, qr.M) }

// SVG draws a QR code, always dark on white: scanners don't read it inverted.
func SVG(text string) (string, error) {
	c, err := code(text)
	if err != nil {
		return "", err
	}
	n := c.Size + 2*quiet
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="%d" height="%d" fill="#fff"/><path fill="#000" d="`, n, n, n, n)
	for y := range c.Size {
		for x := range c.Size {
			if c.Black(x, y) {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x+quiet, y+quiet)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String(), nil
}

// Terminal draws a QR code in half blocks, two modules to a character, with explicit colours so a
// dark and a light terminal print the same thing.
func Terminal(text string) (string, error) {
	c, err := code(text)
	if err != nil {
		return "", err
	}
	black := func(x, y int) bool { return c.Black(x-quiet, y-quiet) }
	n := c.Size + 2*quiet
	var b strings.Builder
	for y := 0; y < n; y += 2 {
		b.WriteString("\x1b[38;5;16;48;5;231m")
		for x := range n {
			top, bottom := black(x, y), y+1 < n && black(x, y+1)
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString("\x1b[0m\n")
	}
	return b.String(), nil
}
