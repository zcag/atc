package server

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const (
	personsFile   = "persons.json"
	maxBackground = 16 << 20
)

var backgroundTypes = map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

// Person is who a call shows and speaks as: a name, a character from /app/personas (or "orb") and a voice per language.
// How the assistant behaves stays out of it. Nothing here is tied to the assistant, so an agent can name a person too.
type Person struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Character string `json:"character"`
	// Background is a room: a picture in /app/personas/_rooms, with its settings in a .json beside it when it has any,
	// that replaces the character's own room; empty keeps that room.
	Background string            `json:"background,omitempty"`
	Voices     map[string]string `json:"voices"`
}

// Persons is every person, and which one the assistant is in each language.
type Persons struct {
	Persons []Person          `json:"persons"`
	Langs   map[string]string `json:"langs"`
}

var (
	characterName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$`)
	notInID       = regexp.MustCompile(`[^a-z0-9]+`)
)

func (d *Persons) find(id string) *Person {
	if i := slices.IndexFunc(d.Persons, func(p Person) bool { return p.ID == id }); i >= 0 {
		return &d.Persons[i]
	}
	return nil
}

func (d *Persons) newID(name string) string {
	base := cmp.Or(strings.Trim(notInID.ReplaceAllString(strings.ToLower(name), "-"), "-"), "person")
	id := base
	for n := 2; d.find(id) != nil; n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	return id
}

// tidy makes a list that is safe to draw from: always arrays and maps, never null.
func (d Persons) tidy() Persons {
	if d.Persons == nil {
		d.Persons = []Person{}
	}
	if d.Langs == nil {
		d.Langs = map[string]string{}
	}
	return d
}

func (s *Server) callPersons(w http.ResponseWriter, r *http.Request) {
	var d Persons
	s.loadPref(personsFile, &d)
	reply(w, d.tidy())
}

// callBackgrounds lists the rooms a person can stand in, by their pictures.
func (s *Server) callBackgrounds(w http.ResponseWriter, r *http.Request) {
	files := []string{}
	if dir, err := s.roomsDir(); err == nil {
		found, _ := os.ReadDir(dir)
		for _, f := range found {
			switch strings.ToLower(filepath.Ext(f.Name())) {
			case ".jpg", ".jpeg", ".png", ".webp":
				if characterName.MatchString(f.Name()) {
					files = append(files, f.Name())
				}
			}
		}
	}
	reply(w, files)
}

// callBackgroundAdd keeps an uploaded image in the rooms, under a name of its own.
func (s *Server) callBackgroundAdd(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBackground)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "want a file up to 16 MB: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil {
		fail(w, err)
		return
	}
	ext := backgroundTypes[http.DetectContentType(b)]
	if ext == "" {
		http.Error(w, "want a JPEG, PNG or WebP image", http.StatusBadRequest)
		return
	}
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	dir, err := s.roomsDir()
	if err == nil {
		err = os.MkdirAll(dir, 0o755)
	}
	if err != nil {
		fail(w, err)
		return
	}
	base := strings.TrimSuffix(filepath.Base(hdr.Filename), filepath.Ext(hdr.Filename))
	base = cmp.Or(strings.Trim(notInID.ReplaceAllString(strings.ToLower(base), "-"), "-"), "background")
	name := base + ext
	for n := 2; ; n++ {
		if _, err := os.Stat(filepath.Join(dir, name)); os.IsNotExist(err) {
			break
		}
		name = fmt.Sprintf("%s-%d%s", base, n, ext)
	}
	if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"file": name})
}

// callBackgroundDelete removes a room nobody stands in, with its settings.
func (s *Server) callBackgroundDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	if !characterName.MatchString(name) {
		http.Error(w, "no such room", http.StatusBadRequest)
		return
	}
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	var d Persons
	s.loadPref(personsFile, &d)
	for _, p := range d.Persons {
		if p.Background == name {
			http.Error(w, p.Name+" uses this room", http.StatusConflict)
			return
		}
	}
	for _, a := range s.agentList() {
		if a.Background == name {
			http.Error(w, a.label()+" uses this room", http.StatusConflict)
			return
		}
	}
	dir, err := s.roomsDir()
	if err == nil {
		err = os.Remove(filepath.Join(dir, name))
	}
	if err != nil {
		fail(w, err)
		return
	}
	os.Remove(filepath.Join(dir, strings.TrimSuffix(name, filepath.Ext(name))+".json"))
	reply(w, map[string]string{"file": name})
}

func (s *Server) roomsDir() (string, error) {
	if s.AppDir == "" {
		return "", errors.New("atc has no app folder (ATC_APP_DIR)")
	}
	return filepath.Join(s.AppDir, "personas", "_rooms"), nil
}

// agentPerson sets who an agent is on a call and the background it overrides theirs with, in its agent.json; an empty person
// leaves it the assistant's, an empty background leaves that person's.
func (s *Server) agentPerson(w http.ResponseWriter, r *http.Request) {
	a, ok := s.agentNamed(r.PathValue("name"))
	if !ok || a.Folder == "" {
		http.Error(w, "no such agent", http.StatusNotFound)
		return
	}
	var b struct{ Person, Background string }
	if !decodeOr400(w, r, &b, "{person, background}", func() bool {
		return len(b.Person) <= 80 && (b.Background == "" || characterName.MatchString(b.Background))
	}) {
		return
	}
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	var d Persons
	s.loadPref(personsFile, &d)
	if b.Person != "" && d.find(b.Person) == nil {
		http.Error(w, "no such person", http.StatusNotFound)
		return
	}
	file := filepath.Join(a.Folder, "agent.json")
	raw, err := os.ReadFile(file)
	if err != nil {
		fail(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		fail(w, err)
		return
	}
	for key, value := range map[string]string{"person": b.Person, "background": b.Background} {
		if value == "" {
			delete(fields, key)
		} else {
			fields[key], _ = json.Marshal(value)
		}
	}
	out, err := json.MarshalIndent(fields, "", "  ")
	if err == nil {
		err = os.WriteFile(file, append(out, '\n'), 0o644)
	}
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"person": b.Person, "background": b.Background})
}

// callPersonSave creates a person (no id) or changes one. A language with nobody yet gets a new person, so the first
// person made takes effect without a second step; a language this person already is takes its new voice now.
func (s *Server) callPersonSave(w http.ResponseWriter, r *http.Request) {
	var p Person
	if !decodeOr400(w, r, &p, "{id, name, character, voices}", func() bool {
		p.Name = strings.TrimSpace(p.Name)
		return p.Name != "" && len(p.Name) <= 40 && characterName.MatchString(p.Character) && (p.Background == "" || characterName.MatchString(p.Background))
	}) {
		return
	}
	s.editPersons(w, r, func(d *Persons) error {
		voices := map[string]string{}
		for lang, voice := range p.Voices {
			if voice != "" {
				voices[lang] = voice
			}
		}
		p.Voices = voices
		if p.ID == "" {
			p.ID = d.newID(p.Name)
			d.Persons = append(d.Persons, p)
			for lang := range voices {
				if d.Langs[lang] == "" {
					d.Langs[lang] = p.ID
				}
			}
		} else if old := d.find(p.ID); old != nil {
			*old = p
		} else {
			return statusErr{http.StatusNotFound, "no such person"}
		}
		for lang, id := range d.Langs {
			if id == p.ID && voices[lang] == "" {
				delete(d.Langs, lang)
			}
		}
		for lang, id := range d.Langs {
			if id == p.ID {
				if err := s.useVoice(r, lang, voices[lang]); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (s *Server) callPersonDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.editPersons(w, r, func(d *Persons) error {
		if d.find(id) == nil {
			return statusErr{http.StatusNotFound, "no such person"}
		}
		d.Persons = slices.DeleteFunc(d.Persons, func(p Person) bool { return p.ID == id })
		for lang, used := range d.Langs {
			if used == id {
				delete(d.Langs, lang)
			}
		}
		return nil
	})
}

// callPersonPick makes a person the assistant in one language: its voice from the next reply, its character as soon as
// the call screen has the answer.
func (s *Server) callPersonPick(w http.ResponseWriter, r *http.Request) {
	var b struct{ Lang, ID string }
	if !decodeOr400(w, r, &b, "{lang, id}", func() bool { return b.Lang != "" && b.ID != "" }) {
		return
	}
	s.editPersons(w, r, func(d *Persons) error {
		p := d.find(b.ID)
		if p == nil {
			return statusErr{http.StatusNotFound, "no such person"}
		}
		if p.Voices[b.Lang] == "" {
			return statusErr{http.StatusBadRequest, p.Name + " has no voice in this language"}
		}
		if err := s.useVoice(r, b.Lang, p.Voices[b.Lang]); err != nil {
			return err
		}
		d.Langs[b.Lang] = p.ID
		return nil
	})
}

type statusErr struct {
	code int
	text string
}

func (e statusErr) Error() string { return e.text }

// editPersons holds prefMu across the edit, voice service call included, so two picks can't leave the voice of one and
// the person of the other. Nothing is saved when the edit fails.
func (s *Server) editPersons(w http.ResponseWriter, r *http.Request, edit func(*Persons) error) {
	s.prefMu.Lock()
	defer s.prefMu.Unlock()
	var d Persons
	s.loadPref(personsFile, &d)
	d = d.tidy()
	if err := edit(&d); err != nil {
		code := http.StatusBadGateway
		if e, ok := err.(statusErr); ok {
			code = e.code
		}
		http.Error(w, err.Error(), code)
		return
	}
	if err := s.savePref(personsFile, d); err != nil {
		fail(w, err)
		return
	}
	reply(w, d)
}

// useVoice tells the voice service, which keeps the voice per language that the talker reads before each reply.
func (s *Server) useVoice(r *http.Request, lang, voice string) error {
	if s.CallVoices == "" {
		return nil
	}
	body, _ := json.Marshal(map[string]string{"lang": lang, "voice": voice})
	req, err := http.NewRequestWithContext(r.Context(), "POST", s.CallVoices+"/api/voices", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("the voices are not reachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		said, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return statusErr{http.StatusBadRequest, fmt.Sprintf("the voice service refused %s: %s", voice, strings.TrimSpace(string(said)))}
	}
	return nil
}
