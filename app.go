package main

import (
	"archive/tar"
	"bytes"
	"cmp"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const appReleases = "https://github.com/zcag/atc/releases/latest/download/"

const appHelp = `Usage: atc app update | characters

update      downloads the latest Android app and call characters from atc's releases into the folder this server
            offers them from (ATC_APP_DIR, by default ~/.local/share/atc/app), so phones can install it from /app/
            and update from it.
characters  downloads only the characters and rooms, about 10 MB.
`

func defaultAppDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "atc", "app")
}

func appDir() string { return cmp.Or(os.Getenv("ATC_APP_DIR"), defaultAppDir()) }

func appCmd(args []string) error {
	if len(args) != 1 || args[0] != "update" && args[0] != "characters" {
		fmt.Print(appHelp)
		os.Exit(2)
	}
	dir := appDir()
	if args[0] == "characters" {
		if err := fetchCharacters(appReleases, dir); err != nil {
			return err
		}
		fmt.Println("The characters and rooms are ready in", filepath.Join(dir, "personas"))
		return nil
	}
	name, err := fetchApp(appReleases, dir)
	if err != nil {
		return err
	}
	fmt.Println("Android app", name, "is ready in", dir)
	return nil
}

func fetchApp(base, dir string) (string, error) {
	c := &http.Client{Timeout: 5 * time.Minute}
	info, err := download(c, base+"version.json")
	if err != nil {
		return "", err
	}
	var v struct {
		VersionName string `json:"versionName"`
		SHA256      string `json:"sha256"`
		Personas    string `json:"personasSha256"`
	}
	if err := json.Unmarshal(info, &v); err != nil || v.SHA256 == "" {
		return "", fmt.Errorf("the release's version.json is not usable: %v", err)
	}
	apk, err := download(c, base+"atc.apk")
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(apk)
	if hex.EncodeToString(sum[:]) != v.SHA256 {
		return "", fmt.Errorf("the downloaded app does not match its checksum")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "atc.apk"), apk, 0o644); err != nil {
		return "", err
	}
	if v.Personas != "" {
		if err := fetchPersonas(c, base, dir, v.Personas); err != nil {
			return "", err
		}
	}
	return v.VersionName, os.WriteFile(filepath.Join(dir, "version.json"), info, 0o644)
}

// fetchCharacters takes the characters and rooms of the latest release without the app, which not everyone wants.
func fetchCharacters(base, dir string) error {
	c := &http.Client{Timeout: 5 * time.Minute}
	info, err := download(c, base+"version.json")
	if err != nil {
		return err
	}
	var v struct {
		Personas string `json:"personasSha256"`
	}
	if err := json.Unmarshal(info, &v); err != nil || v.Personas == "" {
		return fmt.Errorf("the release lists no characters: %v", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return fetchPersonas(c, base, dir, v.Personas)
}

// ensureCharacters fetches them only when this server has none yet: atc app update is what brings them up to date.
func ensureCharacters() error {
	dir := appDir()
	if _, err := os.Stat(filepath.Join(dir, "personas", "index.json")); err == nil {
		return nil
	}
	fmt.Println("Downloading the call characters and rooms, about 10 MB.")
	return fetchCharacters(appReleases, dir)
}

func fetchPersonas(c *http.Client, base, dir, want string) error {
	b, err := download(c, base+"personas.tar.gz")
	if err != nil {
		return err
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != want {
		return fmt.Errorf("the downloaded characters do not match their checksum")
	}
	return untarPersonas(b, filepath.Join(dir, "personas"))
}

func untarPersonas(b []byte, dir string) error {
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(h.Name)
		if h.Typeflag != tar.TypeReg {
			continue
		}
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
			return fmt.Errorf("the characters archive names a path outside its folder: %s", h.Name)
		}
		to := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			return err
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			return err
		}
		if err := os.WriteFile(to, data, 0o644); err != nil {
			return err
		}
	}
}

func download(c *http.Client, url string) ([]byte, error) {
	res, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, res.Status)
	}
	return io.ReadAll(res.Body)
}
