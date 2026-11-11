package server

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/zcag/atc/internal/whatsapp"
)

// groupsAgent is the agent that takes part in the account's WhatsApp groups, one conversation for all of them.
const groupsAgent = "groups"

// waGroup passes a message in a group the owner is in to the groups agent, which decides itself
// whether it is for it and answers with atc wa --group. atc writes who sent it, from the verified
// sender, so the owner's word there is theirs and nobody else can claim it.
func (s *Server) waGroup(d whatsapp.Message) {
	ctx, cancel := waContext()
	defer cancel()
	wa := s.WhatsApp
	if d.FromMe || !d.IsGroup {
		return
	}
	g, ok := wa.Open(ctx, d.ChatID)
	if !ok {
		log.Printf("whatsapp: ignored a message in group %s", d.ChatID)
		return
	}
	if strings.TrimSpace(d.Body) == "" && d.Media == nil && d.Location == nil || !s.wa.first(d.ID) {
		return
	}
	a, ok := s.agentNamed(groupsAgent)
	if !ok {
		log.Printf("whatsapp: a message in group %q, but there is no @%s agent on this machine to take it", g.Name, groupsAgent)
		return
	}
	d.Body = fenced(d.Body)
	text, voice, err := s.waPrompt(ctx, d)
	if err != nil {
		log.Printf("whatsapp: group %q: %v", g.Name, err)
		return
	}
	text = s.waMentions(ctx, g, d, text)
	wa.Read(ctx, d.ChatID)
	head := fmt.Sprintf("[WhatsApp group %q (%s) · %s", g.Name, g.ID, s.waAuthor(ctx, g, d))
	if voice != "" {
		head += ", a voice note spoken in " + cmp.Or(langNames[voice], voice)
	}
	if s.waMentionsSelf(ctx, g, d) {
		head += ", mentioning you"
	}
	log.Printf("whatsapp: group %q: a %s message", g.Name, d.Type)
	s.waToAgent(ctx, a, head+"]\n"+text+"\n[end of message]")
}

// waGroupMembers keeps track of joins and leaves: the members are fetched again, and the agent
// hears when the account itself was added to a group the owner is in.
func (s *Server) waGroupMembers(ev whatsapp.GroupEvent, joined bool) {
	ctx, cancel := waContext()
	defer cancel()
	wa := s.WhatsApp
	wa.ForgetGroup(ev.GroupID)
	if !joined {
		return
	}
	self, err := wa.Self(ctx)
	if err != nil {
		log.Printf("whatsapp: a join in group %s, but the account's own number is unknown: %v", ev.GroupID, err)
		return
	}
	var g whatsapp.Group
	var ok bool
	for try := 0; try < 4 && !ok; try++ {
		if try > 0 {
			time.Sleep(5 * time.Second)
			wa.ForgetGroup(ev.GroupID)
		}
		g, ok = wa.Open(ctx, ev.GroupID)
	}
	if !ok {
		log.Printf("whatsapp: a join in group %s, which atc stays out of (the user is not in it, it is quiet, or WhatsApp did not say)", ev.GroupID)
		return
	}
	if !slices.ContainsFunc(ev.ParticipantIDs, func(id string) bool { return s.waNumber(ctx, g, id) == self }) {
		log.Printf("whatsapp: %v joined group %q", ev.ParticipantIDs, g.Name)
		return
	}
	a, ok := s.agentNamed(groupsAgent)
	if !ok {
		log.Printf("whatsapp: added to group %q, but there is no @%s agent on this machine", g.Name, groupsAgent)
		return
	}
	var members []string
	for _, m := range g.Members {
		if m.Number != self {
			members = append(members, s.waWho(ctx, g, m.ID, m.Number, m.Name))
		}
	}
	by := "someone"
	if ev.ActorID != "" {
		by = s.waWho(ctx, g, ev.ActorID, s.waNumber(ctx, g, ev.ActorID), "")
	}
	log.Printf("whatsapp: added to group %q", g.Name)
	s.waToAgent(ctx, a, fmt.Sprintf("[WhatsApp group %q (%s) · you were added by %s]\nMembers: %s\n[end of message]",
		g.Name, g.ID, by, strings.Join(members, "; ")))
}

func (s *Server) waToAgent(ctx context.Context, a Agent, text string) {
	for try := 1; ; try++ {
		_, err := s.wakeAgent(ctx, a, text)
		if err == nil {
			return
		}
		log.Printf("whatsapp: to @%s (try %d): %v", a.Name, try, err)
		if try == 6 {
			return
		}
		time.Sleep(10 * time.Second)
	}
}

func (s *Server) waAuthor(ctx context.Context, g whatsapp.Group, d whatsapp.Message) string {
	id := cmp.Or(d.Author, d.From)
	num := strings.TrimPrefix(d.SenderPhone, "+")
	if num == "" {
		num = s.waNumber(ctx, g, id)
	}
	name := ""
	if d.Contact != nil {
		name = d.Contact.PushName
	}
	return s.waWho(ctx, g, id, num, name)
}

// waWho names a member: the user, a guest by their name in the list, else what WhatsApp calls them
// and their number. Only the user's line lacks the word member, so no name can pass for theirs.
func (s *Server) waWho(ctx context.Context, g whatsapp.Group, id, num, name string) string {
	wa := s.WhatsApp
	if num == wa.Owner || num == "" && wa.IsOwner(ctx, id, "") {
		return "the user, verified by atc"
	}
	if m, ok := g.Member(id); ok && name == "" {
		name = m.Name
	}
	if num == "" {
		return fmt.Sprintf("member %q (number unknown, %s)", cmp.Or(name, "unknown"), id)
	}
	if guest := wa.Guest(ctx, num+"@c.us", num); guest != "" {
		return fmt.Sprintf("member %q, guest %s (+%s)", name, guest, num)
	}
	return fmt.Sprintf("member %q (+%s)", name, num)
}

func (s *Server) waMentionsSelf(ctx context.Context, g whatsapp.Group, d whatsapp.Message) bool {
	self, err := s.WhatsApp.Self(ctx)
	return err == nil && slices.ContainsFunc(d.MentionedIDs, func(id string) bool { return s.waNumber(ctx, g, id) == self })
}

// waMentions writes each @mention in a message as who it is: WhatsApp puts a bare id there (@1099...), which
// says nothing to a reader.
func (s *Server) waMentions(ctx context.Context, g whatsapp.Group, d whatsapp.Message, text string) string {
	wa := s.WhatsApp
	self, _ := wa.Self(ctx)
	for _, id := range d.MentionedIDs {
		user, _, _ := strings.Cut(id, "@")
		num := s.waNumber(ctx, g, id)
		name := "+" + num
		switch {
		case num == "":
			continue
		case num == self:
			name = wa.SelfName()
		case num == wa.Owner:
			name = "the user"
		default:
			if guest := wa.Guest(ctx, num+"@c.us", num); guest != "" {
				name = guest
			} else if m, ok := g.Member(id); ok && m.Name != "" {
				name = m.Name
			}
		}
		text = strings.ReplaceAll(text, "@"+user, "@"+name)
	}
	return text
}

// waNumber is the phone number behind a member id: its own digits for a @c.us id, else the group's word for it,
// else WhatsApp's for an @lid.
func (s *Server) waNumber(ctx context.Context, g whatsapp.Group, id string) string {
	if n, ok := strings.CutSuffix(id, "@c.us"); ok {
		return n
	}
	if m, ok := g.Member(id); ok && m.Number != "" {
		return m.Number
	}
	if strings.HasSuffix(id, "@lid") {
		n, _ := s.WhatsApp.Phone(ctx, id)
		return n
	}
	return ""
}

// fenced keeps anyone but the user from writing a line that reads as one of atc's: a header, an end mark, a
// session's or the hub's line all start with a bracket.
func fenced(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "[") {
			lines[i] = "» " + l
		}
	}
	return strings.Join(lines, "\n")
}
