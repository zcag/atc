package sessions

import (
	"context"
	"sort"
	"time"

	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/opencode"
	"github.com/zcag/atc/internal/store"
)

const (
	openCodeHistory = 500
	openCodeWait    = 4 * time.Second
)

func (m *Manager) OpenCode(id string) bool { return m.OC != nil && opencode.IsID(id) }

func (m *Manager) transcripts() []history.Transcript {
	ts := m.Index.Scan()
	if m.OC == nil {
		return ts
	}
	ctx, cancel := context.WithTimeout(context.Background(), openCodeWait)
	defer cancel()
	ts = append(ts, m.OC.Transcripts(ctx, openCodeHistory)...)
	sort.SliceStable(ts, func(i, j int) bool { return ts[i].Updated.After(ts[j].Updated) })
	return ts
}

func (m *Manager) Find(sid string) (history.Transcript, bool) {
	if m.OpenCode(sid) {
		ctx, cancel := context.WithTimeout(context.Background(), openCodeWait)
		defer cancel()
		return m.OC.Find(ctx, sid)
	}
	return m.Index.Find(sid)
}

func (m *Manager) openCode(ctx context.Context) []Session {
	if m.OC == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, openCodeWait)
	defer cancel()
	live, gone := m.OC.Live(ctx, m.Store.Find(func(id string, x store.Meta) bool { return x.Live != "" && opencode.IsID(id) }))
	for _, sid := range gone {
		m.Keep(sid, "")
	}
	var out []Session
	for _, l := range live {
		s := m.build(l.Transcript)
		meta := m.Store.Get(l.SessionID)
		s.ID, s.Kind = l.SessionID, "background"
		switch {
		case meta.Live == store.Stopped:
			s.State = Stopped
		case len(l.Asks) > 0:
			s.State, s.Activity, s.Asks = NeedsYou, l.Asks[0].Activity(), l.Asks
			for i := range s.Asks {
				s.Asks[i].Key = s.Asks[i].Fingerprint()
			}
		case l.Busy:
			s.State = Working
		default:
			s.State = YourTurn
		}
		s.Attachable = s.State != Stopped
		if s.State == YourTurn && s.Summary == nil {
			s.Summarizing = m.Summary.Want(l.Transcript)
		}
		out = append(out, s)
	}
	return out
}

func (m *Manager) Keep(sid, live string) error {
	return m.Store.Update(sid, func(x *store.Meta) { x.Live = live })
}

func (m *Manager) Adopt(ctx context.Context, sid string) {
	if m.Store.Get(sid).Live == "" && m.OC.Root(ctx, sid) {
		m.Keep(sid, store.Running)
	}
}
