package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Message struct {
	Role   string          `json:"role"`
	Text   string          `json:"text,omitempty"`
	Tool   string          `json:"tool,omitempty"`
	Detail string          `json:"detail,omitempty"`
	Time   time.Time       `json:"time,omitzero"`
	ID     string          `json:"id,omitempty"`
	Input  json.RawMessage `json:"input,omitempty"`
	Out    *Output         `json:"out,omitempty"`
	Images []string        `json:"images,omitempty"`
	Model  string          `json:"model,omitempty"`
	Usage  *Usage          `json:"-"`
	Cost   float64         `json:"cost,omitempty"`
	Ms     int64           `json:"ms,omitempty"`
	Badge  *Badge          `json:"badge,omitempty"`
	Look   bool            `json:"look,omitempty"`
}

type Output struct {
	Text   string         `json:"text,omitempty"`
	More   int            `json:"more,omitempty"`
	Error  bool           `json:"error,omitempty"`
	Images []string       `json:"images,omitempty"`
	Meta   map[string]any `json:"meta,omitempty"`
	Time   time.Time      `json:"time,omitzero"`
}

type Usage struct {
	Input, Output, CacheRead, CacheWrite, Write1h int64
}

type Page struct {
	Messages []Message `json:"messages"`
	Start    int64     `json:"start"`
	Size     int64     `json:"size"`
	Done     bool      `json:"done,omitempty"`
}

