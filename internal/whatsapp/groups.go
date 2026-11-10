package whatsapp

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

type Group struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Members []Member `json:"participants"`
}

type Member struct {
	ID     string `json:"id"`
	Number string `json:"number"`
	Name   string `json:"name"`
}

// GroupEvent is OpenWA's group.join or group.leave: who came or went, and who did it.
type GroupEvent struct {
	GroupID        string   `json:"groupId"`
	ParticipantIDs []string `json:"participantIds"`
	ActorID        string   `json:"actorId"`
}

const groupTTL = 10 * time.Minute

type cachedGroup struct {
	g  Group
	at time.Time
}

type groupCache struct {
	mu       sync.Mutex
	m        map[string]cachedGroup
	self     string
	selfName string
	phones   map[string]string
}

// Groups is every group the account is in, without members.
func (c *Client) Groups(ctx context.Context) ([]Group, error) {
	var out []Group
	return out, c.do(ctx, "GET", "/groups", nil, &out)
}

// Group is one group with its members, cached for a few minutes; a join or leave forgets it.
func (c *Client) Group(ctx context.Context, id string) (Group, error) {
	c.groups.mu.Lock()
	x, ok := c.groups.m[id]
	c.groups.mu.Unlock()
	if ok && time.Since(x.at) < groupTTL {
		return x.g, nil
	}
	var g Group
	if err := c.do(ctx, "GET", "/groups/"+url.PathEscape(id), nil, &g); err != nil {
		return g, err
	}
	c.groups.mu.Lock()
	if c.groups.m == nil {
		c.groups.m = map[string]cachedGroup{}
	}
	c.groups.m[id] = cachedGroup{g, time.Now()}
	c.groups.mu.Unlock()
	return g, nil
}

func (c *Client) ForgetGroup(id string) {
	c.groups.mu.Lock()
	delete(c.groups.m, id)
	c.groups.mu.Unlock()
}

// Self is the account's own number.
func (c *Client) Self(ctx context.Context) (string, error) {
	c.groups.mu.Lock()
	self := c.groups.self
	c.groups.mu.Unlock()
	if self != "" {
		return self, nil
	}
	var s struct{ Phone, PushName string }
	if err := c.do(ctx, "GET", "", nil, &s); err != nil {
		return "", err
	}
	if s.Phone == "" {
		return "", errors.New("openwa: the session has no phone yet")
	}
	c.groups.mu.Lock()
	defer c.groups.mu.Unlock()
	c.groups.self, c.groups.selfName = strings.TrimPrefix(s.Phone, "+"), s.PushName
	return c.groups.self, nil
}

// SelfName is what the account calls itself on WhatsApp, once Self has asked.
func (c *Client) SelfName() string {
	c.groups.mu.Lock()
	defer c.groups.mu.Unlock()
	if c.groups.selfName == "" {
		return "+" + c.groups.self
	}
	return c.groups.selfName
}

// Member is the member a sender id belongs to.
func (g Group) Member(id string) (Member, bool) {
	i := slices.IndexFunc(g.Members, func(m Member) bool { return m.ID == id })
	if i < 0 {
		return Member{}, false
	}
	return g.Members[i], true
}

func (g Group) HasNumber(num string) bool {
	return num != "" && slices.ContainsFunc(g.Members, func(m Member) bool { return m.Number == num })
}

// Open is the group, when atc takes part in it: the owner is a member and it is not quiet.
func (c *Client) Open(ctx context.Context, id string) (Group, bool) {
	if !strings.HasSuffix(id, "@g.us") || c.Quiet.Has(id) {
		return Group{}, false
	}
	g, err := c.Group(ctx, id)
	return g, err == nil && g.HasNumber(c.Owner)
}

// FindGroup is the group named by id or name (any case).
func (c *Client) FindGroup(ctx context.Context, ref string) (Group, error) {
	if strings.HasSuffix(ref, "@g.us") {
		return Group{ID: ref}, nil
	}
	list, err := c.Groups(ctx)
	if err != nil {
		return Group{}, err
	}
	for _, g := range list {
		if strings.EqualFold(strings.TrimSpace(g.Name), strings.TrimSpace(ref)) {
			return g, nil
		}
	}
	return Group{}, errors.New("the account is in no group called " + ref)
}

// Quiet is the groups atc stays out of although the owner is in them (a channel the account posts
// alerts to, say): one group id per line, read fresh on every look.
type Quiet struct {
	Path string
	mu   sync.Mutex
}

func (q *Quiet) Has(id string) bool {
	return slices.Contains(q.list(), id)
}

func (q *Quiet) list() []string {
	if q == nil || q.Path == "" {
		return nil
	}
	b, _ := os.ReadFile(q.Path)
	var out []string
	for _, l := range strings.Split(string(b), "\n") {
		if f := strings.Fields(l); len(f) > 0 && !strings.HasPrefix(f[0], "#") {
			out = append(out, f[0])
		}
	}
	return out
}

// Set makes a group quiet, or takes it out of the list; name is written beside the id for a reader.
func (q *Quiet) Set(id, name string, quiet bool) error {
	if q == nil || q.Path == "" {
		return errors.New("no list of quiet groups on this machine")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	b, _ := os.ReadFile(q.Path)
	var keep []string
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if f := strings.Fields(l); len(f) > 0 && !strings.HasPrefix(f[0], "#") && f[0] != id {
			keep = append(keep, l)
		}
	}
	if quiet {
		keep = append(keep, strings.TrimSpace(id+" "+name))
	}
	text := "# WhatsApp groups atc stays out of: group id [name] (atc group quiet|on)\n" + strings.Join(keep, "\n") + "\n"
	os.MkdirAll(filepath.Dir(q.Path), 0o755)
	tmp := q.Path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, q.Path)
}
