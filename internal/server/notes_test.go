package server

import (
	"testing"
	"time"

	"github.com/zcag/atc/internal/sessions"
)

func TestNoteAlerts(t *testing.T) {
	at := time.Now()
	list := func(n *sessions.Note, parked bool) []sessions.Session {
		return []sessions.Session{{SessionID: "s1", ID: "ab12", Title: "work", Attachable: true, Parked: parked, Note: n}}
	}
	never := func(sessions.Session) bool { return false }
	always := func(sessions.Session) bool { return true }

	seen, normal, urgent := noteAlerts(nil, list(nil, false), never)
	if len(normal)+len(urgent) != 0 {
		t.Fatalf("no note pushed %v %v", normal, urgent)
	}
	note := &sessions.Note{Text: "deploy done", Replies: []string{"ship it"}, At: at}
	seen, normal, _ = noteAlerts(seen, list(note, false), never)
	if len(normal) != 1 || normal[0].Body != "deploy done" || normal[0].Session != "ab12" || normal[0].Replies[0] != "ship it" {
		t.Fatalf("new note: %+v", normal)
	}
	if _, normal, _ = noteAlerts(seen, list(note, false), never); len(normal) != 0 {
		t.Fatalf("same note pushed twice: %v", normal)
	}
	later := &sessions.Note{Text: "again", At: at.Add(time.Second)}
	if _, normal, _ = noteAlerts(seen, list(later, false), always); len(normal) != 0 {
		t.Fatalf("pushed while you watch the session: %v", normal)
	}
	if _, normal, _ = noteAlerts(seen, list(later, true), never); len(normal) != 0 {
		t.Fatalf("pushed for a parked session: %v", normal)
	}
	loud := &sessions.Note{Text: "now", Urgent: true, At: at.Add(time.Second)}
	if _, normal, urgent = noteAlerts(seen, list(loud, true), always); len(normal) != 0 || len(urgent) != 1 {
		t.Fatalf("urgent ignores the rules: %v %v", normal, urgent)
	}
}
