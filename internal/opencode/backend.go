package opencode

import (
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/outputs"
)

type Backend struct {
	Client
	Bin string

	mu    sync.Mutex
	snaps map[string]*snapshot
	dirs  map[string]string
	down  bool
}

type snapshot struct {
	updated int64
	msgs    []Message
	full    bool
	found   *found
}

type found struct {
	files []outputs.File
	links []outputs.Link
	seen  map[string]time.Time
}

type Live struct {
	history.Transcript
	Busy bool
	Asks []Ask
}

func New(url, bin string) *Backend {
	return &Backend{Client: Client{URL: url}, Bin: bin, snaps: map[string]*snapshot{}, dirs: map[string]string{}}
}

const tailFrom = 20

func (b *Backend) messages(ctx context.Context, s Session, full, fresh bool) ([]Message, error) {
	b.mu.Lock()
	b.dirs[s.ID] = s.Directory
	old := b.snaps[s.ID]
	b.mu.Unlock()
	if old != nil && !fresh && old.updated == s.Time.Updated && (old.full || !full) {
		return old.msgs, nil
	}
	var next *snapshot
	var err error
	switch {
	case full && (old == nil || !old.full):
		var ms []Message
		if ms, err = b.Messages(ctx, s.ID, 0); err == nil {
			next = &snapshot{msgs: ms, full: true}
		}
	case old != nil:
		var ms []Message
		if ms, err = b.Messages(ctx, s.ID, tailFrom); err != nil {
			break
		}
		if merged, ok := merge(old.msgs, ms); ok {
			next = &snapshot{msgs: merged, full: old.full}
		} else {
			next, err = b.tail(ctx, s.ID)
		}
	default:
		next, err = b.tail(ctx, s.ID)
	}
	if err != nil {
		return nil, err
	}
	next.updated = s.Time.Updated
	b.mu.Lock()
	b.snaps[s.ID] = next
	b.mu.Unlock()
	return next.msgs, nil
}

func (b *Backend) tail(ctx context.Context, sid string) (*snapshot, error) {
	for n := tailFrom; ; n *= 4 {
		ms, err := b.Messages(ctx, sid, n)
		if err != nil {
			return nil, err
		}
		if len(ms) < n {
			return &snapshot{msgs: ms, full: true}, nil
		}
		for _, m := range ms {
			if m.Info.Role == "user" && m.prompt() != "" {
				return &snapshot{msgs: ms}, nil
			}
		}
	}
}

func merge(old, tail []Message) ([]Message, bool) {
	if len(tail) == 0 {
		return old, true
	}
	for i := len(old) - 1; i >= 0; i-- {
		if old[i].Info.ID == tail[0].Info.ID {
			return append(old[:i:i], tail...), true
		}
	}
	return nil, false
}

func (b *Backend) Live(ctx context.Context, ids []string) (live []Live, gone []string) {
	type folder struct {
		busy   map[string]bool
		asks   map[string][]Ask
		branch string
	}
	dirs := map[string]*folder{}
	for _, id := range ids {
		s, err := b.Session(ctx, id)
		if errors.Is(err, ErrNotFound) {
			gone = append(gone, id)
			continue
		}
		b.reachable(err)
		if err != nil {
			continue
		}
		f := dirs[s.Directory]
		if f == nil {
			f = &folder{branch: b.Branch(ctx, s.Directory)}
			f.busy, _ = b.Busy(ctx, s.Directory)
			f.asks, _ = b.Asks(ctx, s.Directory)
			dirs[s.Directory] = f
		}
		ms, err := b.messages(ctx, s, false, f.busy[id])
		if err != nil {
			continue
		}
		t := Transcript(s, ms)
		t.Branch = f.branch
		live = append(live, Live{t, f.busy[id], f.asks[id]})
	}
	return live, gone
}

func (b *Backend) reachable(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if down := err != nil; down != b.down {
		b.down = down
		if down {
			log.Printf("opencode at %s: %v", b.URL, err)
		} else {
			log.Printf("opencode at %s is back", b.URL)
		}
	}
}

