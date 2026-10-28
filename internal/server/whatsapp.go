package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/store"
	"github.com/zcag/atc/internal/whatsapp"
)

const waName = "whatsapp"

const waPrompt = `This conversation happens over WhatsApp: the user writes to you from their phone, and atc sends every reply you write ` +
	`to them as WhatsApp messages. Write for a phone screen: short paragraphs, the answer first. Write Markdown as usual; atc converts it ` +
	`(bold, italic, strikethrough, code, lists, quotes, links; headings become bold lines). A Markdown table is sent as an image, so use one ` +
	`when something really is tabular, and long code is sent as a file. Every text you write while working goes out as its own message ` +
	`as soon as you write it, so don't narrate each step; write when there is something worth reading. ` +
	"To send a file, image, screenshot, PDF, a rendered HTML page or a voice note, run `atc wa` (`atc wa -h`); never use it for plain " +
	`text, which your reply delivers anyway. What the user sends arrives as text: photos, documents and other files as the path of the ` +
	`saved file (read it), voice notes already transcribed (they may hear a spoken summary of your reply back), locations as coordinates, ` +
	`and a reply to an earlier message with that message quoted first. Nobody can answer a dialog from WhatsApp, so ask in plain text, ` +
	`and when you offer choices, number them so a number answers. The user can send /new for a fresh conversation and /stop to interrupt you. ` +
	switchboard

type waChat struct {
	mu   sync.Mutex
	seen map[string]time.Time
	turn *waTurn

	out    sync.Mutex
	sentAt time.Time
}

type waTurn struct {
	id, sid, path string
	off           int64
	asks          []waMsg
	typed         int
	typedAt       time.Time
	voice         bool
}

type waMsg struct{ chat, id string }

func (c *waChat) first(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, at := range c.seen {
		if time.Since(at) > time.Hour {
			delete(c.seen, k)
		}
	}
	if _, ok := c.seen[id]; ok {
		return false
	}
	c.seen[id] = time.Now()
	return true
}

func (s *Server) startWhatsApp() {
	s.wa = &waChat{seen: map[string]time.Time{}}
	go func() {
		for try := range 10 {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			err := s.WhatsApp.EnsureHook(ctx)
			cancel()
			if err == nil {
				log.Printf("whatsapp: webhook ready at %s", cmp.Or(s.WhatsApp.Hook, "(not registered by atc)"))
				return
			}
			log.Printf("whatsapp: webhook: %v", err)
			time.Sleep(time.Duration(try+1) * 30 * time.Second)
		}
	}()
}

func (s *Server) waHook(w http.ResponseWriter, r *http.Request) {
	if s.WhatsApp == nil {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !s.WhatsApp.Verify(body, r.Header.Get("X-OpenWA-Signature")) {
		log.Printf("whatsapp: refused a delivery with a bad signature from %s", r.RemoteAddr)
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	var ev whatsapp.Event
	if err := json.Unmarshal(body, &ev); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusOK)
	if ev.Event == "message.received" {
		go s.waReceive(ev)
	}
}

func (s *Server) waReceive(ev whatsapp.Event) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	d, wa := ev.Data, s.WhatsApp
	if d.FromMe || d.IsGroup || d.Kind != "" && d.Kind != "individual" || !wa.IsOwner(ctx, d.From, d.SenderPhone) {
		log.Printf("whatsapp: ignored a %s message from %s", d.Type, d.From)
		return
	}
	if strings.TrimSpace(d.Body) == "" && d.Media == nil && d.Location == nil {
		log.Printf("whatsapp: skipped an empty %s message", d.Type)
		return
	}
	if !s.wa.first(d.ID) {
		return
	}
	msg := waMsg{cmp.Or(d.ChatID, d.From), d.ID}
	wa.Read(ctx, msg.chat)
	var err error
	switch strings.ToLower(strings.TrimSpace(d.Body)) {
	case "/new":
		err = s.waNew(ctx, msg)
	case "/stop":
		err = s.waStop(ctx, msg)
	default:
		wa.React(ctx, msg.chat, msg.id, "⏳")
		var text string
		var voice bool
		if text, voice, err = s.waPrompt(ctx, ev); err == nil {
			err = s.waType(ctx, msg, text, voice)
		}
	}
	if err != nil {
		log.Printf("whatsapp: %v", err)
		wa.React(ctx, msg.chat, msg.id, "❗")
		s.waText(ctx, "⚠️ "+err.Error())
	}
}

