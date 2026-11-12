package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/settings"
)

type personsRig struct {
	*Server
	mux  *http.ServeMux
	told []string
}

func newPersonsRig(t *testing.T) *personsRig {
	rig := &personsRig{mux: http.NewServeMux()}
	voices := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Lang, Voice string }
		json.NewDecoder(r.Body).Decode(&b)
		if b.Voice == "nobody" {
			http.Error(w, "no such voice", http.StatusBadRequest)
			return
		}
		rig.told = append(rig.told, b.Lang+"="+b.Voice)
	}))
	t.Cleanup(voices.Close)
	rig.Server = &Server{CallVoices: voices.URL, StateDir: t.TempDir()}
	rig.mux.HandleFunc("GET /api/call/persons", rig.callPersons)
	rig.mux.HandleFunc("POST /api/call/persons", rig.callPersonSave)
	rig.mux.HandleFunc("POST /api/call/persons/pick", rig.callPersonPick)
	rig.mux.HandleFunc("DELETE /api/call/persons/{id}", rig.callPersonDelete)
	return rig
}

func TestAutonomyArgs(t *testing.T) {
	has := func(args []string, s string) bool { return strings.Contains(strings.Join(args, " "), s) }
	daily := autonomyArgs("", "/home/x/assistant")
	if !has(daily, "mcp__atc") || !has(daily, "Read,") || !has(daily, "Edit(//home/x/assistant/**)") || has(daily, "dangerously") {
		t.Fatal(daily)
	}
	if got := autonomyArgs("nonsense", "/d"); strings.Join(got, " ") != strings.Join(autonomyArgs("daily", "/d"), " ") {
		t.Fatalf("an unknown level isn't daily: %v", got)
	}
	limited := autonomyArgs("limited", "/d")
	if !has(limited, "mcp__atc") || !has(limited, "Bash(atc wa *)") || has(limited, "Read") || has(limited, "Edit") || has(limited, "WebFetch") {
		t.Fatal(limited)
	}
	if full := autonomyArgs("full", "/d"); !has(full, "--dangerously-skip-permissions") || has(full, "allowedTools") {
		t.Fatal(full)
	}
	t.Setenv(settings.AutonomyKey, "")
	if !has(HubArgs("/d"), "Bash(atc guest *)") {
		t.Fatal("the assistant at daily runs atc guest")
	}
	guests := GuestsArgs("/home/x/guests")
	if !has(guests, "Bash(atc wa --to *)") || !has(guests, "Bash(atc wa --group *)") || !has(guests, "Edit(//home/x/guests/groups/**)") || !has(guests, "Edit(//home/x/guests/**)") || has(guests, "dangerously") || has(guests, "Read,") {
		t.Fatal(guests)
	}
	home, notes := t.TempDir(), t.TempDir()
	os.Symlink(notes, filepath.Join(home, "groups"))
	realNotes, _ := filepath.EvalSymlinks(notes)
	if linked := strings.Join(GuestsArgs(home), " "); strings.Count(linked, "--add-dir") != 1 || !strings.Contains(linked, "--add-dir "+realNotes) {
		t.Fatal("the groups' real folder is a working directory, so writing through the link isn't refused:", linked)
	}
}

func TestSeedPersonsOnlyWhenNobodyWasEverSaved(t *testing.T) {
	s := &Server{StateDir: filepath.Join(t.TempDir(), "new")}
	seed := []byte(`{"langs":{"en":"june"},"persons":[{"id":"june","name":"June","character":"woman","voices":{"en":"june"}}],"voices":{"june":{"pocket-en":"vera"}}}`)
	if err := s.SeedPersons(seed); err != nil {
		t.Fatal(err)
	}
	var d Persons
	s.loadPref(personsFile, &d)
	if len(d.Persons) != 1 || d.Persons[0].Name != "June" || d.Langs["en"] != "june" {
		t.Fatalf("%+v", d)
	}
	if err := s.savePref(personsFile, Persons{}.tidy()); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedPersons(seed); err != nil {
		t.Fatal(err)
	}
	d = Persons{}
	s.loadPref(personsFile, &d)
	if len(d.Persons) != 0 {
		t.Fatalf("deleted persons came back: %+v", d)
	}
}

func (rig *personsRig) do(t *testing.T, method, path, body string, want int) Persons {
	t.Helper()
	rec := httptest.NewRecorder()
	rig.mux.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	if rec.Code != want {
		t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body)
	}
	var d Persons
	if want == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
	}
	return d
}

