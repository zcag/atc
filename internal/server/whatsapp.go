package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/zcag/atc/internal/sessions"
	"github.com/zcag/atc/internal/whatsapp"
)

const waName = "whatsapp"

const waPrompt = `This conversation happens over WhatsApp: the user writes to you from their phone, and atc sends every reply you write ` +
	`to them as WhatsApp messages. Write for a phone screen: short paragraphs, the answer first. Write Markdown as usual; atc converts it ` +
	`(bold, italic, strikethrough, code, lists, quotes, links; headings become bold lines). A Markdown table is sent as an image, so use one ` +
	`when something really is tabular, and long code is sent as a file. Every text you write while working goes out as its own message ` +
	`as soon as you write it, so don't narrate each step; write when there is something worth reading. ` +
	"To send a file, image, screenshot, PDF, a rendered HTML page or a voice note, run `atc wa` (`atc wa -h`); never use it for plain " +
	"text, which your reply delivers anyway. A page you show with `atc show` is sent to them as a screenshot with a link. " +
	`

When you offer the user a choice, send it as a poll they answer with a tap: ` + "`atc wa --poll \"Question?\" --option A --option B`" +
	` (2 to 12 options, --multi to allow several). Write any context first, run the poll last, don't list the options again in text, and end ` +
	`your turn; their vote comes back as a "[poll vote]" message. Nobody can answer a dialog from WhatsApp, so never wait on one.

` +
	`What the user sends arrives as text: photos, documents and other files as the path of the saved file (read it), voice notes already ` +
	`transcribed, locations as coordinates, a reply to an earlier message with that message ` +
	`quoted first, "[reacted 👍 to your message]" when they react to one of your questions (👍 is yes, 👎 is no), and "[edited a message]" ` +
	`with their correction. They have /new for a fresh conversation, /stop to interrupt you and /status for their sessions.

` +
	`A voice note arrives as "[voice note, spoken in <language>]", and the user asked to hear the answer to one back as a voice note ` +
	`in the language they spoke. So every reply to a voice note ends with one last line that starts with 🔊: the answer said out ` +
	`loud, one to three short sentences, in the language of the voice note. That line is speech, not writing: a standing rule to ` +
	`write to the user in English covers the rest of the reply, not this line, which is always in the language they spoke. atc ` +
	`speaks it and leaves it out of the text, so make it the answer itself, never a repeat of their question.

` +
	`Keep this conversation quick: it is a switchboard, not a workbench. Answer questions, look things up and do small one-step things ` +
	`yourself. Anything bigger (changing code or config, deploying, research or work that takes more than a couple of minutes) goes to a ` +
	`session of its own: start one with the atc start tool (worktree when it works in a git repo), tell the user in a line what you ` +
	`started, and end your turn. Never enter a worktree or change folders in this session. A session you started reports back into this ` +
	`conversation; pass the outcome on to the user in a few lines, follow up with send when something is missing or wrong, and once its ` +
	`work is done and nothing more is expected of it, stop it with the stop tool and say so. Use the sessions and read tools when the ` +
	`user asks how things stand. ` + switchboard

// waChat is the one conversation: which messages were seen, the turn being relayed, where in
// the session's transcript relaying stopped, and what atc said, so a reaction can be read.
type waChat struct {
	mu    sync.Mutex
	seen  map[string]time.Time
	turn  *waTurn
	mark  waMark
	path  string
	said  map[string]string
	order []string
	heard map[string]string
	votes map[string]*time.Timer

	out    sync.Mutex
	sentAt time.Time
}

type waMark struct {
	SID  string `json:"session"`
	Off  int64  `json:"offset"`
	Chat string `json:"chat,omitempty"`
}

type waMsg struct{ chat, id string }

const waMemory = 300

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

func (c *waChat) remember(m map[string]string, id, text string) {
	if id == "" || text == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := m[id]; !ok {
		c.order = append(c.order, id)
	}
	m[id] = text
	for len(c.order) > 2*waMemory {
		delete(c.said, c.order[0])
		delete(c.heard, c.order[0])
		c.order = c.order[1:]
	}
}