func (s *Server) waPrompt(ctx context.Context, ev whatsapp.Event) (string, bool, error) {
	d := ev.Data
	var b strings.Builder
	if q := d.Quoted; q != nil && strings.TrimSpace(q.Body) != "" {
		for _, l := range strings.Split(clipRunes(strings.TrimSpace(q.Body), 600), "\n") {
			b.WriteString("> " + l + "\n")
		}
		b.WriteString("\n")
	}
	voice := false
	switch {
	case d.Location != nil:
		l := d.Location
		fmt.Fprintf(&b, "[location: %.6f,%.6f %s]\n", l.Latitude, l.Longitude, strings.TrimSpace(l.Description+" "+l.Address))
	case d.Media != nil:
		data, mt, err := s.waMedia(ctx, ev)
		if err != nil {
			return "", false, fmt.Errorf("could not fetch the %s: %w", d.Type, err)
		}
		if (d.Type == "voice" || d.Type == "audio") && s.Voice.STT != "" {
			text, _, err := s.transcribe(ctx, data, "voice"+extFor(mt))
			if err == nil && text != "" {
				voice = d.Type == "voice"
				fmt.Fprintf(&b, "[voice note] %s\n", text)
				break
			}
			log.Printf("whatsapp: transcribe: %v", err)
		}
		path, err := saveUpload(waName, cmp.Or(d.Media.Filename, d.Type+extFor(mt)), bytes.NewReader(data))
		if err != nil {
			return "", false, err
		}
		fmt.Fprintf(&b, "[%s: %s]\n", d.Type, path)
	}
	if d.Type != "location" {
		b.WriteString(d.Body)
	}
	text := strings.TrimSpace(b.String())
	if text == "" {
		return "", false, fmt.Errorf("a %s message atc can't pass on", d.Type)
	}
	return text, voice, nil
}

func (s *Server) waMedia(ctx context.Context, ev whatsapp.Event) ([]byte, string, error) {
	m := ev.Data.Media
	if m.Data != "" && !m.Omitted {
		b, err := base64.StdEncoding.DecodeString(m.Data)
		return b, m.Mimetype, err
	}
	b, mt, err := s.WhatsApp.Download(ctx, cmp.Or(ev.Data.ChatID, ev.Data.From), ev.Data.ID)
	return b, cmp.Or(m.Mimetype, mt), err
}

func extFor(mt string) string {
	mt, _, _ = strings.Cut(mt, ";")
	switch mt {
	case "audio/ogg":
		return ".ogg"
	case "image/jpeg":
		return ".jpg"
	}
	if exts, _ := mime.ExtensionsByType(mt); len(exts) > 0 {
		return exts[0]
	}
	return ""
}

// waType types a message into the whatsapp session and makes sure a pump is relaying what
// it writes back; messages sent while it works join the turn already being relayed.
func (s *Server) waType(ctx context.Context, msg waMsg, text string, voice bool) error {
	id, err := s.keep(ctx, waName, false)
	if err != nil {
		return fmt.Errorf("could not open the whatsapp session: %w", err)
	}
	x, err := s.waReady(ctx, id)
	if err != nil {
		return err
	}
	if s.M.Store.Get(x.SessionID).Name == "" {
		s.M.Store.Update(x.SessionID, func(m *store.Meta) { m.Name, m.Parked = waName, true })
	}
	s.wa.mu.Lock()
	t := s.wa.turn
	if t == nil || t.id != id {
		t = &waTurn{id: id, sid: x.SessionID}
		if tr, ok := s.M.Index.Find(x.SessionID); ok {
			t.path = tr.Path
			if st, err := os.Stat(tr.Path); err == nil {
				t.off = st.Size()
			}
		}
		s.wa.turn = t
		go s.waPump(t)
	}
	t.asks, t.voice, t.typedAt, t.typed = append(t.asks, msg), t.voice || voice, time.Now(), t.typed+1
	s.wa.mu.Unlock()
	return s.Term.Send(ctx, id, text)
}