func TestFirstPersonTakesEveryLanguageItSpeaks(t *testing.T) {
	rig := newPersonsRig(t)
	d := rig.do(t, "POST", "/api/call/persons", `{"name":"Ada Lee","character":"woman","voices":{"tr":"f","en":"e"}}`, 200)
	if d.Persons[0].ID != "ada-lee" || d.Langs["tr"] != "ada-lee" || d.Langs["en"] != "ada-lee" {
		t.Fatalf("%+v", d)
	}
	if len(rig.told) != 2 {
		t.Fatalf("voice service told %v", rig.told)
	}
	d = rig.do(t, "POST", "/api/call/persons", `{"name":"Ada Lee","character":"orb","voices":{"tr":"m"}}`, 200)
	if d.Persons[1].ID != "ada-lee-2" || d.Langs["tr"] != "ada-lee" {
		t.Fatalf("a second person must not take a language: %+v", d)
	}
}

func TestPickSwapsTheVoiceAndRefusesWithoutOne(t *testing.T) {
	rig := newPersonsRig(t)
	rig.do(t, "POST", "/api/call/persons", `{"name":"A","character":"woman","voices":{"tr":"f","en":"e"}}`, 200)
	rig.do(t, "POST", "/api/call/persons", `{"name":"B","character":"professor","voices":{"tr":"m"}}`, 200)
	rig.told = nil
	d := rig.do(t, "POST", "/api/call/persons/pick", `{"lang":"tr","id":"b"}`, 200)
	if d.Langs["tr"] != "b" || d.Langs["en"] != "a" || len(rig.told) != 1 || rig.told[0] != "tr=m" {
		t.Fatalf("%+v told %v", d, rig.told)
	}
	rig.do(t, "POST", "/api/call/persons/pick", `{"lang":"en","id":"b"}`, 400)
	rig.do(t, "POST", "/api/call/persons/pick", `{"lang":"en","id":"gone"}`, 404)
}

func TestARefusedVoiceSavesNothing(t *testing.T) {
	rig := newPersonsRig(t)
	rig.do(t, "POST", "/api/call/persons", `{"name":"A","character":"woman","voices":{"tr":"f"}}`, 200)
	rig.do(t, "POST", "/api/call/persons", `{"name":"B","character":"woman","voices":{"tr":"nobody"}}`, 200)
	rig.do(t, "POST", "/api/call/persons/pick", `{"lang":"tr","id":"b"}`, 400)
	if d := rig.do(t, "GET", "/api/call/persons", "", 200); d.Langs["tr"] != "a" {
		t.Fatalf("%+v", d)
	}
}

func TestEditAndDelete(t *testing.T) {
	rig := newPersonsRig(t)
	rig.do(t, "POST", "/api/call/persons", `{"name":"A","character":"woman","voices":{"tr":"f","en":"e"}}`, 200)
	rig.told = nil
	d := rig.do(t, "POST", "/api/call/persons", `{"id":"a","name":"A","character":"line","voices":{"tr":"g"}}`, 200)
	if d.Persons[0].Character != "line" || d.Langs["tr"] != "a" || d.Langs["en"] != "" || len(rig.told) != 1 || rig.told[0] != "tr=g" {
		t.Fatalf("%+v told %v", d, rig.told)
	}
	d = rig.do(t, "DELETE", "/api/call/persons/a", "", 200)
	if len(d.Persons) != 0 || len(d.Langs) != 0 {
		t.Fatalf("%+v", d)
	}
	rig.do(t, "DELETE", "/api/call/persons/a", "", 404)
	rig.do(t, "POST", "/api/call/persons", `{"name":"","character":"woman"}`, 400)
	rig.do(t, "POST", "/api/call/persons", `{"name":"x","character":"../up"}`, 400)
}

func TestBackgroundsAreKeptAndListed(t *testing.T) {
	rig := newPersonsRig(t)
	d := rig.do(t, "POST", "/api/call/persons", `{"name":"A","character":"woman","background":"night.jpg","voices":{"tr":"f"}}`, 200)
	if d.Persons[0].Background != "night.jpg" {
		t.Fatalf("%+v", d)
	}
	rig.do(t, "POST", "/api/call/persons", `{"name":"B","character":"woman","background":"../night.jpg"}`, 400)

	rig.AppDir = t.TempDir()
	rooms := filepath.Join(rig.AppDir, "personas", "_rooms")
	os.MkdirAll(rooms, 0o755)
	for _, f := range []string{"night.jpg", "day.webp", "notes.txt", ".hidden.jpg"} {
		os.WriteFile(filepath.Join(rooms, f), nil, 0o644)
	}
	rec := httptest.NewRecorder()
	rig.callBackgrounds(rec, httptest.NewRequest("GET", "/api/call/backgrounds", nil))
	if got := strings.TrimSpace(rec.Body.String()); got != `["day.webp","night.jpg"]` {
		t.Fatal(got)
	}
}

