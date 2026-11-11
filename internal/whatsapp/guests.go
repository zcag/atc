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
// fresh on every look, so adding someone takes effect at once. A line may end with what the guest is
// called ("anne 90555... Ayla"), which the call greets them by; name stays the label everything else uses.
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
	nums, _ := g.read()
	return nums
}

// Called is what each guest who has one is called, by name.
func (g *Guests) Called() map[string]string {
	_, called := g.read()
	return called
}

func (g *Guests) read() (nums, called map[string]string) {
	nums, called = map[string]string{}, map[string]string{}
	if g == nil || g.Path == "" {
		return
	}
	b, _ := os.ReadFile(g.Path)
	for _, l := range strings.Split(string(b), "\n") {
		if f := strings.Fields(l); len(f) >= 2 && !strings.HasPrefix(f[0], "#") {
			name := strings.ToLower(f[0])
			nums[name] = strings.TrimPrefix(f[1], "+")
			if len(f) > 2 {
				called[name] = strings.Join(f[2:], " ")
			}
		}
	}
	return
}

// Call sets what a guest is called; empty clears it.
func (g *Guests) Call(name, called string) error {
	name, called = strings.ToLower(strings.TrimSpace(name)), strings.Join(strings.Fields(called), " ")
	return g.editAll(func(nums, cs map[string]string) error {
		if _, ok := nums[name]; !ok {
			return fmt.Errorf("%s is not a guest", name)
		}
		if called == "" {
			delete(cs, name)
		} else {
			cs[name] = called
		}
		return nil
	})
}

func (g *Guests) Add(name, num string) error {
	name, num = strings.ToLower(strings.TrimSpace(name)), strings.TrimPrefix(strings.Join(strings.Fields(num), ""), "+")
	if !guestName.MatchString(name) {
		return fmt.Errorf("a guest's name is lowercase letters, digits, - or _: %q", name)
	}
	if name == "groups" {
		return fmt.Errorf("groups is where the groups' notes live in ~/guests; pick another name")
	}
	if !guestNum.MatchString(num) {
		return fmt.Errorf("a number is the full international number, digits only, with country code: %q", num)
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
	return g.editAll(func(nums, _ map[string]string) error { return f(nums) })
}

func (g *Guests) editAll(f func(nums, called map[string]string) error) error {
	if g == nil || g.Path == "" {
		return errors.New("no guest list on this machine")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	m, called := g.read()
	if err := f(m, called); err != nil {
		return err
	}
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	slices.Sort(names)
	var b strings.Builder
	b.WriteString("# atc's WhatsApp guests: name number [what they are called] (atc guest add|rm|call)\n")
	for _, n := range names {
		if c := called[n]; c != "" {
			fmt.Fprintf(&b, "%s %s %s\n", n, m[n], c)
		} else {
			fmt.Fprintf(&b, "%s %s\n", n, m[n])
		}
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