func (s *Server) waReady(ctx context.Context, id string) (sessions.Session, error) {
	for range 40 {
		if x, ok := s.waSession(ctx, id); ok && x.Attachable && x.SessionID != "" {
			return x, nil
		}
		time.Sleep(1500 * time.Millisecond)
	}
	return sessions.Session{}, errors.New("the whatsapp session did not come up")
}

func (s *Server) waSession(ctx context.Context, id string) (sessions.Session, bool) {
	list, err := s.M.Live(ctx)
	if err != nil {
		return sessions.Session{}, false
	}
	for _, x := range list {
		if x.ID == id {
			return x, true
		}
	}
	return sessions.Session{}, false
}

const (
	waTick     = 1500 * time.Millisecond
	waTyping   = 20 * time.Second
	waQuiet    = 45 * time.Second
	waSettle   = 30 * time.Second
	waLongest  = 6 * time.Hour
	waGap      = 800 * time.Millisecond
	waRenderPx = 480
)

// waPump follows one turn of the whatsapp session: it sends each reply text as it lands in
// the transcript, keeps the typing indicator up, shows a status line edited in place while
// a turn runs quiet for long, and ticks the user's messages when the turn ends.
func (s *Server) waPump(t *waTurn) {
	ctx := context.Background()
	wa := s.WhatsApp
	began := time.Now()
	var typingAt, statusAt, lastOut, doneAt, idleSince, askedAt time.Time
	seen := 0
	var status, shown, last string
	lastOut = began
	for {
		time.Sleep(waTick)
		x, ok := s.waSession(ctx, t.id)
		if tr, found := s.M.Index.Find(t.sid); found && tr.Path != t.path {
			t.path = tr.Path
		}
		if t.path != "" {
			if p, err := history.ReadRange(t.path, t.off, 0); err == nil {
				t.off = p.End
				for _, m := range p.Messages {
					switch {
					case m.Role == "assistant" && strings.TrimSpace(m.Text) != "":
						s.waReply(ctx, m.Text)
						last, lastOut = m.Text, time.Now()
					case m.Role == "user":
						seen, askedAt = seen+1, cmp.Or(m.Time, time.Now())
					case m.Role == "done":
						doneAt = cmp.Or(m.Time, time.Now())
					}
				}
			}
		}
		working := ok && x.State == sessions.Working
		if working {
			idleSince = time.Time{}
			if time.Since(typingAt) > waTyping {
				wa.Typing(ctx, "typing")
				typingAt = time.Now()
			}
			if act := clipRunes(oneLine(x.Activity), 120); act != "" && time.Since(lastOut) > waQuiet {
				line := "⏳ " + act
				switch {
				case status == "":
					status, _ = s.waText(ctx, line)
					shown, statusAt = act, time.Now()
				case act != shown && time.Since(statusAt) > 15*time.Second:
					wa.Edit(ctx, status, line)
					shown, statusAt = act, time.Now()
				}
			}
		} else if idleSince.IsZero() {
			idleSince = time.Now()
		}
		s.wa.mu.Lock()
		needs := ok && x.State == sessions.NeedsYou
		finished := needs || !working && seen >= t.typed && doneAt.After(askedAt) ||
			!working && time.Since(idleSince) > waSettle && time.Since(t.typedAt) > waSettle ||
			time.Since(t.typedAt) > waLongest
		if !finished {
			s.wa.mu.Unlock()
			continue
		}
		asks, voice := t.asks, t.voice
		s.wa.turn = nil
		s.wa.mu.Unlock()

		wa.Typing(ctx, "paused")
		mark := "✅"
		if needs {
			mark = "❓"
			s.waText(ctx, "⚠️ The session is waiting on something only atc can answer: "+clipRunes(oneLine(x.Activity), 300)+"\nOpen it in atc.")
		}
		if status != "" {
			wa.Edit(ctx, status, "✓ worked "+time.Since(began).Round(time.Second).String())
		}
		if voice && last != "" {
			if err := s.waVoice(ctx, last, true); err != nil {
				log.Printf("whatsapp: voice reply: %v", err)
			}
		}
		for _, a := range asks {
			wa.React(ctx, a.chat, a.id, mark)
		}
		return
	}
}

