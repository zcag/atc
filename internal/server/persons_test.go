package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

func TestNoPersonsYetStillDraws(t *testing.T) {
	rec := httptest.NewRecorder()
	newPersonsRig(t).callPersons(rec, httptest.NewRequest("GET", "/api/call/persons", nil))
	if got := strings.TrimSpace(rec.Body.String()); got != `{"persons":[],"langs":{}}` {
		t.Fatal(got)
	}
}
