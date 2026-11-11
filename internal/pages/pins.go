package pages

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Pinned owns the pages that belong to no session: each is a folder under the pins dir that
// atc never deletes. Unpinning moves the folder aside; only deleting an unpinned page removes it.
const Pinned = "+pinned"

var ErrNoPins = errors.New("pinned pages are off on this atc")

func (st *Store) PinAt(dir string) { st.pins = dir }

func (st *Store) unpinned() string { return filepath.Join(filepath.Dir(st.pins), "unpinned") }

func (st *Store) pinList() []Page {
	if st.pins == "" {
		return nil
	}
	var list []Page
	for _, dir := range []string{st.pins, st.unpinned()} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if !e.IsDir() || e.Name()[0] == '.' {
				continue
			}
			target, err := Target(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			list = append(list, Page{Session: Pinned, Name: e.Name(), Path: target, Unpinned: dir != st.pins})
		}
	}
	return list
}

// PinOf names the pinned page a path is in, or gives "" for a path outside them.
func (st *Store) PinOf(path string) string {
	for _, dir := range []string{st.pins, st.unpinned()} {
		if rel, err := filepath.Rel(dir, path); st.pins != "" && err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			return strings.Split(rel, string(filepath.Separator))[0]
		}
	}
	return ""
}

func (st *Store) pinName(name string) (string, error) {
	if st.pins == "" {
		return "", ErrNoPins
	}
	if name == "" || Slug(name) != name {
		return "", fmt.Errorf("a pinned page's name is lowercase letters, digits and dashes, like %q", Slug(name))
	}
	return name, nil
}

// NewPin makes the folder a pinned page lives in; an existing pin's folder comes back as it is.
func (st *Store) NewPin(name string) (dir string, created bool, err error) {
	if name, err = st.pinName(name); err != nil {
		return "", false, err
	}
	dir = filepath.Join(st.pins, name)
	if exists(dir) {
		return dir, false, nil
	}
	if exists(filepath.Join(st.unpinned(), name)) {
		return "", false, fmt.Errorf("%s is unpinned; pin it again (atc pages pin %s) or pick another name", name, name)
	}
	return dir, true, os.MkdirAll(dir, 0o755)
}

func (st *Store) SetPinned(name string, on bool) error {
	name, err := st.pinName(name)
	if err != nil {
		return err
	}
	from, to := filepath.Join(st.unpinned(), name), filepath.Join(st.pins, name)
	if !on {
		from, to = to, from
	}
	if !exists(from) {
		if exists(to) {
			return nil
		}
		return os.ErrNotExist
	}
	if exists(to) {
		return fmt.Errorf("both pinned and unpinned hold %s", name)
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	return os.Rename(from, to)
}

// DeletePin removes an unpinned page for good; a pinned one has to be unpinned first.
func (st *Store) DeletePin(name string) error {
	name, err := st.pinName(name)
	if err != nil {
		return err
	}
	if exists(filepath.Join(st.pins, name)) {
		return fmt.Errorf("%s is pinned; unpin it first", name)
	}
	dir := filepath.Join(st.unpinned(), name)
	if !exists(dir) {
		return os.ErrNotExist
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.s.State, Pinned+"/"+name)
	return st.save()
}
