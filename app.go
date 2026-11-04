package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const appReleases = "https://github.com/zcag/atc/releases/latest/download/"

const appHelp = `Usage: atc app update

Downloads the latest Android app from atc's releases into the folder this server offers it from
(ATC_APP_DIR, by default ~/.local/share/atc/app), so phones can install it from /app/ and update from it.
`

func defaultAppDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "atc", "app")
}

func appCmd(args []string) error {
	if len(args) != 1 || args[0] != "update" {
		fmt.Print(appHelp)
		os.Exit(2)
	}
	dir := os.Getenv("ATC_APP_DIR")
	if dir == "" {
		dir = defaultAppDir()
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
	return v.VersionName, os.WriteFile(filepath.Join(dir, "version.json"), info, 0o644)
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
