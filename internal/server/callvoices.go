package server

import (
	"bytes"
	"io"
	"net/http"
)

// callVoices passes the call screen's voice picker through to delta-shell: GET lists the voices per language with
// the current pick, POST {"lang", "voice"} picks one (delta-talk takes it from its next reply on). The body is read
// first so the request carries a Content-Length: delta-shell's server cannot read a chunked body.
func (s *Server) callVoices(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		fail(w, err)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, s.CallVoices+"/api/voices", bytes.NewReader(body))
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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