func (c *waChat) recall(m map[string]string, id string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return m[id]
}

func (c *waChat) setMark(m waMark) {
	c.mu.Lock()
	m.Chat = cmp.Or(m.Chat, c.mark.Chat)
	c.mark = m
	c.mu.Unlock()
	if b, err := json.Marshal(m); err == nil && c.path != "" {
		os.WriteFile(c.path, b, 0o644)
	}
}

func (c *waChat) setChat(chat string) {
	c.mu.Lock()
	m := c.mark
	c.mu.Unlock()
	if chat != "" && chat != m.Chat {
		m.Chat = chat
		c.setMark(m)
	}
}

func (s *Server) startWhatsApp() {
	s.wa = &waChat{seen: map[string]time.Time{}, said: map[string]string{}, heard: map[string]string{}, votes: map[string]*time.Timer{}}
	if s.StateDir != "" {
		s.wa.path = filepath.Join(s.StateDir, "whatsapp.json")
		if b, err := os.ReadFile(s.wa.path); err == nil {
			json.Unmarshal(b, &s.wa.mark)
			s.WhatsApp.UseChat(s.wa.mark.Chat)
		}
	}
	go s.waWatch()
	go func() {
		for try := range 10 {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			err := s.WhatsApp.EnsureHook(ctx)
			cancel()
			if errors.Is(err, whatsapp.ErrNoVotes) {
				log.Printf("whatsapp: %v", err)
				err = nil
			}
			if err == nil {
				log.Printf("whatsapp: webhooks ready at %s", cmp.Or(s.WhatsApp.Hook, "(not registered by atc)"))
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
	decode := func(v any) bool {
		if err := json.Unmarshal(ev.Data, v); err != nil {
			log.Printf("whatsapp: %s: %v", ev.Event, err)
			return false
		}
		return true
	}
	switch ev.Event {
	case "message.received":
		var m whatsapp.Message
		if decode(&m) {
			go s.waReceive(m)
		}
	case "message.reaction":
		var x whatsapp.Reaction
		if decode(&x) {
			go s.waReaction(x)
		}
	case "message.edited":
		var x whatsapp.Edit
		if decode(&x) {
			go s.waEdited(x)
		}
	case "poll.vote":
		var x whatsapp.Vote
		if decode(&x) {
			go s.waVote(x)
		}
	}
}

func waContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 3*time.Minute)
}

func (s *Server) waReceive(d whatsapp.Message) {
	ctx, cancel := waContext()
	defer cancel()
	wa := s.WhatsApp
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
	wa.UseChat(msg.chat)
	s.wa.setChat(msg.chat)
	s.wa.remember(s.wa.heard, d.ID, d.Body)
	wa.Read(ctx, msg.chat)
	var err error
	switch strings.ToLower(strings.TrimSpace(d.Body)) {
	case "/new":
		err = s.waNew(ctx, msg)
	case "/stop":
		err = s.waStop(ctx, msg)
	case "/status":
		err = s.waStatus(ctx)
	case "/help":
		_, err = s.waText(ctx, waHelpText)
	default:
		wa.React(ctx, msg.chat, msg.id, "⏳")
		var text string
		var voice string
		if text, voice, err = s.waPrompt(ctx, d); err == nil {
			err = s.waType(ctx, msg, text, voice)
		}
	}
	s.waFailed(ctx, msg, err)
}

func (s *Server) waFailed(ctx context.Context, msg waMsg, err error) {
	if err == nil {
		return
	}
	log.Printf("whatsapp: %v", err)
	if msg.id != "" {
		s.WhatsApp.React(ctx, msg.chat, msg.id, "❗")
	}
	s.waText(ctx, "⚠️ "+err.Error())
}

const waHelpText = "*What you can send*\n" +
	"- text, photos, files, voice notes, locations\n" +
	"- a reply to one of my messages, quoting it\n" +
	"- 👍 or 👎 on one of my questions, or a tap on a poll\n\n" +
	"*Commands*\n" +
	"- /status: your sessions, what each is doing\n" +
	"- /stop: interrupt me\n" +
	"- /new: start a fresh conversation\n" +
	"- /help: this"

// waReaction passes on a reaction to one of atc's questions; one on anything else (a 👍 on an
// answer) is acknowledgement and starts nothing.
func (s *Server) waReaction(x whatsapp.Reaction) {
	ctx, cancel := waContext()
	defer cancel()
	if x.Reaction == "" || !s.WhatsApp.IsOwner(ctx, x.SenderID, "") {
		return
	}
	said := s.wa.recall(s.wa.said, x.MessageID)
	if !strings.Contains(said, "?") {
		return
	}
	text := fmt.Sprintf("[reacted %s to your message]\n%s", x.Reaction, quoted(said, 400))
	s.waFailed(ctx, waMsg{}, s.waType(ctx, waMsg{}, text, ""))
}

func (s *Server) waEdited(x whatsapp.Edit) {
	ctx, cancel := waContext()
	defer cancel()
	if x.FromMe || x.IsGroup || strings.TrimSpace(x.Body) == "" || !s.WhatsApp.IsOwner(ctx, cmp.Or(x.SenderID, x.From), "") {
		return
	}
	text := "[edited a message]\n"
	if was := s.wa.recall(s.wa.heard, x.MessageID); was != "" {
		text += "It said:\n" + quoted(was, 400) + "\nNow:\n"
	}
	s.wa.remember(s.wa.heard, x.MessageID, x.Body)
	msg := waMsg{cmp.Or(x.ChatID, s.WhatsApp.OwnerChat()), x.MessageID}
	s.WhatsApp.React(ctx, msg.chat, msg.id, "⏳")
	s.waFailed(ctx, msg, s.waType(ctx, msg, text+x.Body, ""))
}

const waVoteWait = 4 * time.Second

// waVote passes on a poll vote once the voter has settled: each change of selection arrives as
// its own event, so the last one within a few seconds is the answer.
func (s *Server) waVote(x whatsapp.Vote) {
	ctx, cancel := waContext()
	ok := s.WhatsApp.IsOwner(ctx, x.VoterID, "")
	cancel()
	if !ok {
		return
	}
	s.wa.mu.Lock()
	defer s.wa.mu.Unlock()
	if t := s.wa.votes[x.PollMessageID]; t != nil {
		t.Stop()
	}
	if len(x.SelectedOptions) == 0 {
		delete(s.wa.votes, x.PollMessageID)
		return
	}
	s.wa.votes[x.PollMessageID] = time.AfterFunc(waVoteWait, func() {
		s.wa.mu.Lock()
		delete(s.wa.votes, x.PollMessageID)
		s.wa.mu.Unlock()
		ctx, cancel := waContext()
		defer cancel()
		question := cmp.Or(x.PollName, s.wa.recall(s.wa.said, x.PollMessageID))
		text := fmt.Sprintf("[poll vote] %s\n→ %s", question, strings.Join(x.SelectedOptions, ", "))
		msg := waMsg{cmp.Or(x.ChatID, s.WhatsApp.OwnerChat()), x.PollMessageID}
		s.WhatsApp.React(ctx, msg.chat, msg.id, "⏳")
		s.waFailed(ctx, msg, s.waType(ctx, msg, text, ""))
	})
}

func quoted(text string, n int) string {
	var b strings.Builder
	for _, l := range strings.Split(clipRunes(strings.TrimSpace(text), n), "\n") {
		b.WriteString("> " + l + "\n")
	}
	return b.String()
}

// waPrompt is what the user sent as text for the session, and the language they spoke when it
// was a voice note, so the spoken reply comes back in it.
func (s *Server) waPrompt(ctx context.Context, d whatsapp.Message) (string, string, error) {
	var b strings.Builder
	if q := d.Quoted; q != nil && strings.TrimSpace(q.Body) != "" {
		b.WriteString(quoted(q.Body, 600) + "\n")
	}
	voice := ""
	switch {
	case d.Location != nil:
		l := d.Location
		fmt.Fprintf(&b, "[location: %.6f,%.6f %s]\n", l.Latitude, l.Longitude, strings.TrimSpace(l.Description+" "+l.Address))
	case d.Media != nil:
		data, mt, err := s.waMedia(ctx, d)
		if err != nil {
			return "", "", fmt.Errorf("could not fetch the %s: %w", d.Type, err)
		}
		if (d.Type == "voice" || d.Type == "audio") && s.Voice.STT != "" {
			text, lang, err := s.transcribe(ctx, data, "voice"+extFor(mt))
			if err == nil && text != "" {
				label := "voice note"
				if d.Type == "voice" {
					voice = cmp.Or(lang, "en")
					label += ", spoken in " + cmp.Or(langNames[voice], voice)
				}
				fmt.Fprintf(&b, "[%s] %s\n", label, text)
				break
			}
			log.Printf("whatsapp: transcribe: %v", err)
		}
		path, err := saveUpload(waName, cmp.Or(d.Media.Filename, d.Type+extFor(mt)), bytes.NewReader(data))
		if err != nil {
			return "", "", err
		}
		fmt.Fprintf(&b, "[%s: %s]\n", d.Type, path)
	}
	if d.Type != "location" {
		b.WriteString(d.Body)
	}
	return strings.TrimSpace(b.String()), voice, nil
}

func (s *Server) waMedia(ctx context.Context, d whatsapp.Message) ([]byte, string, error) {
	m := d.Media
	if m.Data != "" && !m.Omitted {
		b, err := base64.StdEncoding.DecodeString(m.Data)
		return b, m.Mimetype, err
	}
	b, mt, err := s.WhatsApp.Download(ctx, cmp.Or(d.ChatID, d.From), d.ID)
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

var waStateMark = map[string]string{sessions.NeedsYou: "🟠", sessions.Working: "🔵", sessions.YourTurn: "✅", sessions.Stopped: "⚪"}

func (s *Server) waStatus(ctx context.Context) error {
	list, err := s.liveAll(ctx, false)
	if err != nil {
		return err
	}
	sessions.Sort(list)
	var lines []string
	stopped := 0
	for _, x := range list {
		if x.Hidden() || x.Kind == "interactive" && x.PID == 0 || cmp.Or(s.M.Store.Get(x.SessionID).Name, x.Name) == waName {
			continue
		}
		if x.State == sessions.Stopped {
			stopped++
			continue
		}
		line := cmp.Or(waStateMark[x.State], "▫️") + " *" + clipRunes(x.Title, 60) + "*"
		if x.Host != "" && x.Host != s.Host {
			line += " (" + x.Host + ")"
		}
		switch {
		case x.State == sessions.Working && x.Activity != "":
			line += "\n   " + clipRunes(oneLine(x.Activity), 90)
		case x.State == sessions.NeedsYou:
			if a := asks(x); a != "" {
				line += "\n   asks: " + clipRunes(a, 120)
			}
		case x.Summary != nil && x.Summary.Status != "":
			line += "\n   " + clipRunes(x.Summary.Status, 120)
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		lines = append(lines, "Nothing open right now.")
	}
	if len(lines) > 15 {
		lines = append(lines[:15], fmt.Sprintf("…and %d more", len(lines)-15))
	}
	if stopped > 0 {
		lines = append(lines, fmt.Sprintf("⚪ %d stopped", stopped))
	}
	_, err = s.waText(ctx, strings.Join(lines, "\n"))
	return err
}

func asks(x sessions.Session) string {
	var out []string
	for _, a := range x.Asks {
		for _, q := range a.Questions {
			out = append(out, q.Question)
		}
		if a.Permission != "" {
			out = append(out, a.Activity())
		}
	}
	if len(out) == 0 {
		return x.Activity
	}
	return strings.Join(slices.Compact(out), " · ")
}
