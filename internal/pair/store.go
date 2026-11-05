// Package pair is how a new device gets its own revocable token: a one-time code shown on a device
// already logged in, claimed by the new one. Tokens are kept only as hashes; codes only in memory.
package pair

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	CodeLife     = 10 * time.Minute
	maxCodes     = 20
	seenEvery    = time.Minute
	maxNameRunes = 64
)

var ErrCode = errors.New("invalid or expired code")

type Device struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Created  time.Time `json:"created"`
	LastSeen time.Time `json:"lastSeen,omitzero"`
}

type record struct {
	Device
	Hash string `json:"hash"`
}

type pending struct {
	hash    string
	expires time.Time
}

type Store struct {
	path    string
	now     func() time.Time
	mu      sync.Mutex
	devices []record
	codes   []pending
	savedAt time.Time
	watches map[string]map[*func()]bool
}

// Open reads the devices file; an empty path keeps everything in memory.
func Open(path string) (*Store, error) {
	s := &Store{path: path, now: time.Now, watches: map[string]map[*func()]bool{}}
	if path == "" {
		return s, nil
	}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	return s, json.Unmarshal(b, &s.devices)
}

var b32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

func secret(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return b32.EncodeToString(b)
}

func hash(v string) string {
	h := sha256.Sum256([]byte(v))
	return hex.EncodeToString(h[:])
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// NewCode returns a code that Claim takes once within CodeLife.
func (s *Store) NewCode() (string, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	code, expires := secret(16), s.now().Add(CodeLife)
	s.prune()
	if len(s.codes) >= maxCodes {
		s.codes = s.codes[1:]
	}
	s.codes = append(s.codes, pending{hash(code), expires})
	return code, expires
}

func (s *Store) prune() {
	now := s.now()
	kept := s.codes[:0]
	for _, c := range s.codes {
		if now.Before(c.expires) {
			kept = append(kept, c)
		}
	}
	s.codes = kept
}

// Claim spends a code on a new device and returns its token, which exists nowhere after this.
func (s *Store) Claim(code, name string) (string, Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	want, at := hash(code), -1
	for i, c := range s.codes {
		if same(c.hash, want) {
			at = i
		}
	}
	if at < 0 {
		return "", Device{}, ErrCode
	}
	s.codes = append(s.codes[:at], s.codes[at+1:]...)
	token := secret(32)
	d := Device{ID: secret(8), Name: cleanName(name), Created: s.now()}
	s.devices = append(s.devices, record{d, hash(token)})
	return token, d, s.save()
}

func cleanName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name))
	if r := []rune(name); len(r) > maxNameRunes {
		name = string(r[:maxNameRunes])
	}
	if name == "" {
		return "unnamed device"
	}
	return name
}

// Check says which device a token belongs to and records that it was seen.
func (s *Store) Check(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	want := hash(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	at := -1
	for i := range s.devices {
		if same(s.devices[i].Hash, want) {
			at = i
		}
	}
	if at < 0 {
		return "", false
	}
	d := &s.devices[at]
	d.LastSeen = s.now()
	if d.LastSeen.Sub(s.savedAt) >= seenEvery {
		s.save()
	}
	return d.ID, true
}

func (s *Store) List() []Device {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Device, len(s.devices))
	for i, r := range s.devices {
		out[i] = r.Device
	}
	return out
}

// Revoke removes a device, so its token stops working, and ends what it has open right now.
func (s *Store) Revoke(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.devices {
		if r.ID != id {
			continue
		}
		s.devices = append(s.devices[:i], s.devices[i+1:]...)
		for stop := range s.watches[id] {
			(*stop)()
		}
		delete(s.watches, id)
		return true, s.save()
	}
	return false, nil
}

// Watch calls stop if the device is revoked, until the returned func is called; at once if it already was.
func (s *Store) Watch(id string, stop func()) (done func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !slices.ContainsFunc(s.devices, func(r record) bool { return r.ID == id }) {
		stop()
		return func() {}
	}
	if s.watches[id] == nil {
		s.watches[id] = map[*func()]bool{}
	}
	s.watches[id][&stop] = true
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.watches[id], &stop)
		if len(s.watches[id]) == 0 {
			delete(s.watches, id)
		}
	}
}

func (s *Store) save() error {
	s.savedAt = s.now()
	if s.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(s.devices, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Limiter counts attempts per address and overall in fixed windows.
type Limiter struct {
	Window       time.Duration
	PerAddr, All int
	now          func() time.Time
	mu           sync.Mutex
	start        time.Time
	total        int
	addrs        map[string]int
}

func (l *Limiter) Allow(addr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.now != nil {
		now = l.now()
	}
	if now.Sub(l.start) >= l.Window {
		l.start, l.total, l.addrs = now, 0, map[string]int{}
	}
	if l.total >= l.All || l.addrs[addr] >= l.PerAddr {
		return false
	}
	l.total++
	l.addrs[addr]++
	return true
}