func (b *Backend) Transcripts(ctx context.Context, max int) []history.Transcript {
	list, _ := b.Sessions(ctx, max)
	out := make([]history.Transcript, 0, len(list))
	for _, s := range list {
		if s.Time.Archived != nil {
			continue
		}
		if ms, err := b.messages(ctx, s, false, false); err == nil {
			out = append(out, Transcript(s, ms))
		}
	}
	return out
}

func (b *Backend) Find(ctx context.Context, sid string) (history.Transcript, bool) {
	s, err := b.Session(ctx, sid)
	if err != nil {
		return history.Transcript{}, false
	}
	ms, err := b.messages(ctx, s, false, false)
	if err != nil {
		return history.Transcript{}, false
	}
	return Transcript(s, ms), true
}

func (b *Backend) All(ctx context.Context, sid string) ([]Message, error) {
	s, err := b.Session(ctx, sid)
	if err != nil {
		return nil, err
	}
	return b.messages(ctx, s, true, false)
}

func (b *Backend) Outputs(ctx context.Context, sid, home string) ([]outputs.File, []outputs.Link, map[string]time.Time, error) {
	if _, err := b.All(ctx, sid); err != nil {
		return nil, nil, nil, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	snap := b.snaps[sid]
	if snap.found == nil {
		files, links, seen := outputs.Collect(Steps(snap.msgs), home)
		snap.found = &found{files, links, seen}
	}
	return snap.found.files, snap.found.links, snap.found.seen, nil
}

func (b *Backend) Page(ctx context.Context, sid string) (history.Page, error) {
	ms, err := b.All(ctx, sid)
	if err != nil {
		return history.Page{}, err
	}
	return history.Page{Messages: Messages(ms), Size: int64(len(ms))}, nil
}

func (b *Backend) Reply(sid, id string) (string, error) {
	ms, err := b.All(context.Background(), sid)
	if err != nil {
		return "", err
	}
	if text, ok := Reply(ms, id); ok {
		return text, nil
	}
	return "", os.ErrNotExist
}

func (b *Backend) Dir(ctx context.Context, sid string) string {
	b.mu.Lock()
	dir := b.dirs[sid]
	b.mu.Unlock()
	if dir == "" {
		if s, err := b.Session(ctx, sid); err == nil {
			dir = s.Directory
		}
	}
	return dir
}

func (b *Backend) Attach(sid string) *exec.Cmd {
	cmd := exec.Command(b.Bin, "attach", b.URL, "--session", sid)
	if dir := b.Dir(context.Background(), sid); dir != "" {
		cmd.Args = append(cmd.Args, "--dir", dir)
	}
	return cmd
}

func (b *Backend) Send(ctx context.Context, sid string, p Prompt) error {
	if p.Model == "" {
		if t, ok := b.Find(ctx, sid); ok {
			p.Model = t.Model
		}
	}
	return b.Prompt(ctx, sid, b.Dir(ctx, sid), p)
}

func (b *Backend) Start(ctx context.Context, dir, title string, p Prompt) (string, error) {
	s, err := b.Create(ctx, dir, title)
	if err != nil {
		return "", err
	}
	b.mu.Lock()
	b.dirs[s.ID] = s.Directory
	b.mu.Unlock()
	if p.Text != "" || p.Brief != "" {
		err = b.Prompt(ctx, s.ID, s.Directory, p)
	}
	return s.ID, err
}

func (b *Backend) Respond(ctx context.Context, sid, id string, a Answer) error {
	return b.Answer(ctx, b.Dir(ctx, sid), id, a)
}

func (b *Backend) Stop(ctx context.Context, sid string) error {
	return b.Abort(ctx, sid, b.Dir(ctx, sid))
}

func (b *Backend) Root(ctx context.Context, sid string) bool {
	s, err := b.Session(ctx, sid)
	return err == nil && s.ParentID == ""
}
