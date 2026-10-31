package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

type Turn struct {
	From    int64        `json:"from"`
	To      int64        `json:"to"`
	At      time.Time    `json:"at,omitzero"`
	End     time.Time    `json:"end,omitzero"`
	Prompt  string       `json:"prompt"`
	Images  int          `json:"images,omitempty"`
	Partial bool         `json:"partial,omitempty"`
	Notice  bool         `json:"notice,omitempty"`
	Reply   string       `json:"reply,omitempty"`
	Steps   int          `json:"steps"`
	Looks   int          `json:"looks,omitempty"`
	Failed  int          `json:"failed,omitempty"`
	Files   []FileChange `json:"files,omitempty"`
	Badges  []Badge      `json:"badges,omitempty"`
	Asks    int          `json:"asks,omitempty"`
	Notes   []string     `json:"notes,omitempty"`
	Cost    float64      `json:"cost,omitempty"`
	Ms      int64        `json:"ms,omitempty"`
}

type FileChange struct {
	Path string `json:"path"`
	Add  int    `json:"add"`
	Del  int    `json:"del"`
}

type turnCache struct {
	size  int64
	mod   time.Time
	turns []Turn
}

const maxReply = 600

func BuildTurns(msgs []Message, offs []int64, end int64, price func(string, Usage) float64) []Turn {
	var turns []Turn
	var cur *Turn
	open := func(m Message, off int64, partial bool) {
		if cur != nil {
			cur.To = off
		}
		turns = append(turns, Turn{From: off, At: m.Time, End: m.Time, Partial: partial})
		cur = &turns[len(turns)-1]
	}
	replyFrom, ended := false, false
	for i, m := range msgs {
		off := offs[i]
		if m.Role == "user" || m.Role == "event" && (ended || cur == nil) {
			open(m, off, false)
			cur.Prompt, cur.Images, cur.Notice = clip(m.Text, 2000), len(m.Images), m.Role == "event"
			replyFrom, ended = false, false
			continue
		}
		ended = m.Role == "done"
		if cur == nil {
			open(m, off, true)
		}
		if !m.Time.IsZero() {
			cur.End = m.Time
		}
		if m.Usage != nil && price != nil {
			cur.Cost += price(m.Model, *m.Usage)
		}
		switch m.Role {
		case "note":
			cur.Notes = append(cur.Notes, clip(m.Text, 300))
		case "done":
			cur.Ms = max(cur.Ms, m.Ms)
		case "assistant":
			if replyFrom {
				cur.Reply = clip(strings.TrimSpace(cur.Reply+"\n\n"+m.Text), maxReply)
			} else {
				cur.Reply, replyFrom = clip(m.Text, maxReply), true
			}
		case "tool":
			replyFrom = false
			cur.Reply = ""
			cur.Steps++
			if m.Look {
				cur.Looks++
			}
			if m.Out != nil && m.Out.Error {
				cur.Failed++
			}
			if m.Tool == "AskUserQuestion" {
				cur.Asks++
			}
			if m.Badge != nil {
				cur.Badges = append(cur.Badges, *m.Badge)
			}
			if fc, ok := fileChange(m); ok {
				cur.Files = mergeFile(cur.Files, fc)
			}
		}
	}
	if cur != nil {
		cur.To = end
	}
	return turns
}

func fileChange(m Message) (FileChange, bool) {
	if m.Out != nil && m.Out.Error {
		return FileChange{}, false
	}
	var in struct {
		FilePath  string `json:"file_path"`
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
		Content   string `json:"content"`
		Edits     []struct {
			OldString string `json:"old_string"`
			NewString string `json:"new_string"`
		} `json:"edits"`
		Cut map[string]int `json:"_cut"`
	}
	json.Unmarshal(m.Input, &in)
	if in.FilePath == "" {
		return FileChange{}, false
	}
	fc := FileChange{Path: in.FilePath}
	switch m.Tool {
	case "Write":
		fc.Add = lines(in.Content) + in.Cut["content"]
	case "Edit":
		fc.Add, fc.Del = lines(in.NewString)+in.Cut["new_string"], lines(in.OldString)+in.Cut["old_string"]
	case "MultiEdit":
		for _, e := range in.Edits {
			fc.Add, fc.Del = fc.Add+lines(e.NewString), fc.Del+lines(e.OldString)
		}
	default:
		return FileChange{}, false
	}
	return fc, true
}

func lines(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}

func mergeFile(fs []FileChange, fc FileChange) []FileChange {
	for i := range fs {
		if fs[i].Path == fc.Path {
			fs[i].Add, fs[i].Del = fs[i].Add+fc.Add, fs[i].Del+fc.Del
			return fs
		}
	}
	return append(fs, fc)
}

func (x *Index) Turns(path string) ([]Turn, int64, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	x.mu.Lock()
	c := x.turns[path]
	x.mu.Unlock()
	if c != nil && c.size == st.Size() && c.mod.Equal(st.ModTime()) {
		return c.turns, c.size, nil
	}
	var keep []Turn
	from := int64(0)
	if c != nil && st.Size() > c.size && len(c.turns) > 0 {
		keep = c.turns[:len(c.turns)-1]
		from = c.turns[len(c.turns)-1].From
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	f.Seek(from, io.SeekStart)
	rd := newReader(true)
	end := rd.read(bufio.NewReaderSize(f, 1<<20), from)
	fresh := BuildTurns(rd.msgs, rd.offs, end, x.Price)
	if len(keep) > 0 && len(fresh) > 0 && fresh[0].Partial {
		fresh[0].Partial = false
	}
	turns := append(append([]Turn{}, keep...), fresh...)
	x.mu.Lock()
	if x.turns == nil {
		x.turns = map[string]*turnCache{}
	}
	x.turns[path] = &turnCache{size: end, mod: st.ModTime(), turns: turns}
	x.mu.Unlock()
	return turns, end, nil
}

type Hit struct {
	Turn int    `json:"turn"`
	Text string `json:"text"`
}

func Search(path, q string, turns []Turn, limit int) ([]Hit, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	needle := []byte(strings.ToLower(q))
	r := bufio.NewReaderSize(f, 1<<20)
	var hits []Hit
	off, t := int64(0), 0
	for len(hits) < limit {
		line, err := r.ReadBytes('\n')
		for t+1 < len(turns) && turns[t+1].From <= off {
			t++
		}
		if len(line) < 4<<20 && bytes.Contains(bytes.ToLower(line), needle) {
			rd := newReader(true)
			rd.line(line, off)
			for _, m := range rd.msgs {
				for _, s := range []string{m.Text, m.Detail} {
					if i := strings.Index(strings.ToLower(s), string(needle)); i >= 0 {
						hits = append(hits, Hit{Turn: t, Text: snippet(s, i, len(needle))})
						break
					}
				}
			}
		}
		off += int64(len(line))
		if err != nil {
			break
		}
	}
	return hits, nil
}

func snippet(s string, i, n int) string {
	from, to := max(0, i-70), min(len(s), i+n+90)
	for from > 0 && !utf8Start(s[from]) {
		from--
	}
	for to < len(s) && !utf8Start(s[to]) {
		to++
	}
	out := strings.Join(strings.Fields(s[from:to]), " ")
	if from > 0 {
		out = "…" + out
	}
	if to < len(s) {
		out += "…"
	}
	return out
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
