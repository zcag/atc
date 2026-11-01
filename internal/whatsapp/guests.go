package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// Guests is the list of other people atc listens to, one "name number" per line in a file read
// fresh on every look, so adding someone takes effect at once.
type Guests struct {
	Path string
	mu   sync.Mutex
}

var (
	guestName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
	guestNum  = regexp.MustCompile(`^[1-9][0-9]{7,14}$`)
)

// List is every guest by name, with their number (no +).
func (g *Guests) List() map[string]string {
	out := map[string]string{}
	if g == nil || g.Path == "" {
		return out
	}
	b, _ := os.ReadFile(g.Path)
	for _, l := range strings.Split(string(b), "\n") {
		if f := strings.Fields(l); len(f) >= 2 && !strings.HasPrefix(f[0], "#") {
			out[strings.ToLower(f[0])] = strings.TrimPrefix(f[1], "+")
		}
	}
	return out
}

func (g *Guests) Add(name, num string) error {
	name, num = strings.ToLower(strings.TrimSpace(name)), strings.TrimPrefix(strings.Join(strings.Fields(num), ""), "+")
	if !guestName.MatchString(name) {
		return fmt.Errorf("a guest's name is lowercase letters, digits, - or _: %q", name)
	}
	if !guestNum.MatchString(num) {
		return fmt.Errorf("a number is the full international number, digits only (905321234567): %q", num)
	}
	return g.edit(func(m map[string]string) error {
		for n, x := range m {
			if x == num && n != name {
				return fmt.Errorf("%s is already a guest as %s", num, n)
			}
		}
		m[name] = num
		return nil
	})
}

func (g *Guests) Remove(name string) error {
	return g.edit(func(m map[string]string) error {
		if _, ok := m[strings.ToLower(name)]; !ok {
			return fmt.Errorf("%s is not a guest", name)
		}
		delete(m, strings.ToLower(name))
		return nil
	})
}

func (g *Guests) edit(f func(map[string]string) error) error {
	if g == nil || g.Path == "" {
		return errors.New("no guest list on this machine")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	m := g.List()
	if err := f(m); err != nil {
		return err
	}
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	slices.Sort(names)
	var b strings.Builder
	b.WriteString("# atc's WhatsApp guests: name number (atc guest add|rm)\n")
	for _, n := range names {
		fmt.Fprintf(&b, "%s %s\n", n, m[n])
	}
	os.MkdirAll(filepath.Dir(g.Path), 0o755)
	tmp := g.Path + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, g.Path)
}

// GuestChat is the chat of the guest with this name.
func (c *Client) GuestChat(name string) (string, bool) {
	num, ok := c.Guests.List()[strings.ToLower(name)]
	return num + "@c.us", ok
}

// Guest is the name of the guest a sender id belongs to, "" for none.
func (c *Client) Guest(ctx context.Context, from, senderPhone string) string {
	list := c.Guests.List()
	if len(list) == 0 {
		return ""
	}
	num := strings.TrimSuffix(from, "@c.us")
	if strings.HasSuffix(from, "@lid") {
		num = strings.TrimPrefix(senderPhone, "+")
		if num == "" {
			num, _ = c.Phone(ctx, from)
		}
	}
	for name, n := range list {
		if num != "" && n == num {
			return name
		}
	}
	return ""
}
