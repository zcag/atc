package server

import (
	"bytes"
	"io"
	"net/http"
)

// callVoices passes the call screen's voice picker through to delta-shell: GET lists the voices per language with
// the current pick, POST {"lang", "voice"} picks one (delta-talk takes it from its next reply on).
func (s *Server) callVoices(w http.ResponseWriter, r *http.Request) { s.toVoices(w, r, "/api/voices") }

// callVoiceSample plays a voice before picking it: delta-shell renders ?lang&voice&text once and keeps the wav, and
// answers 409 while delta is on a call and the sample is not rendered yet.
func (s *Server) callVoiceSample(w http.ResponseWriter, r *http.Request) {
	s.toVoices(w, r, "/api/voices/sample?"+r.URL.RawQuery)
}

// toVoices reads the body first so the request carries a Content-Length: delta-shell's server cannot read a chunked body.
func (s *Server) toVoices(w http.ResponseWriter, r *http.Request, path string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		fail(w, err)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, s.CallVoices+path, bytes.NewReader(body))
	if err != nil {
		fail(w, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "the voices are not reachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