type rawMsg struct {
	Type          string          `json:"type"`
	Subtype       string          `json:"subtype"`
	DurationMs    int64           `json:"durationMs"`
	IsMeta        bool            `json:"isMeta"`
	IsSidechain   bool            `json:"isSidechain"`
	Timestamp     time.Time       `json:"timestamp"`
	ToolUseResult json.RawMessage `json:"toolUseResult"`
	Attachment    *struct {
		Type   string `json:"type"`
		Prompt string `json:"prompt"`
	} `json:"attachment"`
	Message struct {
		ID      string          `json:"id"`
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
		Usage   *struct {
			Input         int64 `json:"input_tokens"`
			Output        int64 `json:"output_tokens"`
			CacheRead     int64 `json:"cache_read_input_tokens"`
			CacheWrite    int64 `json:"cache_creation_input_tokens"`
			CacheCreation struct {
				Write1h int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	ID        string          `json:"id"`
	ToolUseID string          `json:"tool_use_id"`
	Input     json.RawMessage `json:"input"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
	Source    *struct {
		Type      string `json:"type"`
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	} `json:"source"`
}

const (
	maxOutLines   = 80
	maxInputLines = 240
	maxImage      = 400 << 10
)

func (x *Index) Find(sid string) (Transcript, bool) {
	all := x.Scan()
	for _, t := range all {
		if t.SessionID == sid {
			return t, true
		}
	}
	if from := x.ForkedFrom(sid); from != "" {
		for _, t := range all {
			if t.SessionID == from {
				return t, true
			}
		}
	}
	return Transcript{}, false
}

func (x *Index) ForkedFrom(sid string) string {
	if x.Forks == nil {
		return ""
	}
	return x.Forks()[sid]
}

func (x *Index) Resumed() map[string]bool {
	out := map[string]bool{}
	if x.Forks != nil {
		for _, parent := range x.Forks() {
			out[parent] = true
		}
	}
	return out
}

func ReadPage(path string, before, window int64) (Page, error) {
	f, err := os.Open(path)
	if err != nil {
		return Page{}, err
	}
	defer f.Close()
	st, _ := f.Stat()
	p := Page{Size: st.Size()}
	if before <= 0 || before > p.Size {
		before = p.Size
	}
	p.Start = max(0, before-window)
	f.Seek(p.Start, io.SeekStart)
	r := bufio.NewReaderSize(io.LimitReader(f, before-p.Start), 1<<20)
	if p.Start > 0 {
		skipped, _ := r.ReadBytes('\n')
		p.Start += int64(len(skipped))
	}
	rd := newReader(false)
	rd.read(r, p.Start)
	p.Messages = rd.msgs
	return p, nil
}

func ReadRange(path string, from, to int64) (Page, error) {
	f, err := os.Open(path)
	if err != nil {
		return Page{}, err
	}
	defer f.Close()
	st, _ := f.Stat()
	if to <= 0 || to > st.Size() {
		to = st.Size()
	}
	f.Seek(from, io.SeekStart)
	rd := newReader(false)
	rd.read(bufio.NewReaderSize(io.LimitReader(f, to-from), 1<<20), from)
	return Page{Messages: rd.msgs, Start: from, Size: st.Size()}, nil
}

func ReadAgent(transcript, toolUseID string) (Page, error) {
	metas, _ := filepath.Glob(filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents", "*.meta.json"))
	for _, mp := range metas {
		var meta struct {
			ToolUseID string `json:"toolUseId"`
			Finished  bool   `json:"finished"`
		}
		if b, err := os.ReadFile(mp); err != nil || json.Unmarshal(b, &meta) != nil || meta.ToolUseID != toolUseID {
			continue
		}
		f, err := os.Open(strings.TrimSuffix(mp, ".meta.json") + ".jsonl")
		if err != nil {
			return Page{}, err
		}
		defer f.Close()
		rd := newReader(false)
		rd.sidechain = true
		rd.read(bufio.NewReaderSize(f, 1<<20), 0)
		return Page{Messages: rd.msgs, Done: meta.Finished}, nil
	}
	return Page{}, fmt.Errorf("no subagent transcript for %s", toolUseID)
}

type reader struct {
	msgs      []Message
	offs      []int64
	tools     map[string]int
	billed    map[string]bool
	noImages  bool
	sidechain bool
}

func newReader(noImages bool) *reader {
	return &reader{tools: map[string]int{}, billed: map[string]bool{}, noImages: noImages}
}

func (rd *reader) read(r *bufio.Reader, off int64) int64 {
	for {
		line, err := r.ReadBytes('\n')
		if err != nil && len(line) > 0 && line[len(line)-1] != '\n' {
			return off
		}
		rd.line(line, off)
		off += int64(len(line))
		if err != nil {
			return off
		}
	}
}

func (rd *reader) line(line []byte, off int64) {
	var m rawMsg
	if len(line) < 2 || json.Unmarshal(line, &m) != nil || m.IsMeta || m.IsSidechain != rd.sidechain {
		return
	}
	add := func(x Message) {
		if x.ID != "" {
			rd.tools[x.ID] = len(rd.msgs)
		}
		rd.msgs, rd.offs = append(rd.msgs, x), append(rd.offs, off)
	}
	switch {
	case m.Type == "attachment" && m.Attachment != nil && m.Attachment.Type == "queued_command":
		if x, ok := queued(m.Attachment.Prompt, m.Timestamp); ok {
			add(x)
		}
	case m.Type == "system" && m.Subtype == "turn_duration":
		add(Message{Role: "done", Ms: m.DurationMs, Time: m.Timestamp})
	case m.Type == "user" && rd.results(m):
	default:
		ms := convert(m)
		if m.Type == "assistant" && len(ms) > 0 && m.Message.Usage != nil && !rd.billed[m.Message.ID] {
			rd.billed[m.Message.ID] = true
			u := m.Message.Usage
			ms[0].Model, ms[0].Usage = m.Message.Model, &Usage{u.Input, u.Output, u.CacheRead, u.CacheWrite, u.CacheCreation.Write1h}
		}
		for _, x := range ms {
			if rd.noImages {
				x.Images = nil
			}
			add(x)
		}
	}
}

func (rd *reader) results(m rawMsg) bool {
	var blocks []block
	if json.Unmarshal(m.Message.Content, &blocks) != nil || len(blocks) == 0 || blocks[0].Type != "tool_result" {
		return false
	}
	for _, b := range blocks {
		if i, ok := rd.tools[b.ToolUseID]; ok && b.Type == "tool_result" {
			x := &rd.msgs[i]
			x.Out = output(b, m.ToolUseResult)
			x.Out.Time = m.Timestamp
			x.Badge, x.Look = classify(*x)
			if rd.noImages {
				x.Out.Images = nil
			}
		}
	}
	return true
}

func output(b block, result json.RawMessage) *Output {
	o := &Output{Error: b.IsError}
	var texts []string
	var s string
	var parts []block
	if json.Unmarshal(b.Content, &s) == nil {
		texts = append(texts, s)
	} else if json.Unmarshal(b.Content, &parts) == nil {
		for _, p := range parts {
			if p.Type == "text" {
				texts = append(texts, p.Text)
			} else if img := image(p); img != "" {
				o.Images = append(o.Images, img)
			}
		}
	}
	o.Text, o.More = clipLines(strings.TrimRight(strings.Join(texts, "\n"), "\n"), maxOutLines)
	o.Meta = meta(result)
	return o
}

func meta(raw json.RawMessage) map[string]any {
	var r struct {
		Answers map[string]string `json:"answers"`
		Results []json.RawMessage `json:"results"`
		File    *struct {
			NumLines   int `json:"numLines"`
			StartLine  int `json:"startLine"`
			TotalLines int `json:"totalLines"`
		} `json:"file"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return nil
	}
	m := map[string]any{}
	if len(r.Answers) > 0 {
		m["answers"] = r.Answers
	}
	var hits []map[string]string
	for _, res := range r.Results {
		var x struct {
			Content []struct{ Title, URL string } `json:"content"`
		}
		if json.Unmarshal(res, &x) == nil {
			for _, h := range x.Content {
				if h.URL != "" && len(hits) < 8 {
					hits = append(hits, map[string]string{"title": h.Title, "url": h.URL})
				}
			}
		}
	}
	if len(hits) > 0 {
		m["hits"] = hits
	}
	if r.File != nil && r.File.TotalLines > 0 {
		m["lines"] = r.File.NumLines
		m["total"] = r.File.TotalLines
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

func image(b block) string {
	if b.Type != "image" || b.Source == nil || b.Source.Type != "base64" || len(b.Source.Data) > maxImage {
		return ""
	}
	return "data:" + b.Source.MediaType + ";base64," + b.Source.Data
}

func clipLines(s string, n int) (string, int) {
	lines := strings.Split(s, "\n")
	if len(lines) <= n {
		return s, 0
	}
	return strings.Join(lines[:n], "\n"), len(lines) - n
}

func clipInput(raw json.RawMessage) json.RawMessage {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil {
		return raw
	}
	cut := map[string]int{}
	var walk func(v any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case string:
			s, _ := clipLines(x, maxInputLines)
			return s
		case []any:
			for i := range x {
				x[i] = walk(x[i])
			}
		case map[string]any:
			for k := range x {
				x[k] = walk(x[k])
			}
		}
		return v
	}
	for k, v := range in {
		if s, ok := v.(string); ok {
			var more int
			in[k], more = clipLines(s, maxInputLines)
			if more > 0 {
				cut[k] = more
			}
		} else {
			in[k] = walk(v)
		}
	}
	if len(cut) > 0 {
		in["_cut"] = cut
	}
	out, _ := json.Marshal(in)
	return out
}

var notice = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)

var pastedTag = regexp.MustCompile(`</?pasted_content[^>]*>\n?`)

func unpaste(t string) string { return pastedTag.ReplaceAllString(t, "") }

func queued(text string, at time.Time) (Message, bool) {
	t := strings.TrimSpace(unpaste(text))
	switch {
	case t == "":
		return Message{}, false
	case strings.HasPrefix(t, "<task-notification>"):
		return Message{Role: "event", Text: noticeText(t), Time: at}, true
	case IsNoise(t):
		return Message{}, false
	}
	return Message{Role: "note", Text: t, Time: at}, true
}

func noticeText(t string) string {
	if sm := notice.FindStringSubmatch(t); sm != nil {
		return strings.TrimSpace(sm[1])
	}
	return "A background task finished"
}

func convert(m rawMsg) []Message {
	if m.Type != "user" && m.Type != "assistant" {
		return nil
	}
	var blocks []block
	var s string
	if json.Unmarshal(m.Message.Content, &s) == nil {
		blocks = []block{{Type: "text", Text: s}}
	} else if json.Unmarshal(m.Message.Content, &blocks) != nil {
		return nil
	}
	var out []Message
	var images []string
	for _, b := range blocks {
		switch {
		case b.Type == "text" && strings.TrimSpace(b.Text) != "":
			if m.Type == "user" && strings.HasPrefix(strings.TrimSpace(b.Text), "<task-notification>") {
				out = append(out, Message{Role: "event", Text: noticeText(b.Text), Time: m.Timestamp})
				continue
			}
			if m.Type == "user" && IsNoise(b.Text) {
				continue
			}
			text := b.Text
			if m.Type == "user" {
				text = strings.TrimSpace(unpaste(text))
			}
			out = append(out, Message{Role: m.Type, Text: text, Time: m.Timestamp})
		case b.Type == "image" && m.Type == "user":
			if img := image(b); img != "" {
				images = append(images, img)
			}
		case b.Type == "tool_use":
			out = append(out, Message{Role: "tool", Tool: b.Name, Detail: Detail(b.Input), Time: m.Timestamp, ID: b.ID, Input: clipInput(b.Input)})
		}
	}
	if len(images) > 0 {
		for i := range out {
			if out[i].Role == "user" {
				out[i].Images = images
				return out
			}
		}
		out = append(out, Message{Role: "user", Images: images, Time: m.Timestamp})
	}
	return out
}

func IsNoise(t string) bool {
	t = strings.TrimSpace(t)
	for _, p := range []string{"<system-reminder>", "<local-command", "<command-name>", "<command-message>", "<task-notification>", "Caveat:", "[Request interrupted"} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

func Detail(raw json.RawMessage) string {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil {
		return ""
	}
	if qs, ok := in["questions"].([]any); ok && len(qs) > 0 {
		if q, ok := qs[0].(map[string]any); ok {
			var labels []string
			opts, _ := q["options"].([]any)
			for _, o := range opts {
				if m, ok := o.(map[string]any); ok {
					if l, ok := m["label"].(string); ok && l != "" {
						labels = append(labels, l)
					}
				}
			}
			v, _ := q["question"].(string)
			if len(labels) > 0 {
				v += " (" + strings.Join(labels, " · ") + ")"
			}
			return oneLine(v)
		}
	}
	if plan, ok := in["plan"].(string); ok {
		for _, l := range strings.Split(plan, "\n") {
			if l = strings.TrimSpace(strings.TrimLeft(l, "# ")); l != "" {
				return oneLine(l)
			}
		}
	}
	for _, k := range []string{"description", "command", "file_path", "filePath", "pattern", "url", "query", "prompt", "skill"} {
		if v, ok := in[k].(string); ok && v != "" {
			return oneLine(v)
		}
	}
	return ""
}

func oneLine(v string) string { return clip(strings.Join(strings.Fields(v), " "), 160) }

func Reply(path, id string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if st, _ := f.Stat(); st.Size() > 8<<20 {
		f.Seek(-8<<20, io.SeekEnd)
	}
	r := bufio.NewReaderSize(f, 1<<20)
	needle := []byte(`"uuid":"` + id + `"`)
	for {
		line, err := r.ReadBytes('\n')
		var m rawMsg
		if bytes.Contains(line, needle) && json.Unmarshal(line, &m) == nil {
			var texts []string
			for _, x := range convert(m) {
				if x.Role == "assistant" {
					texts = append(texts, x.Text)
				}
			}
			return strings.Join(texts, "\n\n"), nil
		}
		if err != nil {
			return "", fmt.Errorf("message %s is not in the transcript", id)
		}
	}
}

func LastAsk(path string) map[string]bool {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if st, _ := f.Stat(); st.Size() > 2<<20 {
		f.Seek(-2<<20, io.SeekEnd)
	}
	multi := map[string]bool{}
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if bytes.Contains(line, []byte(`"AskUserQuestion"`)) {
			var m rawMsg
			var blocks []block
			if json.Unmarshal(line, &m) == nil && json.Unmarshal(m.Message.Content, &blocks) == nil {
				for _, b := range blocks {
					var in struct {
						Questions []struct {
							Question    string `json:"question"`
							MultiSelect bool   `json:"multiSelect"`
						} `json:"questions"`
					}
					if b.Type == "tool_use" && b.Name == "AskUserQuestion" && json.Unmarshal(b.Input, &in) == nil {
						for _, q := range in.Questions {
							multi[q.Question] = q.MultiSelect
						}
					}
				}
			}
		}
		if err != nil {
			return multi
		}
	}
}