func TestBackgroundUploadAndDelete(t *testing.T) {
	rig := newPersonsRig(t)
	rig.AppDir = t.TempDir()
	rig.mux.HandleFunc("POST /api/call/backgrounds", rig.callBackgroundAdd)
	rig.mux.HandleFunc("DELETE /api/call/backgrounds/{file}", rig.callBackgroundDelete)
	send := func(name string, data []byte) *httptest.ResponseRecorder {
		var body bytes.Buffer
		m := multipart.NewWriter(&body)
		f, _ := m.CreateFormFile("file", name)
		f.Write(data)
		m.Close()
		req := httptest.NewRequest("POST", "/api/call/backgrounds", &body)
		req.Header.Set("Content-Type", m.FormDataContentType())
		rec := httptest.NewRecorder()
		rig.mux.ServeHTTP(rec, req)
		return rec
	}
	png := []byte("\x89PNG\r\n\x1a\n0000")
	if got := send("../My Room!.txt", png); !strings.Contains(got.Body.String(), `"my-room.png"`) {
		t.Fatalf("%d %s", got.Code, got.Body)
	}
	if got := send("my room.png", png); !strings.Contains(got.Body.String(), `"my-room-2.png"`) {
		t.Fatalf("%d %s", got.Code, got.Body)
	}
	if got := send("page.html", []byte("<html>")); got.Code != http.StatusBadRequest {
		t.Fatalf("%d", got.Code)
	}
	rig.do(t, "POST", "/api/call/persons", `{"name":"A","character":"woman","background":"my-room.png"}`, 200)
	rig.do(t, "DELETE", "/api/call/backgrounds/my-room.png", "", 409)
	rig.do(t, "DELETE", "/api/call/backgrounds/my-room-2.png", "", 200)
	if _, err := os.Stat(filepath.Join(rig.AppDir, "personas", "_rooms", "my-room-2.png")); !os.IsNotExist(err) {
		t.Fatal("still there")
	}
}

func TestAgentPersonKeepsTheRestOfAgentJSON(t *testing.T) {
	rig := newPersonsRig(t)
	rig.AgentsDir = t.TempDir()
	rig.Host = "here"
	folder := filepath.Join(rig.AgentsDir, "focus")
	os.MkdirAll(folder, 0o755)
	os.WriteFile(filepath.Join(folder, "agent.json"), []byte(`{"host":"here","talk":true,"extra":{"kept":1}}`), 0o644)
	rig.mux.HandleFunc("POST /api/agents/{name}/person", rig.agentPerson)
	rig.do(t, "POST", "/api/call/persons", `{"name":"A","character":"woman"}`, 200)
	rig.do(t, "POST", "/api/agents/focus/person", `{"person":"gone"}`, 404)
	rec := httptest.NewRecorder()
	rig.mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/agents/focus/person", strings.NewReader(`{"person":"a"}`)))
	b, _ := os.ReadFile(filepath.Join(folder, "agent.json"))
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil || got["person"] != "a" || got["talk"] != true || got["extra"] == nil {
		t.Fatalf("%d %s", rec.Code, b)
	}
	rec = httptest.NewRecorder()
	rig.mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/agents/focus/person", strings.NewReader(`{"person":""}`)))
	b, _ = os.ReadFile(filepath.Join(folder, "agent.json"))
	if strings.Contains(string(b), "person") {
		t.Fatal(string(b))
	}

	rec = httptest.NewRecorder()
	rig.mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/agents/focus/person", strings.NewReader(`{"background":"night.jpg"}`)))
	b, _ = os.ReadFile(filepath.Join(folder, "agent.json"))
	if !strings.Contains(string(b), `"background": "night.jpg"`) || strings.Contains(string(b), "person") {
		t.Fatalf("an agent can keep the assistant's person and only change the background: %d %s", rec.Code, b)
	}
	rig.AppDir = t.TempDir()
	rig.mux.HandleFunc("DELETE /api/call/backgrounds/{file}", rig.callBackgroundDelete)
	rig.do(t, "DELETE", "/api/call/backgrounds/night.jpg", "", 409)
	rig.do(t, "POST", "/api/agents/focus/person", `{"background":"../night.jpg"}`, 400)
}

func TestNoPersonsYetStillDraws(t *testing.T) {
	rec := httptest.NewRecorder()
	newPersonsRig(t).callPersons(rec, httptest.NewRequest("GET", "/api/call/persons", nil))
	if got := strings.TrimSpace(rec.Body.String()); got != `{"persons":[],"langs":{}}` {
		t.Fatal(got)
	}
}