// waSend paces everything sent to WhatsApp, so a long reply goes out as a steady trickle.
func (s *Server) waSend(f func() (string, error)) (string, error) {
	s.wa.out.Lock()
	defer s.wa.out.Unlock()
	if d := waGap - time.Since(s.wa.sentAt); d > 0 {
		time.Sleep(d)
	}
	id, err := f()
	s.wa.sentAt = time.Now()
	if err != nil {
		log.Printf("whatsapp: send: %v", err)
	}
	return id, err
}

func (s *Server) waText(ctx context.Context, text string) (string, error) {
	return s.waSend(func() (string, error) { return s.WhatsApp.Text(ctx, text, "") })
}

func (s *Server) waReply(ctx context.Context, md string) error {
	var errs []error
	for _, p := range whatsapp.Format(md) {
		var err error
		switch {
		case p.Text != "":
			_, err = s.waText(ctx, p.Text)
		case p.Table != nil:
			err = s.waTable(ctx, p.Table)
		case p.Code != "":
			name := "code" + cmp.Or(langExt[p.Lang], "."+cmp.Or(p.Lang, "txt"))
			_, err = s.waFile(ctx, []byte(p.Code), "text/plain", name, "")
		}
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

var langExt = map[string]string{"bash": ".sh", "shell": ".sh", "python": ".py", "golang": ".go", "javascript": ".js", "typescript": ".ts", "ruby": ".rb", "markdown": ".md", "yaml": ".yml"}

func (s *Server) waFile(ctx context.Context, data []byte, mt, name, caption string) (string, error) {
	return s.waSend(func() (string, error) { return s.WhatsApp.Media(ctx, data, mt, name, caption, false) })
}

func (s *Server) waTable(ctx context.Context, rows [][]string) error {
	if s.Browser != nil {
		png, err := s.Browser.Render(ctx, tableHTML(rows), waRenderPx)
		if err == nil {
			_, err = s.waFile(ctx, png, "image/png", "table.png", "")
			return err
		}
		log.Printf("whatsapp: render table: %v", err)
	}
	_, err := s.waText(ctx, whatsapp.TableText(rows))
	return err
}

func tableHTML(rows [][]string) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><meta charset="utf-8"><style>` +
		`body{margin:0;padding:14px;display:inline-block;background:#fff;color:#1f2328;font:15px/1.4 -apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif}` +
		`table{border-collapse:collapse}th,td{padding:7px 12px;text-align:left;vertical-align:top;max-width:280px;border-bottom:1px solid #e3e6ea}` +
		`th{background:#f3f5f7;font-weight:600;white-space:nowrap;border-bottom:2px solid #d0d5db}tr:nth-child(even) td{background:#fafbfc}` +
		`td:not(:first-child),th:not(:first-child){border-left:1px solid #eef0f2}</style><table>`)
	for i, r := range rows {
		cell := "td"
		if i == 0 {
			cell = "th"
		}
		b.WriteString("<tr>")
		for _, c := range r {
			b.WriteString("<" + cell + ">" + html.EscapeString(c) + "</" + cell + ">")
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</table>")
	return b.String()
}

// waVoice sends text as a voice note, spoken by atc's TTS; condensed first when it is a
// written reply rather than something meant to be said.
func (s *Server) waVoice(ctx context.Context, text string, condense bool) error {
	if s.Voice.TTS == "" {
		return errors.New("text-to-speech is not configured")
	}
	if condense && s.Voice.LLM != "" {
		if short, err := s.chat(ctx, condensePrompt, text, 160); err == nil && short != "" {
			text = short
		}
	}
	res, err := s.speak(ctx, text)
	if err != nil {
		return err
	}
	wav, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		return err
	}
	ogg, err := s.WhatsApp.Voice(ctx, wav)
	if err != nil {
		return err
	}
	_, err = s.waSend(func() (string, error) { return s.WhatsApp.Media(ctx, ogg, "audio/ogg; codecs=opus", "", "", true) })
	return err
}

func (s *Server) waNew(ctx context.Context, msg waMsg) error {
	list, err := s.M.Live(ctx)
	if err != nil {
		return err
	}
	for _, x := range list {
		if x.Kind == "background" && cmp.Or(s.M.Store.Get(x.SessionID).Name, x.Name) == waName {
			s.M.Store.Update(x.SessionID, func(m *store.Meta) { m.Name = waName + " " + x.Last().Format("01-02 15:04") })
			if x.Attachable {
				s.M.CLI.Stop(ctx, x.ID)
			}
		}
	}
	s.wa.mu.Lock()
	s.wa.turn = nil
	s.wa.mu.Unlock()
	id, err := s.keep(ctx, waName, true)
	if err != nil {
		return err
	}
	x, err := s.waReady(ctx, id)
	if err != nil {
		return err
	}
	s.M.Store.Update(x.SessionID, func(m *store.Meta) { m.Name, m.Parked = waName, true })
	s.refresh()
	s.WhatsApp.React(ctx, msg.chat, msg.id, "🆕")
	_, err = s.waText(ctx, "🆕 Fresh conversation. The last one is kept in atc as _"+waName+" "+time.Now().Format("01-02")+"…_")
	return err
}

func (s *Server) waStop(ctx context.Context, msg waMsg) error {
	s.wa.mu.Lock()
	t := s.wa.turn
	s.wa.mu.Unlock()
	if t == nil {
		return s.WhatsApp.React(ctx, msg.chat, msg.id, "🤷")
	}
	if err := s.Term.Keys(ctx, t.id, "\x1b"); err != nil {
		return err
	}
	return s.WhatsApp.React(ctx, msg.chat, msg.id, "🛑")
}

// waOut is what `atc wa` asks for: files, rendered pages, a voice note or text, always to
// the owner and nobody else.
type waOut struct {
	Text    string   `json:"text"`
	Files   []string `json:"files"`
	Render  []string `json:"render"`
	Voice   string   `json:"voice"`
	Caption string   `json:"caption"`
}

func (s *Server) waPost(w http.ResponseWriter, r *http.Request) {
	if s.WhatsApp == nil {
		http.Error(w, "WhatsApp is not set up on "+s.Host+" (ATC_WHATSAPP_* in ~/.config/atc/env)", http.StatusNotImplemented)
		return
	}
	var in waOut
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	var sent []string
	send := func(what string, err error) bool {
		if err != nil {
			http.Error(w, fmt.Sprintf("%s: %v (sent before it: %s)", what, err, cmp.Or(strings.Join(sent, ", "), "nothing")), http.StatusBadGateway)
			return false
		}
		sent = append(sent, what)
		return true
	}
	for _, p := range in.Files {
		data, err := os.ReadFile(p)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(p)))
		if mt == "" {
			mt = http.DetectContentType(data)
		}
		if _, err := s.waFile(ctx, data, mt, filepath.Base(p), in.Caption); !send(filepath.Base(p), err) {
			return
		}
	}
	for _, p := range in.Render {
		page, err := os.ReadFile(p)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if s.Browser == nil {
			http.Error(w, "rendering needs atc's browser (ATC_BROWSER)", http.StatusNotImplemented)
			return
		}
		png, err := s.Browser.Render(ctx, string(page), waRenderPx)
		if err == nil {
			_, err = s.waFile(ctx, png, "image/png", strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))+".png", in.Caption)
		}
		if !send(filepath.Base(p), err) {
			return
		}
	}
	if in.Voice != "" && !send("voice note", s.waVoice(ctx, in.Voice, false)) {
		return
	}
	if in.Text != "" && !send("text", s.waReply(ctx, in.Text)) {
		return
	}
	reply(w, map[string][]string{"sent": sent})
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }
