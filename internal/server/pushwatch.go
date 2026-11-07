package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// pushDeafAfter is how long a phone may leave a push unconfirmed before it counts as not hearing them.
const pushDeafAfter = 5 * time.Minute

func (s *Server) pushHeard(w http.ResponseWriter, r *http.Request) {
	var in struct{ Endpoint string }
	json.NewDecoder(r.Body).Decode(&in)
	if s.Push != nil && in.Endpoint != "" {
		s.Push.Heard(in.Endpoint)
	}
	reply(w, map[string]bool{"ok": true})
}

// watchPushes tells the user, once, when a phone stops confirming pushes, and once more when it hears them
// again. It goes on WhatsApp when atc has it, since the pushes are what stopped; the log and Settings always.
func (s *Server) watchPushes() {
	told := map[string]time.Time{}
	for range time.Tick(30 * time.Second) {
		deaf := map[string]bool{}
		for _, d := range s.Push.Deaf(pushDeafAfter) {
			deaf[d.Endpoint] = true
			if _, ok := told[d.Endpoint]; ok {
				continue
			}
			told[d.Endpoint] = d.Since
			s.tellAboutPushes(fmt.Sprintf("%s hasn't received atc's notifications since %s. Check that it is online and its push app (such as ntfy) is connected.", d.Name, d.Since.Format("15:04")))
		}
		for endpoint, since := range told {
			if !deaf[endpoint] {
				delete(told, endpoint)
				s.tellAboutPushes(fmt.Sprintf("%s gets atc's notifications again (missed since %s).", s.pushName(endpoint), since.Format("15:04")))
			}
		}
	}
}

func (s *Server) pushName(endpoint string) string {
	for _, d := range s.Push.Devices() {
		if d.Endpoint == endpoint && d.Name != "" {
			return d.Name
		}
	}
	return "The phone"
}

func (s *Server) tellAboutPushes(text string) {
	log.Printf("push: %s", text)
	if s.WhatsApp == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s.waText(ctx, text)
}
