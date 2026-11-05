// A scripted call line for the demo: it answers atc's app line, plays one conversation's persona
// events on a loop, and sends a synthetic voice while the assistant "speaks", so the call screen moves
// as on a real call. No speech recognition, no voice model, no hub.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type beat struct {
	state, you, tool, said string
	secs                   float64
}

var script = []beat{
	{state: "listening", secs: 2},
	{state: "hearing", you: "Anything I need to deal with before the release goes out?", secs: 4},
	{state: "tool", tool: "mcp__atc__status", secs: 2},
	{state: "speaking", said: "Two things. The release is waiting for your okay to push the tag, and the coupon session wants to know whether discounts apply before shipping. Everything else is moving.", secs: 11},
	{state: "hearing", you: "Goods only. And tell the release one to go ahead.", secs: 4},
	{state: "tool", tool: "mcp__atc__send", secs: 2},
	{state: "speaking", said: "Done. Coupons discount goods only, and v0.9.0 is pushing now. I'll ring you if CI goes red.", secs: 7},
}

const outRate, frameMs = 24000, 20

// voice is 20 ms of something speech-shaped: a pitched buzz gated into syllables, so loudness moves like a voice.
func voice(t float64) []byte {
	n := outRate * frameMs / 1000
	b := make([]byte, n*2)
	for i := 0; i < n; i++ {
		x := t + float64(i)/outRate
		syllable := math.Pow(math.Max(0, math.Sin(x*2*math.Pi*2.3)), .6) * (.55 + .45*math.Sin(x*2*math.Pi*.31))
		s := 0.0
		for h := 1.0; h <= 6; h++ {
			s += math.Sin(x*2*math.Pi*138*h) / h
		}
		binary.LittleEndian.PutUint16(b[i*2:], uint16(int16(s*syllable*7000)))
	}
	return b
}

func play(ctx context.Context, c *websocket.Conn) {
	send := func(v map[string]any) { b, _ := json.Marshal(v); c.Write(ctx, websocket.MessageText, b) }
	send(map[string]any{"event": "active"})
	for start := time.Now(); ctx.Err() == nil; {
		for _, b := range script {
			switch b.state {
			case "hearing":
				words := strings.Fields(b.you)
				for i := range words {
					send(map[string]any{"event": "persona", "state": "hearing", "hearing": strings.Join(words[:i+1], " ")})
					time.Sleep(time.Duration(b.secs / float64(len(words)) * float64(time.Second)))
				}
				send(map[string]any{"event": "persona", "state": "thinking", "you": b.you, "hearing": ""})
				continue
			case "speaking":
				send(map[string]any{"event": "persona", "state": "speaking", "said": b.said})
				for end := time.Now().Add(time.Duration(b.secs * float64(time.Second))); time.Now().Before(end) && ctx.Err() == nil; {
					c.Write(ctx, websocket.MessageBinary, voice(time.Since(start).Seconds()))
					time.Sleep(frameMs * time.Millisecond)
				}
				continue
			default:
				send(map[string]any{"event": "persona", "state": b.state, "tool": b.tool})
			}
			time.Sleep(time.Duration(b.secs * float64(time.Second)))
		}
	}
}

func main() {
	http.HandleFunc("/app", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		for {
			typ, b, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageText && strings.Contains(string(b), `"call"`) {
				go play(ctx, c)
			}
		}
	})
	log.Fatal(http.ListenAndServe(os.Args[1], nil))
}
