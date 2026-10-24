package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"

	"github.com/zcag/atc/internal/attach"
)

func (s *Server) termLog(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Device, Session, Event string
		Detail                 map[string]any
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil || in.Event == "" {
		http.Error(w, "bad log", http.StatusBadRequest)
		return
	}
	keys := make([]string, 0, len(in.Detail))
	for k := range in.Detail {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, " %s=%v", k, in.Detail[k])
	}
	log.Printf("term %s client (%s): %s%s", attach.Short(in.Session), s.deviceName(r, in.Device), in.Event, b.String())
	w.WriteHeader(http.StatusNoContent)
}
